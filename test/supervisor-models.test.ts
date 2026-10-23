/**
 * A supervised host discovers its models in process, from pi's files, like an embedded host: listing runs no `apiKey`
 * command (the key is read by the pi child per request), and a session selects the model its child runs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentInfo, ChatState } from "@microsoft/agent-host-protocol";
import { chatUri, ROOT_CHANNEL, sessionUri } from "../src/core/channels.ts";
import { createPiHost } from "../src/host/pi-host.ts";
import { MetadataStore } from "../src/pi/metadata-store.ts";
import type { LiveSession } from "../src/pi/session-registry.ts";
import { SupervisorBackend } from "../src/supervisor/supervisor-backend.ts";
import type { SupervisorSocket } from "../src/supervisor/supervisor-client.ts";
import { must } from "./support/assertions.ts";
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

it("lists the models of models.json without running the apiKey command, and starts on the settings' default", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ahp-supervisor-models-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	const marker = join(root, "key-command-ran");
	mkdirSync(workspace);
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				acme: {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					apiKey: `!touch ${marker}; echo key`,
					models: [
						{ id: "flash", name: "Flash", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 },
						{ id: "pro", name: "Pro", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 },
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "acme", defaultModel: "pro", defaultThinkingLevel: "high" }));

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const metadata = new MetadataStore(join(root, "ahp"));
		const built = await createPiHost({
			serverInfo: { name: "pi-ahp", version: "test" },
			workingDirectory: workspace,
			sessionStorage: persistentSessionStorage(join(agentDir, "sessions"), metadata),
			metadata,
			createBackend: () => ({ subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {} }),
		});
		const advertised = ((built.host.store.get(ROOT_CHANNEL) as { agents: AgentInfo[] }).agents[0]?.models ?? []).map((m) => m.id);
		assert.deepEqual(advertised.sort(), ["acme/flash", "acme/pro"]);
		assert.equal(existsSync(marker), false, "listing must not run the apiKey command");

		const id = "default-selection";
		await built.sessions.create({ channel: sessionUri(id) });
		assert.deepEqual((built.host.store.get(chatUri(id)) as ChatState).draft?.model, { id: "acme/pro", config: { thinkingLevel: "high" } });
		await built.sessions.dispose(sessionUri(id));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

function fakeSocket(answers: Record<string, Record<string, unknown>>): SupervisorSocket {
	const socket = {
		onMessage: () => () => {},
		request: async (op: string) => {
			const answer = answers[op];
			if (!answer) throw new Error(`unexpected ${op}`);
			return answer;
		},
	};
	return socket as unknown as SupervisorSocket;
}

const session = { sessionId: "11111111-2222-4333-8444-555555555555", workingDirectory: "/work" } as unknown as LiveSession;

it("attaching a session selects the model its child runs", async () => {
	const socket = fakeSocket({
		attach: { state: { model: { provider: "acme", id: "pro" }, thinkingLevel: "high" } },
	});
	const backend = new SupervisorBackend(session, socket, () => [model("acme", "flash"), model("acme", "pro")]);
	await backend.ensure();
	assert.deepEqual(must(backend.currentSelection()), { id: "acme/pro", config: { thinkingLevel: "high" } });
});

it("follows the effort pi reports, and takes the selection a pick resulted in from pi's own state", async () => {
	let push: ((message: Record<string, unknown>) => void) | undefined;
	const calls: string[] = [];
	let state = { model: { provider: "acme", id: "pro" }, thinkingLevel: "high" };
	const socket = {
		onMessage: (listener: (message: Record<string, unknown>) => void) => ((push = listener), () => {}),
		request: async (op: string, fields: Record<string, unknown> = {}) => {
			if (op === "attach") return { state };
			const command = fields.command as { type: string; provider?: string; modelId?: string; level?: string };
			calls.push(command.type);
			if (command.type === "set_model") state = { ...state, model: { provider: "acme", id: command.modelId ?? "" } };
			// pi clamps the effort to what the model supports and says so: the pick of "high" ends as "off"
			if (command.type === "set_thinking_level") state = { ...state, thinkingLevel: state.model.id === "flash" ? "off" : (command.level ?? "off") };
			return command.type === "get_state" ? { response: { success: true, data: state } } : { response: { success: true } };
		},
	} as unknown as SupervisorSocket;
	const live = { sessionId: "44444444-2222-4333-8444-555555555555", workingDirectory: "/work" } as unknown as LiveSession;
	const backend = new SupervisorBackend(live, socket, () => [model("acme", "flash"), model("acme", "pro")]);
	await backend.ensure();
	assert.deepEqual(must(backend.currentSelection()), { id: "acme/pro", config: { thinkingLevel: "high" } });

	// the web chat changed the effort: pi says so, and the selection is ahead of the listeners that read it
	const seen: unknown[] = [];
	backend.subscribe(() => seen.push(backend.currentSelection()));
	push?.({ event: { type: "thinking_level_changed", level: "low" }, session: live.sessionId });
	assert.deepEqual(seen, [{ id: "acme/pro", config: { thinkingLevel: "low" } }]);

	await backend.selectModel({ id: "acme/flash", config: { thinkingLevel: "high" } });
	assert.deepEqual(calls, ["set_model", "set_thinking_level", "get_state"]);
	assert.deepEqual(must(backend.currentSelection()), { id: "acme/flash", config: { thinkingLevel: "off" } }, "what pi runs on, not what was asked");
});

it("attaches in the mode a message chose, again when the mode changes, and tells the host after each attach", async () => {
	const calls: Record<string, unknown>[] = [];
	const socket = {
		onMessage: () => () => {},
		request: async (op: string, fields: Record<string, unknown> = {}) => {
			if (op === "attach") calls.push(fields);
			return op === "attach" ? { mode: "ask", state: {} } : {};
		},
	} as unknown as SupervisorSocket;
	const attached: string[] = [];
	const live = { sessionId: "22222222-2222-4333-8444-555555555555", workingDirectory: "/work" } as unknown as LiveSession;
	const backend = new SupervisorBackend(live, socket, () => [], undefined, { attached: (id) => attached.push(id) });

	// No message named a mode yet: the host keeps the one it stored (a session started with a stored mode, opened in the editor).
	await backend.ensure();
	assert.deepEqual(calls, [{ path: "/work", session: live.sessionId }]);
	await backend.ensure();
	assert.equal(calls.length, 1, "nothing changed: no second attach");

	live.mode = "plan";
	await backend.ensure();
	await backend.ensure();
	assert.deepEqual(calls.at(-1), { path: "/work", session: live.sessionId, mode: "plan" });
	assert.equal(calls.length, 2, "one attach per mode change");

	live.mode = "agent";
	await backend.ensure();
	assert.equal((calls.at(-1) as { mode?: string } | undefined)?.mode, "agent");
	assert.equal(attached.length, 3);
});

it("keeps the events a plugin owns away from the chat driver", () => {
	let forward: ((message: Record<string, unknown>) => void) | undefined;
	const socket = { onMessage: (l: (m: Record<string, unknown>) => void) => ((forward = l), () => {}) } as unknown as SupervisorSocket;
	const live = { sessionId: "33333333-2222-4333-8444-555555555555", workingDirectory: "/work" } as unknown as LiveSession;
	const backend = new SupervisorBackend(live, socket, () => [], undefined, { ownsEvent: (event) => event.type === "plugin_news" });
	const seen: string[] = [];
	backend.subscribe((event) => seen.push((event as { type: string }).type));
	forward?.({ event: { type: "plugin_news" }, session: live.sessionId });
	forward?.({ event: { type: "agent_start" }, session: live.sessionId });
	assert.deepEqual(seen, ["agent_start"]);
});
