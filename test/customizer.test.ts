/**
 * Agents and customizations are the host's to define: a `SessionCustomizer` says which agents a client may name in
 * `Message.agent`, which mode each message runs in, and what a toggle does. Without one the host refuses both, as the
 * protocol allows.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type AgentSelection,
	type ChatState,
	type Customization,
	CustomizationEnablementKind,
	MessageKind,
	PendingMessageKind,
	type StateAction,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import type { PiBackend } from "../src/pi/chat-driver.ts";
import type { LiveSession, SessionCustomizer, SessionCustomizerContext } from "../src/pi/session-registry.ts";
import { type Harness, nextClientId, startHarness } from "./harness.ts";
import { eventually } from "./support/async.ts";

const REVIEW = "agent:/review";

class FakeCustomizer implements SessionCustomizer {
	readonly defaultMode = "main";
	readonly actions: StateAction[] = [];
	readonly sessions: string[] = [];

	rootCustomizations(): Customization[] {
		return [];
	}

	modeOf(agent: AgentSelection | undefined): string {
		if (agent === undefined) return this.defaultMode;
		if (agent.uri === REVIEW) return "review";
		throw new Error(`unknown agent ${agent.uri}`);
	}

	agentRejection(agent: AgentSelection): string | undefined {
		try {
			this.modeOf(agent);
			return undefined;
		} catch {
			return `Unknown agent ${agent.uri}`;
		}
	}

	actionRejection(action: StateAction): string | undefined {
		return action.type === ActionType.SessionMcpServerBackgroundRequested ? "nothing to background" : undefined;
	}

	onAction(_context: SessionCustomizerContext, action: StateAction): void {
		this.actions.push(action);
	}

	onSession(context: SessionCustomizerContext): void {
		this.sessions.push(context.session.sessionId);
	}
}

/** Records the mode of the session each prompt started in, and keeps the turn open until the test finishes it. */
class RecordingBackend implements PiBackend {
	readonly modes: (string | undefined)[] = [];
	readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
	#release: (() => void) | undefined;
	readonly session: LiveSession;

