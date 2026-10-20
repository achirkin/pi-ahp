/**
 * Client of a pi supervisor: a local process that owns the pi child of each session and exposes it
 * on a unix socket (see docs/supervisor-protocol.md).
 *
 * Line-delimited JSON: `{id, op, ...fields}` in, `{id, ok, data|error}` out, plus pushed
 * `{event, session}` lines for the sessions this connection attached.
 */
import net from "node:net";

export interface SupervisorReply {
	ok: boolean;
	data?: unknown;
	error?: string;
	holder?: unknown;
}

type Listener = (message: Record<string, unknown>) => void;

export class SupervisorSocket {
	private socket: net.Socket | undefined;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (r: SupervisorReply) => void; reject: (e: Error) => void }>();
	private listeners = new Set<Listener>();
	private closing = false;
	private readonly path: string;
	private readonly log: (message: string) => void;

	constructor(path: string, log?: (message: string) => void) {
		this.path = path;
		this.log = log ?? (() => {});
	}

	async request(op: string, fields: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Record<string, unknown>> {
		const socket = await this.connect();
		const id = this.nextId++;
		const reply = await new Promise<SupervisorReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`the supervisor did not answer "${op}" in time`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			socket.write(JSON.stringify({ id, op, ...fields }) + "\n");
		});
		if (!reply.ok) {
			const error = new Error(reply.error || `the supervisor refused ${op}`) as Error & { holder?: unknown };
			if (reply.holder !== undefined) error.holder = reply.holder;
			throw error;
		}
		return typeof reply.data === "object" && reply.data !== null ? (reply.data as Record<string, unknown>) : {};
	}

	onMessage(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		this.closing = true;
		this.socket?.destroy();
		this.socket = undefined;
		for (const waiter of this.pending.values()) waiter.reject(new Error("the supervisor link closed"));
		this.pending.clear();
	}

	private async connect(): Promise<net.Socket> {
		if (this.socket && !this.socket.destroyed) return this.socket;
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const candidate = net.createConnection(this.path, () => resolve(candidate));
			candidate.once("error", reject);
		});
		if (this.closing) {
			socket.destroy();
			throw new Error("closed");
		}
		socket.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline).trim();
				this.buffer = this.buffer.slice(newline + 1);
				if (line) {
					try {
						const message = JSON.parse(line) as Record<string, unknown>;
						if (typeof message.id === "number") {
							const waiter = this.pending.get(message.id);
							this.pending.delete(message.id);
							waiter?.resolve(message as unknown as SupervisorReply);
						} else {
							for (const listener of this.listeners) listener(message);
						}
					} catch (error) {
						this.log(`supervisor line ignored: ${String(error)}`);
					}
				}
				newline = this.buffer.indexOf("\n");
			}
		});
		socket.on("close", () => {
			if (this.socket === socket) {
				this.socket = undefined;
				for (const waiter of this.pending.values()) waiter.reject(new Error("the supervisor link closed"));
				this.pending.clear();
			}
		});
		socket.on("error", () => socket.destroy());
		this.socket = socket;
		return socket;
	}
}
