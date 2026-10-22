/**
 * A chat can work in several folders. The client declares them (createSession's workingDirectories, then
 * session/workingDirectorySet|Removed|Replaced); the backend hands the declared set to the host that runs pi, which
 * checks it with its path guard before anything is writable. The first folder is the immutable primary.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	ActionType,
	type AgentInfo,
	type SessionState,
	type StateAction,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { sessionUri } from "../src/core/channels.ts";
import { pathToFileUri } from "../src/core/uri.ts";
import { buildAgentInfo } from "../src/pi/models.ts";
import type { LiveSession } from "../src/pi/session-registry.ts";
import { SupervisorBackend } from "../src/supervisor/supervisor-backend.ts";
import type { SupervisorSocket } from "../src/supervisor/supervisor-client.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";

type Envelope = { action: StateAction; origin?: { clientSeq?: number }; rejectionReason?: string };

async function verdict(subscription: Subscription, clientSeq: number): Promise<Envelope> {
	const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 2_000).unref?.());
	const next = (async () => {
		while (true) {
			const event = await subscription.next();
			if (event.done) throw new Error("subscription ended early");
			if (event.value.type === "action") {
				const envelope = event.value.params as Envelope;
				if (envelope.origin?.clientSeq === clientSeq) return envelope;
			}
		}
	})();
	return Promise.race([next, timer]);
}

it("advertises several working directories with an immutable primary", () => {
	const info: AgentInfo = buildAgentInfo([]);
	assert.deepEqual(info.capabilities?.multipleWorkingDirectories, { immutablePrimary: true });
	assert.equal(info.capabilities?.multipleChats, undefined);
});

describe("session working directories", () => {
	let harness: Harness;
	let client: AhpClient;
	let a: string;
	let b: string;
	let c: string;

	before(async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ahp-folders-"));
		[a, b, c] = ["a", "b", "c"].map((name) => join(root, name)) as [string, string, string];
		harness = await startHarness({ sessions: true, workingDirectory: a });
		client = await harness.connect();
		await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	});

	after(async () => {
		await harness.dispose();
		rmSync(join(a, ".."), { recursive: true, force: true });
	});

	async function created(workingDirectories: string[]): Promise<{ channel: string; id: string }> {
		const id = randomUUID();
		const channel = sessionUri(id);
		await client.request("createSession", { channel, workingDirectories: workingDirectories.map(pathToFileUri) });
		await client.subscribe(channel);
		return { channel, id };
	}

	async function dispatch(channel: string, action: StateAction): Promise<Envelope> {
		const events = client.attachSubscription(channel);
		const sent = client.dispatch(channel, action);
		return verdict(events, sent.clientSeq);
	}

	function folders(channel: string): string[] {
		return ((harness.host.store.get(channel) as SessionState).workingDirectories ?? []) as string[];
	}

	it("keeps every folder the client created the session with, the first as primary", async () => {
		const { channel, id } = await created([a, b]);
		assert.deepEqual(folders(channel), [pathToFileUri(a), pathToFileUri(b)]);
		const live = harness.sessions?.get(channel);
		assert.equal(live?.workingDirectory, a);
		assert.deepEqual(live?.folders, [a, b]);
		assert.equal(live?.createdHere, true);
		assert.ok(id);
	});

	it("applies a folder added or removed later and tracks it for the host that runs pi", async () => {
		const { channel } = await created([a]);
		const added = await dispatch(channel, { type: ActionType.SessionWorkingDirectorySet, directory: pathToFileUri(b) });
		assert.equal(added.rejectionReason, undefined);
		assert.deepEqual(harness.sessions?.get(channel)?.folders, [a, b]);
		const replaced = await dispatch(channel, {
			type: ActionType.SessionWorkingDirectoryReplaced,
			directory: pathToFileUri(b),
			replacement: pathToFileUri(c),
		});
		assert.equal(replaced.rejectionReason, undefined);
		assert.deepEqual(harness.sessions?.get(channel)?.folders, [a, c]);
		const removed = await dispatch(channel, { type: ActionType.SessionWorkingDirectoryRemoved, directory: pathToFileUri(c) });
		assert.equal(removed.rejectionReason, undefined);
		assert.deepEqual(harness.sessions?.get(channel)?.folders, [a]);
	});

	it("refuses to remove or replace the primary, and what is not a file: URI", async () => {
		const { channel } = await created([a, b]);
		const before = structuredClone(folders(channel));
		for (const [action, reason] of [
			[{ type: ActionType.SessionWorkingDirectoryRemoved, directory: pathToFileUri(a) }, /cannot be removed/],
			[
				{ type: ActionType.SessionWorkingDirectoryReplaced, directory: pathToFileUri(a), replacement: pathToFileUri(c) },
				/cannot be replaced/,
			],
			[{ type: ActionType.SessionWorkingDirectorySet, directory: "https://example.invalid/x" }, /file: URI/],
			[{ type: ActionType.SessionWorkingDirectorySet, directory: "file://remote/host/x" }, /file: URI/],
		] as [StateAction, RegExp][]) {
			const verdictOf = await dispatch(channel, action);
			assert.match(verdictOf.rejectionReason ?? "", reason);
		}
		assert.deepEqual(folders(channel), before);
		assert.deepEqual(harness.sessions?.get(channel)?.folders, [a, b]);
	});
});

describe("the supervisor backend hands the folders to the host that runs pi", () => {
	function recording(replies: (op: string, fields: Record<string, unknown>) => Record<string, unknown>) {
		const calls: { op: string; fields: Record<string, unknown> }[] = [];
		const socket = {
			onMessage: () => () => {},
			request: async (op: string, fields: Record<string, unknown> = {}) => {
				calls.push({ op, fields });
				return replies(op, fields);
			},
		};
		return { calls, socket: socket as unknown as SupervisorSocket };
	}

	function liveSession(extra: Partial<LiveSession> = {}): LiveSession {
		return { sessionId: "11111111-2222-4333-8444-555555555555", workingDirectory: "/work/a", ...extra } as unknown as LiveSession;
	}

	it("sends the declared folders (create for a new chat) before it attaches, and only when they change", async () => {
		const { calls, socket } = recording((op, fields) => (op === "folders" ? { folders: fields.folders } : { state: {} }));
		const session = liveSession({ folders: ["/work/a", "/work/b"], createdHere: true });
		const backend = new SupervisorBackend(session, socket, () => []);
		await backend.ensure();
		assert.deepEqual(
			calls.map((call) => call.op),
			["folders", "attach"],
		);
		assert.deepEqual(calls[0]?.fields, { session: session.sessionId, folders: ["/work/a", "/work/b"], create: true });
		await backend.ensure();
		assert.equal(calls.length, 2, "nothing changed: nothing is sent");
		session.folders = ["/work/a", "/work/b", "/work/c"];
		await backend.ensure();
		assert.deepEqual(calls.slice(2).map((call) => call.op), ["folders"]);
	});

	it("sends nothing for a session loaded from disk that no client changed", async () => {
		const { calls, socket } = recording(() => ({ state: {} }));
		const backend = new SupervisorBackend(liveSession(), socket, () => []);
		await backend.ensure();
		assert.deepEqual(calls.map((call) => call.op), ["attach"]);
	});

	it("a refusal is the turn's error and the declared set goes back to what was accepted", async () => {
		let refuse = false;
		const { socket } = recording((op, fields) => {
			if (op === "folders" && refuse) throw new Error("refusing /home/u/.ssh: it is, holds or contains /home/u/.ssh");
			return op === "folders" ? { folders: fields.folders } : { state: {} };
		});
		const reverted: (readonly string[])[] = [];
		const session = liveSession({ folders: ["/work/a"], createdHere: true, revertFolders: (accepted) => reverted.push(accepted) });
		const backend = new SupervisorBackend(session, socket, () => []);
		await backend.ensure();
		refuse = true;
		session.folders = ["/work/a", "/home/u/.ssh"];
		await assert.rejects(backend.ensure(), /refusing \/home\/u\/\.ssh/);
		assert.deepEqual(reverted, [["/work/a"]]);
	});
});
