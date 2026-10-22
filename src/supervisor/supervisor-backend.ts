/**
 * A PiBackend that drives a pi child owned by an external supervisor instead of embedding pi.
 *
 * Use it when something else already runs exactly one pi process per session (shared with other
 * front ends, sandboxed, or on a schedule of its own): a second owner of the same session files
 * would fight it. Everything else in this host (session files, catalogue, history, channels,
 * reducers) stays as in-process hosting, because the files live on this machine and reading them
 * is not contested. The socket contract is in docs/supervisor-protocol.md.
 */
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelSelection } from "@microsoft/agent-host-protocol";
import type { PiBackend } from "../pi/chat-driver.ts";
import { findModelBySelectionId, modelSelectionId, THINKING_CONFIG_KEY } from "../pi/models.ts";
import type { LiveSession } from "../pi/session-registry.ts";
import type { SupervisorSocket } from "./supervisor-client.ts";

interface Waiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

/** The models the host advertises right now (`PiHost.models`). */
export type ModelList = () => readonly Model<never>[];

export class SupervisorBackend implements PiBackend {
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly socket: SupervisorSocket;
	private readonly session: LiveSession;
	private readonly models: ModelList;
	private readonly log: (message: string) => void;
	private turnDone: Waiter | undefined;
	private attached = false;
	private detached = false;
	private selection: ModelSelection | undefined;
	private readonly detachForward: () => void;
	/** The folders the host that runs pi last accepted for this session, to send changes only. */
	private acceptedFolders: string[] | undefined;

	constructor(session: LiveSession, socket: SupervisorSocket, models: ModelList, log?: (message: string) => void) {
		this.session = session;
		this.socket = socket;
		this.models = models;
		this.log = log ?? (() => {});
		this.log(`backend for session ${session.sessionId.slice(0, 8)}`);
		this.detachForward = socket.onMessage((message) => {
			if (message.t !== undefined && message.t !== "event") return; // replies are handled by the client
			if (message.session !== this.session.sessionId) return;
			const event = message.event as AgentSessionEvent | undefined;
			if (!event) return;
			const type = (event as { type?: string }).type;
			// pi RPC's own vocabulary: a turn is over when pi settles; `child_exit` is the supervisor's own event.
			if (type === "agent_settled") this.settle(undefined);
			if (type === "child_exit") this.settle(new Error("pi stopped while the turn was running"));
			for (const listener of this.listeners) listener(event);
		});
	}

	/**
	 * Tells the host that runs pi which folders this session works in, when the client declared or changed them: the host
	 * checks every folder against its path guard and records the list (nothing is granted from a session file). A refusal
	 * is the turn's visible error, and the declared set goes back to what the host accepted before.
	 */
	private async syncFolders(): Promise<void> {
		const folders = this.session.folders;
		if (!folders || sameList(folders, this.acceptedFolders)) return;
		try {
			const data = await this.socket.request("folders", {
				session: this.session.sessionId,
				folders,
				...(this.session.createdHere ? { create: true } : {}),
			});
			const accepted = Array.isArray(data.folders) ? (data.folders as unknown[]).filter((f): f is string => typeof f === "string") : folders;
			this.acceptedFolders = accepted;
			if (!sameList(accepted, folders)) this.session.revertFolders?.(accepted);
		} catch (error) {
			if (this.acceptedFolders) this.session.revertFolders?.(this.acceptedFolders);
			throw error;
		}
	}

	async ensure(): Promise<void> {
		if (this.detached) return;
		await this.syncFolders();
		if (this.attached) return;
		const data = await this.socket.request("attach", { path: this.session.workingDirectory, session: this.session.sessionId });
		this.attached = true;
		const state = data.state as { model?: { provider?: string; id?: string }; thinkingLevel?: string } | undefined;
		if (state?.model?.id) {
			const known = this.models().find((m) => m.id === state.model!.id && (!state.model!.provider || m.provider === state.model!.provider));
			this.selection = {
				id: known ? modelSelectionId(known) : state.model.id,
				...(state.thinkingLevel ? { config: { [THINKING_CONFIG_KEY]: state.thinkingLevel } } : {}),
			};
		}
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void> {
		this.log(`prompt: ${text.slice(0, 40)}`);
		if (signal?.aborted) return;
		await this.ensure();
		const done = this.awaitTurn(signal);
		await this.socket.request("call", { session: this.session.sessionId, command: command("prompt", text, images) });
		await done;
	}

	async steer(text: string, images?: ImageContent[], signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return;
		await this.ensure();
		await this.socket.request("call", { session: this.session.sessionId, command: command("steer", text, images) });
	}

	async abort(): Promise<void> {
		if (!this.attached) return;
		await this.socket.request("call", { session: this.session.sessionId, command: { type: "abort" } }).catch(() => {});
		this.settle(undefined); // the agent_end of a cancelled turn still streams; the prompt must unwind now
	}

	async selectModel(selection: ModelSelection): Promise<void> {
		await this.ensure();
		// The client echoes an id from the advertised list ("<provider>/<id>", pi/models.ts).
		const model = findModelBySelectionId(this.models(), selection.id);
		if (!model) {
			return; // a stale pick: running on what the child uses beats guessing a provider
		}
		await this.socket.request("call", {
			session: this.session.sessionId,
			command: { type: "set_model", provider: model.provider, modelId: model.id },
		});
		const level = (selection.config as Record<string, unknown> | undefined)?.[THINKING_CONFIG_KEY];
		if (typeof level === "string") {
			await this.socket.request("call", { session: this.session.sessionId, command: { type: "set_thinking_level", level } }).catch(() => {});
		}
		this.selection = { id: modelSelectionId(model), ...(typeof level === "string" ? { config: { [THINKING_CONFIG_KEY]: level } } : {}) };
	}

	currentSelection(): ModelSelection | undefined {
		return this.selection;
	}

	dispose(): void {
		if (this.detached) return;
		this.detached = true;
		this.detachForward();
		this.listeners.clear();
		if (this.attached) {
			void this.socket.request("detach", { session: this.session.sessionId }).catch((error: unknown) => this.log(`detach failed: ${String(error)}`));
			this.attached = false;
		}
		this.settle(undefined);
	}

	private awaitTurn(signal?: AbortSignal): Promise<void> {
		if (this.turnDone) this.settle(new Error("two turns on one supervisor backend"));
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			this.turnDone = waiter;
			signal?.addEventListener(
				"abort",
				() => {
					void this.abort().catch(() => {});
				},
				{ once: true },
			);
		});
	}

	private settle(error: Error | undefined): void {
		const waiter = this.turnDone;
		if (!waiter) return;
		this.turnDone = undefined;
		if (error) waiter.reject(error);
		else waiter.resolve();
	}
}

function command(type: string, text: string, images?: ImageContent[]): Record<string, unknown> {
	const list = (images ?? [])
		.filter((image) => typeof image?.data === "string")
		.map((image) => ({ type: "image", mimeType: image.mimeType ?? "image/png", data: image.data }));
	return { type, message: text, ...(list.length ? { images: list } : {}) };
}

function sameList(a: readonly string[], b: readonly string[] | undefined): boolean {
	return b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);
}
