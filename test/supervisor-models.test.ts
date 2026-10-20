/** A supervised host learns its models from a pi child (listModels, PiHost.setModels), not from pi's files. */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { type AgentInfo, type ChatState, SUPPORTED_PROTOCOL_VERSIONS } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { serveWebSocket } from "../src/transport/websocket.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import type { LiveSession } from "../src/pi/session-registry.ts";
import { listModels, SupervisorBackend } from "../src/supervisor/supervisor-backend.ts";
import type { SupervisorSocket } from "../src/supervisor/supervisor-client.ts";
import { must } from "./support/assertions.ts";
import { eventually } from "./support/async.ts";
import { persistentSessionStorage } from "./support/session-storage.ts";

function model(provider: string, id: string): Model<never> {
	return {
		id,
		name: id.toUpperCase(),
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as unknown as Model<never>;
}

async function emptyHost() {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-supervisor-models-"));
	const metadata = new MetadataStore(join(root, "ahp"));
	return createPiHost({
		serverInfo: { name: "pi-ahp", version: "test" },
		workingDirectory: root,
		modelRuntime: { getAvailable: async () => [] },
		sessionStorage: persistentSessionStorage(root, metadata),
		metadata,
		createBackend: () => ({ subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {} }),
	});
}

const advertised = (built: Awaited<ReturnType<typeof emptyHost>>): string[] =>
	((built.host.store.get(ROOT_CHANNEL) as { agents: AgentInfo[] }).agents[0]?.models ?? []).map((m) => m.id);

it("setModels replaces the advertised list and publishes it once per change", async () => {
	const built = await emptyHost();
	assert.deepEqual(advertised(built), [], "starts empty");
	const actions: string[] = [];
	built.host.onServerAction?.((_channel: string, action: { type: string }) => actions.push(action.type));

	built.setModels([model("spark", "flash"), model("spark", "pro")]);
	assert.deepEqual(advertised(built), ["spark/flash", "spark/pro"]);
	assert.equal(built.models().length, 2);

	const before = actions.length;
	built.setModels([model("spark", "flash"), model("spark", "pro")]);
	assert.equal(actions.length, before, "an identical list is not published again");

	built.setModels([model("spark", "flash")]);
	assert.deepEqual(advertised(built), ["spark/flash"]);
});

it("a new session starts on the model the child runs, when the host was told", async (t) => {
	const built = await emptyHost();
	built.setModels([model("spark", "flash"), model("spark", "pro")], { provider: "spark", id: "pro", thinkingLevel: "high" });
	const server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
	t.after(() => server.close());
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	t.after(() => client.shutdown());
	await client.initialize({ clientId: "supervisor-models", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	const id = randomUUID();
	await client.request("createSession", { channel: sessionUri(id) });
	await eventually("the draft names the model", () => (built.host.store.get(chatUri(id)) as ChatState | undefined)?.draft?.model !== undefined);
	const draft = must((built.host.store.get(chatUri(id)) as ChatState).draft?.model);
	assert.equal(draft.id, "spark/pro");
	assert.deepEqual(draft.config, { thinkingLevel: "high" });
});

it("a handshake waits for `ready`, and then sees the models told meanwhile", async (t) => {
	let open!: () => void;
	const ready = new Promise<void>((resolveReady) => {
		open = resolveReady;
	});
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-supervisor-ready-"));
	const metadata = new MetadataStore(join(root, "ahp"));
	const built = await createPiHost({
		ready,
		serverInfo: { name: "pi-ahp", version: "test" },
		workingDirectory: root,
		modelRuntime: { getAvailable: async () => [] },
		sessionStorage: persistentSessionStorage(root, metadata),
		metadata,
		createBackend: () => ({ subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {} }),
	});
	const server = await serveWebSocket(built.host, { host: "127.0.0.1", port: 0 });
	t.after(() => server.close());
	const client = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${server.port}`));
	client.connect();
	t.after(() => client.shutdown());
	let answered = false;
	const handshake = client.initialize({ clientId: "supervisor-ready", protocolVersions: SUPPORTED_PROTOCOL_VERSIONS, initialSubscriptions: [ROOT_CHANNEL] }).then((result) => {
		answered = true;
		return result;
	});
	await new Promise((resolveWait) => setTimeout(resolveWait, 200));
	assert.equal(answered, false, "the handshake is held while the host is not ready");
	built.setModels([model("spark", "flash")]);
	open();
	const result = await handshake;
	const root0 = result.snapshots.find((s) => s.resource === ROOT_CHANNEL)?.state as { agents: AgentInfo[] } | undefined;
	assert.deepEqual(root0?.agents[0]?.models.map((m) => m.id), ["spark/flash"]);
});

function fakeSocket(answers: Record<string, Record<string, unknown>>): { socket: SupervisorSocket; calls: string[] } {
	const calls: string[] = [];
	const socket = {
		onMessage: () => () => {},
		request: async (op: string, fields: { command?: { type?: string } } = {}) => {
			const key = op === "call" ? `call:${fields.command?.type}` : op;
			calls.push(key);
			const answer = answers[key];
			if (!answer) throw new Error(`unexpected ${key}`);
			return answer;
		},
	};
	return { socket: socket as unknown as SupervisorSocket, calls };
}

const session = { sessionId: "11111111-2222-4333-8444-555555555555", workingDirectory: "/work" } as unknown as LiveSession;

it("listModels returns what the pi child reports", async () => {
	const { socket, calls } = fakeSocket({
		"call:get_available_models": { response: { success: true, data: { models: [model("spark", "flash"), model("spark", "pro")] } } },
	});
	const list = await listModels(socket, "s1");
	assert.deepEqual(calls, ["call:get_available_models"]);
	assert.deepEqual(
		list.map((m) => m.id),
		["flash", "pro"],
	);
});

it("a child that cannot list its models is an error, not an empty list", async () => {
	const { socket } = fakeSocket({ "call:get_available_models": { response: { success: false, error: "no registry" } } });
	await assert.rejects(listModels(socket, "s1"), /pi did not list its models: no registry/);
});

it("attaching a session selects the model its child runs", async () => {
	const { socket } = fakeSocket({
		attach: { state: { model: { provider: "spark", id: "pro" }, thinkingLevel: "high" } },
	});
	const backend = new SupervisorBackend(session, socket, () => [model("spark", "flash"), model("spark", "pro")]);
	await backend.ensure();
	assert.deepEqual(must(backend.currentSelection()), { id: "spark/pro", config: { thinkingLevel: "high" } });
});
