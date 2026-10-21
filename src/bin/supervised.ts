#!/usr/bin/env node
/**
 * `pi-ahp-supervised` — pi-ahp with one substitution: sessions run on a pi child owned by a local
 * supervisor (see docs/supervisor-protocol.md) instead of an embedded pi, so that child stays the
 * single one shared with whatever else drives it.
 *
 * Environment: PI_AHP_SUPERVISOR_SOCK (required) — the supervisor's unix socket.
 * Listeners: `--socket <path>` (WebSocket over a unix socket, e.g. code-server's
 * `--agent-host-bridge-path`), `--relay-socket <path>` (AHP as JSON lines over a unix socket, for a
 * relay) and, without either, `--host/--port` with AHP_TOKEN. The connection token for the
 * WebSocket listeners is AHP_TOKEN or VSCODE_AGENT_HOST_BRIDGE_CONNECTION_TOKEN.
 * The models are discovered in this process from pi's own files (settings, models.json, extensions), as an embedded
 * pi-ahp does. Listing needs no credential: a provider's `apiKey` command (the Spark's `!cat /run/spark/llm/token`) is
 * run by the pi child per request, never here. The default model and thinking level come from pi's settings.
 * `--check` loads the host code and exits, so a packager can refuse to publish a build that cannot start.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { getAhpDir } from "../core/ahp-dir.ts";
import { pathToFileUri } from "../core/uri.ts";
import { VERSION } from "../host/serve.ts";
import { createPiHost, type PiHost } from "../host/pi-host.ts";
import { MetadataStore } from "../pi/metadata-store.ts";
import { createDefaultPiSessionStorage } from "../pi/session-storage.ts";
import { serveLineSocket } from "../supervisor/line-transport.ts";
import { SupervisorBackend } from "../supervisor/supervisor-backend.ts";
import { SupervisorSocket } from "../supervisor/supervisor-client.ts";
import { type RunningServer, serveWebSocket } from "../transport/websocket.ts";

function log(message: string): void {
	process.stderr.write(`pi-ahp-supervised: ${message}\n`);
}

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		log("usage: pi-ahp-supervised [--socket <path>] [--relay-socket <path>] [--host <addr>] [--port <n>] [--cwd <path>] [--check]  (env: PI_AHP_SUPERVISOR_SOCK, AHP_TOKEN)");
		process.exit(0);
	}
	if (args.includes("--check")) {
		// Everything above is already imported; node-pty is the one optional native piece.
		let pty = "available";
		try {
			createRequire(import.meta.url)("node-pty");
		} catch (error) {
			pty = `unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
		}
		log(`check ok: node ${process.version} ${process.platform}-${process.arch}; terminals ${pty}`);
		process.exit(0);
	}
	const supervisorPath = process.env.PI_AHP_SUPERVISOR_SOCK ?? "";
	if (!supervisorPath) {
		log("PI_AHP_SUPERVISOR_SOCK is not set: it names the supervisor's unix socket");
		process.exit(1);
	}
	const workingDirectory = resolve(flagValue(args, "--cwd") ?? process.cwd());
	const host = flagValue(args, "--host") ?? process.env.AHP_HOST ?? "127.0.0.1";
	const port = Number(flagValue(args, "--port") ?? process.env.AHP_PORT ?? 0);
	const connectionToken = process.env.AHP_TOKEN ?? process.env.VSCODE_AGENT_HOST_BRIDGE_CONNECTION_TOKEN ?? "";

	const supervisor = new SupervisorSocket(supervisorPath, log);
	const metadata = new MetadataStore(getAhpDir());
	// The backends read the model list through this once the host exists; they only run later.
	let piHost: PiHost | undefined;
	piHost = await createPiHost({
		serverInfo: { name: "pi-ahp-supervised", version: VERSION },
		defaultDirectory: pathToFileUri(workingDirectory),
		workingDirectory,
		sessionStorage: createDefaultPiSessionStorage(metadata),
		metadata,
		log,
		createBackend: (session) => new SupervisorBackend(session, supervisor, () => piHost?.models() ?? [], log),
	});
	const { host: ahpHost, changesets, terminals, watches, webhooks } = piHost;

	const socketPath = flagValue(args, "--socket");
	const relayPath = flagValue(args, "--relay-socket");
	const servers: RunningServer[] = [];
	if (socketPath) {
		servers.push(await serveWebSocket(ahpHost, { socketPath, ...(connectionToken ? { connectionToken } : {}), log }));
		log(`listening ws+unix ${socketPath}`);
	}
	if (relayPath) {
		servers.push(await serveLineSocket(ahpHost, { socketPath: relayPath, log }));
		log(`listening relay ${relayPath}`);
	}
	if (!socketPath && !relayPath) {
		const server = await serveWebSocket(ahpHost, {
			host,
			port: Number.isFinite(port) ? port : 0,
			...(connectionToken ? { connectionToken } : {}),
			log,
		});
		servers.push(server);
		log(`listening ws://${host}:${server.port}${connectionToken ? " token" : ""} supervisor ${supervisorPath}`);
	}

	const stop = (): void => {
		void Promise.all(servers.map((server) => server.close())).then(async () => {
			terminals.shutdown();
			webhooks.dispose();
			await Promise.all([changesets.dispose(), watches.dispose()]);
			supervisor.close();
			process.exit(0);
		});
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	log(`models: ${piHost.models().length}`);
}

void main().catch((error: unknown) => {
	log(`failed: ${String(error instanceof Error ? error.stack ?? error.message : error)}`);
	process.exit(1);
});
