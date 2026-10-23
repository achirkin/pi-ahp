#!/usr/bin/env node
/**
 * `pi-ahp-supervised` — pi-ahp with one substitution: sessions run on a pi child owned by a local
 * supervisor (see docs/supervisor-protocol.md) instead of an embedded pi, so that child stays the
 * single one shared with whatever else drives it.
 *
 * Environment: PI_AHP_SUPERVISOR_SOCK (required) — the supervisor's unix socket.
 * Listeners: `--socket <path>` (WebSocket over a unix socket, e.g. code-server's
 * `--agent-host-bridge-path`), `--relay-socket <path>` (AHP as JSON lines over a unix socket, for a
 * relay), `--upload-socket <path>` with `--uploads-dir <path>` (HTTP over a unix socket: files the user drops on the editor's
 * chat, see host/uploads.ts) and, without a socket, `--host/--port` with AHP_TOKEN. The connection token for the
 * WebSocket listeners is AHP_TOKEN or VSCODE_AGENT_HOST_BRIDGE_CONNECTION_TOKEN.
 * The models are discovered in this process from pi's own files (settings, models.json, extensions), as an embedded
 * pi-ahp does. Listing needs no credential: a provider's `apiKey` command (`!cat <file>`, say) is
 * run by the pi child per request, never here. The default model and thinking level come from pi's settings.
 * `--plugin <module>` adds a deployment's own agents and toggles (src/plugin.ts).
 * `--check` loads the host code and exits, so a packager can refuse to publish a build that cannot start.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { getAhpDir } from "../core/ahp-dir.ts";
import { pathToFileUri } from "../core/uri.ts";
import { VERSION } from "../host/serve.ts";
import { createPiHost, type PiHost } from "../host/pi-host.ts";
import { UploadStore } from "../host/uploads.ts";
import { MetadataStore } from "../pi/metadata-store.ts";
import { createDefaultPiSessionStorage } from "../pi/session-storage.ts";
import { serveLineSocket } from "../supervisor/line-transport.ts";
import type { Plugin, PluginContext, PluginFactory } from "../plugin.ts";
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

async function loadPlugin(path: string, context: PluginContext): Promise<Plugin> {
	const module = (await import(pathToFileUri(path))) as { default?: PluginFactory };
	if (typeof module.default !== "function") throw new Error(`${path}: a plugin's default export is a function (see src/plugin.ts)`);
	return module.default(context);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		log("usage: pi-ahp-supervised [--socket <path>] [--relay-socket <path>] [--upload-socket <path> --uploads-dir <path>] [--plugin <module>] [--host <addr>] [--port <n>] [--cwd <path>] [--check]  (env: PI_AHP_SUPERVISOR_SOCK, AHP_TOKEN)");
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

	const uploadSocket = flagValue(args, "--upload-socket");
	const uploadsDir = flagValue(args, "--uploads-dir");
	if (Boolean(uploadSocket) !== Boolean(uploadsDir)) {
		log("--upload-socket and --uploads-dir go together");
		process.exit(1);
	}
	const uploads = uploadsDir ? new UploadStore(resolve(uploadsDir), log) : undefined;

	const supervisor = new SupervisorSocket(supervisorPath, log);
	// A plugin adds a deployment's own agents and toggles (see plugin.ts). Without one this is a plain supervised host and
	// `Message.agent` is refused.
	const pluginPath = flagValue(args, "--plugin");
	const plugin = pluginPath ? await loadPlugin(resolve(pluginPath), { args, supervisor, log }) : undefined;
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
		createBackend: (session) =>
			new SupervisorBackend(session, supervisor, () => piHost?.models() ?? [], log, {
				...(plugin?.attached ? { attached: (sessionId) => plugin.attached?.(sessionId) } : {}),
				...(plugin?.ownsEvent ? { ownsEvent: (event) => plugin.ownsEvent?.(event) ?? false } : {}),
			}),
		...(plugin?.customizer ? { customizer: plugin.customizer } : {}),
		...(uploads ? { prepareMessage: (sessionId, message) => uploads.adopt(sessionId, message) } : {}),
	});
	const { host: ahpHost, changesets, terminals, watches, webhooks } = piHost;
	if (plugin?.sessionDeleted) piHost.sessions.onSessionDeletionCommitted((sessionId) => plugin.sessionDeleted?.(sessionId));
	let uploadServer: { close(): Promise<void> } | undefined;
	if (uploads && uploadSocket) {
		// A deleted session takes its uploads along; what was deleted while this host was down goes now.
		piHost.sessions.onSessionDeletionCommitted((sessionId) => uploads.removeSession(sessionId));
		uploadServer = await uploads.serve(uploadSocket);
		log(`listening uploads ${uploadSocket}`);
		void uploads
			.sweep(async (sessionId) => (await piHost?.catalogue.findSessionFile(sessionId)) !== undefined)
			.catch((error: unknown) => log(`upload sweep failed: ${String(error)}`));
	}

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
		void Promise.all([...servers.map((server) => server.close()), uploadServer?.close()]).then(async () => {
			terminals.shutdown();
			webhooks.dispose();
			await Promise.all([changesets.dispose(), watches.dispose()]);
			plugin?.dispose?.();
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
