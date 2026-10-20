/**
 * VS Code's `disposeSession` is both the user's Delete and its own provisional-session cleanup; the guard in
 * client-workarounds.ts tells them apart by who created the session. Run: node --test test/*.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionType } from "@microsoft/agent-host-protocol";
import { chatUri, sessionUri } from "../src/core/channels.ts";
import { ClientWorkarounds } from "../src/core/client-workarounds.ts";
import { ProtocolError } from "../src/protocol/errors.ts";

let nextId = 1;

function vscodeClient(clientId: string, fresh: boolean, lines: string[] = []): ClientWorkarounds {
	const w = new ClientWorkarounds((line) => lines.push(line));
	w.identify({ name: "vscode-editor-window" });
	w.bindClient(clientId, fresh);
	return w;
}

/** Sends a request through the client's workarounds and answers it successfully. */
function request(w: ClientWorkarounds, method: string, params: Record<string, unknown>): number {
	const id = nextId++;
	w.applyToIncoming({ jsonrpc: "2.0", id, method, params });
	return id;
}

function answer(w: ClientWorkarounds, id: number): void {
	w.applyToOutgoing({ jsonrpc: "2.0", id, result: null });
}

function create(w: ClientWorkarounds, session: string): void {
	answer(w, request(w, "createSession", { channel: sessionUri(session) }));
}

function use(w: ClientWorkarounds, session: string): void {
	w.applyToIncoming({
		jsonrpc: "2.0",
		method: "dispatchAction",
		params: { channel: chatUri(session), action: { type: ActionType.ChatTurnStarted } },
	});
}

function dispose(w: ClientWorkarounds, session: string): void {
	answer(w, request(w, "disposeSession", { channel: sessionUri(session) }));
}

test("a session the client did not create is an explicit delete and is allowed", () => {
	const lines: string[] = [];
	const w = vscodeClient("c-explicit", true, lines);
	dispose(w, "old-session");
	assert.match(lines.join("\n"), /allowed disposeSession .*old-session/);
});

test("an unused draft the client created is cleaned up", () => {
	const w = vscodeClient("c-draft", true);
	create(w, "draft");
	dispose(w, "draft");
});

test("a session the client created and used is refused, with a message that says why", () => {
	const lines: string[] = [];
	const w = vscodeClient("c-used", true, lines);
	create(w, "used");
	use(w, "used");
	assert.throws(
		() => dispose(w, "used"),
		(error: unknown) => error instanceof ProtocolError && /Reload the editor window/.test(error.message),
	);
	assert.match(lines.join("\n"), /refused disposeSession .*used.*created here: materialized/);
});

test("a reconnect keeps what the client created; a fresh initialize starts over", () => {
	const before = vscodeClient("c-reconnect", true);
	create(before, "kept");
	use(before, "kept");
	const reconnected = vscodeClient("c-reconnect", false);
	assert.throws(() => dispose(reconnected, "kept"), ProtocolError);
	const reloaded = vscodeClient("c-reconnect", true);
	dispose(reloaded, "kept");
});

test("a failed disposal leaves the session as it was", () => {
	const w = vscodeClient("c-failed", true);
	w.applyToIncoming({ jsonrpc: "2.0", id: 900, method: "disposeSession", params: { channel: sessionUri("x") } });
	w.applyToOutgoing({ jsonrpc: "2.0", id: 900, error: { code: -32603, message: "no" } });
	dispose(w, "x");
});

test("clients other than VS Code are not subject to the guard", () => {
	const w = new ClientWorkarounds();
	w.identify({ name: "ios" });
	w.bindClient("c-other", true);
	create(w, "s");
	use(w, "s");
	dispose(w, "s");
});
