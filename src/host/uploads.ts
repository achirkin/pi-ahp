/**
 * Files a user drops onto the editor's chat. A browser cannot hand pi a path on the user's own computer, so the editor
 * page sends the bytes over its direct channel to this endpoint (an HTTP server on a unix socket that the agent
 * connects the channel to), which writes them under `<dir>/pending/<id>/<name>` and answers with the path. The chat
 * then attaches that path like any file of the host. When a message references a pending file, its folder moves to
 * `<dir>/<sessionId>/<id>/`, so deleting the session can delete its uploads.
 */

import { chmodSync, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Message } from "@microsoft/agent-host-protocol";
import { fileUriToPath, pathToFileUri } from "../core/uri.ts";

/** What one file may weigh; the browser checks the same limit before it sends. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** A pending upload nobody attached is removed after this long. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SESSION_DIR = /^[A-Za-z0-9_-]{1,100}$/u;

/** A file name that cannot leave its folder and has nothing a shell or a viewer would trip on. */
export function safeFileName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = basename(name.replace(/\\/gu, "/")).replace(/[\u0000-\u001f\u007f/]/gu, "_").trim();
	const limited = cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
	return limited === "" || limited === "." || limited === ".." ? "file" : limited;
}

export class UploadStore {
	readonly #dir: string;
	readonly #log: (message: string) => void;
	readonly #now: () => number;

	constructor(dir: string, log: (message: string) => void, now: () => number = Date.now) {
		this.#dir = dir;
		this.#log = log;
		this.#now = now;
		mkdirSync(join(dir, "pending"), { recursive: true, mode: 0o700 });
	}

	get dir(): string {
		return this.#dir;
	}

	/** Listens on a unix socket for `PUT /upload?name=<name>` with a Content-Length; answers 201 `{"path": ...}`. */
	serve(socketPath: string): Promise<{ close(): Promise<void> }> {
		const server = createServer((req, res) => {
			// The editor page reads the reply off a data channel without an HTTP library: it needs the length up front.
			const reply = (status: number, type: string, body: string): void => {
				res.writeHead(status, {
					"content-type": type,
					"content-length": Buffer.byteLength(body),
					"x-spark-upload": "1",
					connection: "close",
				});
				res.end(body);
			};
			const fail = (status: number, message: string): void => {
				this.#log(`upload refused (${status}): ${message}`);
				reply(status, "text/plain; charset=utf-8", message);
			};
			const url = new URL(req.url ?? "/", "http://upload");
			if (req.method !== "PUT" || url.pathname !== "/upload") return fail(405, "PUT /upload is the only request");
			const length = Number(req.headers["content-length"]);
			if (!Number.isSafeInteger(length) || length < 0) return fail(411, "the upload needs a Content-Length");
			if (length > MAX_UPLOAD_BYTES) return fail(413, `the file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB`);
			const id = randomUUID();
			const folder = join(this.#dir, "pending", id);
			const name = safeFileName(url.searchParams.get("name") ?? "");
			const path = join(folder, name);
			mkdirSync(folder, { mode: 0o700 });
			let received = 0;
			const count = new Transform({
				transform(chunk: Buffer, _encoding, done) {
					received += chunk.length;
					done(received > length ? new Error("more bytes than Content-Length") : null, chunk);
				},
			});
			pipeline(req, count, createWriteStream(path, { flags: "wx", mode: 0o600 }))
				.then(() => {
					if (received !== length) throw new Error(`${received} of ${length} bytes arrived`);
					reply(201, "application/json", JSON.stringify({ path }));
				})
				.catch((error: unknown) => {
					rmSync(folder, { recursive: true, force: true });
					fail(400, `the upload failed: ${error instanceof Error ? error.message : String(error)}`);
				});
		});
		rmSync(socketPath, { force: true });
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				chmodSync(socketPath, 0o600);
				resolve({ close: () => new Promise<void>((done) => server.close(() => done())) });
			});
		});
	}

	/** The message with every attachment that names a pending upload re-pointed to the session's folder. */
	adopt(sessionId: string, message: Message): Message {
		if (!SESSION_DIR.test(sessionId) || !Array.isArray(message.attachments)) return message;
		let changed = false;
		const attachments = message.attachments.map((attachment) => {
			const uri = (attachment as { uri?: unknown }).uri;
			if (typeof uri !== "string") return attachment;
			const adopted = this.#adoptPath(sessionId, uri);
			if (!adopted) return attachment;
			changed = true;
			return { ...attachment, uri: pathToFileUri(adopted) };
		});
		return changed ? ({ ...message, attachments } as Message) : message;
	}

	#adoptPath(sessionId: string, uri: string): string | undefined {
		let path: string;
		try {
			// The editor names the file by its remote-authority URI; whatever the scheme, the path is the same on this host.
			if (uri.startsWith("file://")) path = fileUriToPath(uri);
			else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(uri)) path = decodeURIComponent(new URL(uri).pathname);
			else path = uri;
		} catch {
			return undefined;
		}
		const prefix = join(this.#dir, "pending") + "/";
		if (!path.startsWith(prefix)) return undefined;
		const [id, name, ...rest] = path.slice(prefix.length).split("/");
		if (!id || !ID.test(id) || !name || rest.length > 0 || name !== safeFileName(name)) return undefined;
		const target = join(this.#dir, sessionId, id);
		mkdirSync(join(this.#dir, sessionId), { recursive: true, mode: 0o700 });
		try {
			renameSync(join(this.#dir, "pending", id), target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// Already adopted by an earlier send of the same attachment: it is where it was moved to.
			if (!statSync(join(target, name), { throwIfNoEntry: false })) throw error;
		}
		return join(target, name);
	}

	/** The session is gone: so are its uploads. */
	removeSession(sessionId: string): void {
		if (!SESSION_DIR.test(sessionId) || sessionId === "pending") return;
		rmSync(join(this.#dir, sessionId), { recursive: true, force: true });
	}

	/**
	 * At start: uploads nobody attached for a day, and the folders of sessions whose file no longer exists (deleted while
	 * this host was not running, or by hand).
	 */
	async sweep(hasSession: (sessionId: string) => Promise<boolean>): Promise<void> {
		const cutoff = this.#now() - PENDING_MAX_AGE_MS;
		for (const id of readdirSync(join(this.#dir, "pending"))) {
			const folder = join(this.#dir, "pending", id);
			const stat = statSync(folder, { throwIfNoEntry: false });
			if (stat && stat.mtimeMs < cutoff) rmSync(folder, { recursive: true, force: true });
		}
		for (const entry of readdirSync(this.#dir)) {
			if (entry === "pending" || !SESSION_DIR.test(entry)) continue;
			if (!(await hasSession(entry))) {
				this.#log(`removing the uploads of the vanished session ${entry}`);
				rmSync(join(this.#dir, entry), { recursive: true, force: true });
			}
		}
	}
}