	constructor(session: LiveSession) {
		this.session = session;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt(): Promise<void> {
		this.modes.push(this.session.mode);
		await new Promise<void>((resolve) => {
			this.#release = resolve;
		});
	}

	async steer(): Promise<void> {}
	async abort(): Promise<void> {
		this.finish();
	}

	finish(): void {
		for (const event of [{ type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled" }]) {
			for (const listener of this.#listeners) listener(event as unknown as AgentSessionEvent);
		}
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}

type Envelope = { rejectionReason?: string; origin?: { clientSeq?: number } };

async function rejectionOf(client: AhpClient, channel: string, action: StateAction): Promise<string | undefined> {
	const events: Subscription = client.attachSubscription(channel);
	const { clientSeq } = client.dispatch(channel, action);
	const give = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for an action")), 2_000).unref());
	const next = (async () => {
		for (;;) {
			const event = await events.next();
			if (event.done) throw new Error("subscription ended early");
			if (event.value.type !== "action") continue;
			const envelope = event.value.params as Envelope;
			if (envelope.origin?.clientSeq === clientSeq) return envelope.rejectionReason;
		}
	})();
	return Promise.race([next, give]);
}

function user(text: string, agentUri?: string) {
	return { text, origin: { kind: MessageKind.User }, ...(agentUri ? { agent: { uri: agentUri } } : {}) };
}

interface Fixture {
	readonly harness: Harness;
	readonly client: AhpClient;
	readonly backends: Map<string, RecordingBackend>;
	newSession(): Promise<{ id: string; session: string; chat: string }>;
	close(): Promise<void>;
}

async function startFixture(customizer?: SessionCustomizer): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-customizer-"));
	const backends = new Map<string, RecordingBackend>();
	const harness = await startHarness({
		sessions: true,
		workingDirectory: root,
		...(customizer ? { customizer } : {}),
		createBackend: (session) => {
			const backend = new RecordingBackend(session);
			backends.set(session.sessionId, backend);
			return backend;
		},
	});
	const client = await harness.connect();
	await client.initialize({ clientId: nextClientId(), protocolVersions: SUPPORTED_PROTOCOL_VERSIONS });
	return {
		harness,
		client,
		backends,
		async newSession() {
			const id = randomUUID();
			const session = sessionUri(id);
			const chat = chatUri(id);
			await client.request("createSession", { channel: session });
			await client.subscribe(session);
			await client.subscribe(chat);
			return { id, session, chat };
		},
		async close() {
			await harness.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("a host without a customizer", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture();
	});
	after(async () => {
		await fixture.close();
	});

	it("refuses a message that names an agent, and a customization toggle", async () => {
		const { chat, session } = await fixture.newSession();
		const reason = await rejectionOf(fixture.client, chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t1",
			startedAt: new Date().toISOString(),
			message: user("hello", REVIEW),
		} as StateAction);
		assert.match(reason ?? "", /does not support custom agents/);
		const toggled = await rejectionOf(fixture.client, session, {
			type: ActionType.SessionCustomizationToggled,
			id: "any",
			enablement: [{ kind: CustomizationEnablementKind.Session, enabled: false }],
		} as StateAction);
		assert.ok(toggled, "a toggle has nothing to act on");
	});
});

describe("a host with a customizer", () => {
	let fixture: Fixture;
	let customizer: FakeCustomizer;
	before(async () => {
		customizer = new FakeCustomizer();
		fixture = await startFixture(customizer);
	});
	after(async () => {
		await fixture.close();
	});

	async function startTurn(chat: string, id: string, turn: string, agentUri?: string): Promise<void> {
		const before = fixture.backends.get(id)?.modes.length ?? 0;
		fixture.client.dispatch(chat, {
			type: ActionType.ChatTurnStarted,
			turnId: turn,
			startedAt: new Date().toISOString(),
			message: user(turn, agentUri),
		} as StateAction);
		await eventually(`the backend to get ${turn}`, () => (fixture.backends.get(id)?.modes.length ?? 0) > before);
	}

	async function end(chat: string, id: string): Promise<void> {
		fixture.backends.get(id)?.finish();
		await eventually("the turn to end", () => (fixture.harness.host.store.get(chat) as ChatState).activeTurn === undefined);
	}

	it("tells the customizer about each session", async () => {
		const { id } = await fixture.newSession();
		await eventually("the session to be announced", () => customizer.sessions.includes(id));
	});

	it("runs a message in the mode of its agent, the default mode when it names none, and refuses an unknown agent", async () => {
		const { id, chat } = await fixture.newSession();
		await startTurn(chat, id, "t1", REVIEW);
		await end(chat, id);
		await startTurn(chat, id, "t2");
		await end(chat, id);
		assert.deepEqual(fixture.backends.get(id)?.modes, ["review", "main"]);

		const reason = await rejectionOf(fixture.client, chat, {
			type: ActionType.ChatTurnStarted,
			turnId: "t3",
			startedAt: new Date().toISOString(),
			message: user("x", "agent:/elsewhere"),
		} as StateAction);
		assert.match(reason ?? "", /Unknown agent/);
	});

	it("refuses to queue a message in another mode than the running turn", async () => {
		const { id, chat } = await fixture.newSession();
		await startTurn(chat, id, "t1");
		const reason = await rejectionOf(fixture.client, chat, {
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id: "q1",
			message: user("later", REVIEW),
		} as StateAction);
		assert.match(reason ?? "", /mode of the running turn/);
		await end(chat, id);
	});

	it("lets a message queued on an idle chat pick its mode", async () => {
		const { id, chat } = await fixture.newSession();
		const queue = async (text: string, agentUri?: string): Promise<void> => {
			const before = fixture.backends.get(id)?.modes.length ?? 0;
			fixture.client.dispatch(chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: randomUUID(),
				message: user(text, agentUri),
			} as StateAction);
			await eventually(`the backend to get ${text}`, () => (fixture.backends.get(id)?.modes.length ?? 0) > before);
			await end(chat, id);
		};
		await queue("q-review", REVIEW);
		await queue("q-main");
		assert.deepEqual(fixture.backends.get(id)?.modes, ["review", "main"]);
	});

	it("hands accepted customization actions to the customizer and asks it before refusing", async () => {
		const { session } = await fixture.newSession();
		const toggle = {
			type: ActionType.SessionCustomizationToggled,
			id: "thing",
			enablement: [{ kind: CustomizationEnablementKind.Session, enabled: false }],
		} as StateAction;
		fixture.client.dispatch(session, toggle);
		await eventually("the customizer to get the toggle", () => customizer.actions.some((a) => a.type === ActionType.SessionCustomizationToggled));
		assert.match(
			(await rejectionOf(fixture.client, session, { type: ActionType.SessionMcpServerBackgroundRequested, id: "thing" } as StateAction)) ?? "",
			/nothing to background/,
		);
	});
});
