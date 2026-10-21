/**
 * A supervised host discovers its models in process, from pi's files, like an embedded host: listing runs no `apiKey`
 * command (the Spark's token is read by the pi child per request), and a session selects the model its child runs.
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
				spark: {
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
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "spark", defaultModel: "pro", defaultThinkingLevel: "high" }));

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
		assert.deepEqual(advertised.sort(), ["spark/flash", "spark/pro"]);
		assert.equal(existsSync(marker), false, "listing must not run the apiKey command");

		const id = "default-selection";
		await built.sessions.create({ channel: sessionUri(id) });
		assert.deepEqual((built.host.store.get(chatUri(id)) as ChatState).draft?.model, { id: "spark/pro", config: { thinkingLevel: "high" } });
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
		attach: { state: { model: { provider: "spark", id: "pro" }, thinkingLevel: "high" } },
	});
	const backend = new SupervisorBackend(session, socket, () => [model("spark", "flash"), model("spark", "pro")]);
	await backend.ensure();
	assert.deepEqual(must(backend.currentSelection()), { id: "spark/pro", config: { thinkingLevel: "high" } });
});
