/** Files dropped on the editor's chat: the upload endpoint, adoption into the session's folder, cleanup. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Message } from "@microsoft/agent-host-protocol";
import { MAX_UPLOAD_BYTES, safeFileName, UploadStore } from "../src/host/uploads.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

function put(socket: string, target: string, body: Buffer, headers: Record<string, string | number> = {}) {
	return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
		const req = request({ socketPath: socket, method: "PUT", path: target, headers: { "content-length": body.length, ...headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

function messageWith(...uris: string[]): Message {
	return {
		text: "look at this",
		origin: { kind: "user" },
		attachments: uris.map((uri) => ({ type: "resource", label: "x", uri })),
	} as unknown as Message;
}

describe("uploads", () => {
	let root: string;
	let store: UploadStore;
	let socket: string;
	let server: { close(): Promise<void> };
	const log: string[] = [];

	before(async () => {
		root = mkdtempSync(join(tmpdir(), "uploads-"));
		store = new UploadStore(join(root, "uploads"), (m) => log.push(m));
		socket = join(root, "upload.sock");
		server = await store.serve(socket);
	});
	after(async () => {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("names cannot leave their folder", () => {
		assert.equal(safeFileName("report.pdf"), "report.pdf");
		assert.equal(safeFileName("../../etc/passwd"), "passwd");
		assert.equal(safeFileName("..\\..\\evil.sh"), "evil.sh");
		assert.equal(safeFileName(".."), "file");
		assert.equal(safeFileName(""), "file");
		assert.equal(safeFileName("a\nb\u0000c"), "a_b_c");
		assert.equal(safeFileName("x".repeat(500)).length, 200);
	});

	it("keeps an uploaded file under pending/<id>/<name> and says where", async () => {
		const bytes = Buffer.from("hello\n");
		const reply = await put(socket, "/upload?name=notes%20v1.txt", bytes);
		assert.equal(reply.status, 201);
		assert.equal(reply.headers["x-spark-upload"], "1");
		// the page reads the reply without an HTTP library: a length, not chunks
		assert.equal(reply.headers["content-length"], String(Buffer.byteLength(reply.body)));
		assert.equal(reply.headers["transfer-encoding"], undefined);
		const { path } = JSON.parse(reply.body) as { path: string };
		assert.match(path, /\/pending\/[0-9a-f-]{36}\/notes v1\.txt$/u);
		assert.ok(readFileSync(path).equals(bytes));
	});

	it("refuses what it cannot take, visibly", async () => {
		const wrongMethod = await new Promise<number>((resolve, reject) => {
			const req = request({ socketPath: socket, method: "GET", path: "/upload" }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(wrongMethod, 405);
		const elsewhere = await put(socket, "/other", Buffer.from("x"));
		assert.equal(elsewhere.status, 405);
		assert.equal(elsewhere.headers["x-spark-upload"], "1");
		assert.equal(elsewhere.headers["content-length"], String(Buffer.byteLength(elsewhere.body)));
		const huge = await put(socket, "/upload?name=big", Buffer.alloc(0), { "content-length": MAX_UPLOAD_BYTES + 1 });
		assert.equal(huge.status, 413);
		assert.ok(log.some((line) => line.includes("413")));
		const pending = readdirSync(join(store.dir, "pending"));
		for (const id of pending) assert.ok(readdirSync(join(store.dir, "pending", id)).length > 0, "no empty folder is left behind");
	});

	it("moves a pending file into the session's folder when a message names it, whatever the URI form", async () => {
		const first = JSON.parse((await put(socket, "/upload?name=a.txt", Buffer.from("A"))).body).path as string;
		const second = JSON.parse((await put(socket, "/upload?name=b%20c.md", Buffer.from("B"))).body).path as string;
		const asFile = `file://${first}`;
		const asRemote = `vscode-remote://spark.home${second.split("/").map(encodeURIComponent).join("/")}`;
		const adopted = store.adopt(SESSION, messageWith(asFile, asRemote, "file:///etc/hostname"));
		const uris = (adopted.attachments as unknown as { uri: string }[]).map((a) => a.uri);
		assert.equal(uris[0], `file://${join(store.dir, SESSION, first.split("/").at(-2) as string, "a.txt")}`);
		assert.match(decodeURIComponent(uris[1] as string), new RegExp(`${SESSION}/[0-9a-f-]{36}/b c\\.md$`, "u"));
		assert.equal(uris[2], "file:///etc/hostname", "other files are left alone");
		assert.ok(!existsSync(first), "the pending copy moved");
		assert.equal(readFileSync(decodeURIComponent(new URL(uris[0] as string).pathname), "utf8"), "A");
		// the same attachment sent again finds the file where it was moved to
		const again = store.adopt(SESSION, messageWith(asFile));
		assert.equal((again.attachments as unknown as { uri: string }[])[0]?.uri, uris[0]);
	});

	it("does not follow a made-up path out of pending", () => {
		const outside = join(root, "secret.txt");
		writeFileSync(outside, "s");
		for (const uri of [
			`file://${join(store.dir, "pending", "..", "..", "secret.txt")}`,
			`file://${join(store.dir, "pending", randomUUID(), "..", "x")}`,
			`file://${join(store.dir, "pending", "not-an-id", "f")}`,
			`file://${join(store.dir, "pending", randomUUID(), "a", "b")}`,
		]) {
			const message = messageWith(uri);
			assert.equal(store.adopt(SESSION, message), message, uri);
		}
		assert.ok(existsSync(outside));
	});

	it("a message without attachments, or a session id that is not an id, passes untouched", () => {
		const plain = { text: "hi", origin: { kind: "user" } } as unknown as Message;
		assert.equal(store.adopt(SESSION, plain), plain);
		const message = messageWith("file:///x");
		assert.equal(store.adopt("../x", message), message);
	});

	it("removes a session's uploads, and only that session's", async () => {
		const path = JSON.parse((await put(socket, "/upload?name=gone.txt", Buffer.from("G"))).body).path as string;
		store.adopt("sess-a", messageWith(`file://${path}`));
		const other = JSON.parse((await put(socket, "/upload?name=stay.txt", Buffer.from("S"))).body).path as string;
		store.adopt("sess-b", messageWith(`file://${other}`));
		store.removeSession("sess-a");
		assert.ok(!existsSync(join(store.dir, "sess-a")));
		assert.ok(existsSync(join(store.dir, "sess-b")));
		store.removeSession("pending");
		store.removeSession("../..");
		assert.ok(existsSync(join(store.dir, "pending")));
	});

	it("sweeps old pending uploads and the folders of sessions that no longer exist", async () => {
		const old = join(store.dir, "pending", randomUUID());
		mkdirSync(old);
		writeFileSync(join(old, "x"), "x");
		const longAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
		utimesSync(old, longAgo, longAgo);
		const fresh = join(store.dir, "pending", randomUUID());
		mkdirSync(fresh);
		mkdirSync(join(store.dir, "vanished", "id"), { recursive: true });
		mkdirSync(join(store.dir, "alive", "id"), { recursive: true });
		await store.sweep(async (id) => id === "alive" || id === "sess-b");
		assert.ok(!existsSync(old));
		assert.ok(existsSync(fresh));
		assert.ok(!existsSync(join(store.dir, "vanished")));
		assert.ok(existsSync(join(store.dir, "alive")));
	});
});
