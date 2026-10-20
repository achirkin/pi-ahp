/**
 * AHP over a unix socket as JSON lines, one message per line.
 *
 * A relay (a proxy that has the client's frames over some other link) writes them here and returns
 * what comes back. A line stream keeps the relay side trivial; the protocol above it is the same
 * JSON-RPC the WebSocket carries. Every connection is one AHP client, exactly as one WebSocket would be.
 */

import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { Transport } from "../core/connection.ts";
import type { AhpHost } from "../core/host.ts";
import type { JsonRpcMessage } from "../protocol/jsonrpc.ts";
import type { RunningServer } from "../transport/websocket.ts";

const MAX_LINE = 32 * 1024 * 1024; // images ride inline as base64

class LineTransport implements Transport {
	readonly #socket: Socket;
	readonly #log: (message: string) => void;
	#buffer = "";
	#onMessage: ((message: unknown) => void) | undefined;
	#onClose: (() => void) | undefined;

	constructor(socket: Socket, log: (message: string) => void) {
		this.#socket = socket;
		this.#log = log;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#data(chunk));
		socket.on("error", (error) => this.#log(`relay connection error: ${String(error)}`));
		socket.on("close", () => this.#onClose?.());
	}

	#data(chunk: string): void {
		this.#buffer += chunk;
		if (this.#buffer.length > MAX_LINE) {
			this.#log("relay line too long; dropping the connection");
			this.#socket.destroy();
			return;
		}
		let newline = this.#buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line) {
				try {
					this.#onMessage?.(JSON.parse(line));
				} catch (error) {
					this.#log(`Dropping unparseable relay line: ${String(error)}`);
				}
			}
			newline = this.#buffer.indexOf("\n");
		}
	}

	send(message: JsonRpcMessage): void {
		if (!this.#socket.destroyed) this.#socket.write(`${JSON.stringify(message)}\n`);
	}

	close(): void {
		this.#socket.end();
	}

	onMessage(handler: (message: unknown) => void): void {
		this.#onMessage = handler;
	}

	onClose(handler: () => void): void {
		this.#onClose = handler;
	}
}

export async function serveLineSocket(
	ahpHost: AhpHost,
	options: { readonly socketPath: string; readonly log: (message: string) => void },
): Promise<RunningServer> {
	rmSync(options.socketPath, { force: true });
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		ahpHost.accept(new LineTransport(socket, options.log));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	chmodSync(options.socketPath, 0o600);
	return {
		host: options.socketPath,
		port: 0,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
