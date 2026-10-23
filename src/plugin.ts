/**
 * What a deployment adds to `pi-ahp-supervised` without changing it.
 *
 * `--plugin <module>` names an ES module whose default export is a {@link PluginFactory}. The host calls it once at start with
 * its command line and the supervisor connection, and composes what the plugin returns: the agents and toggles a client may
 * use ({@link SessionCustomizer}), what to do when a session attaches or goes away, and the supervisor events that are the
 * plugin's own news rather than pi's. A host started without a plugin is the plain supervised host.
 */

import type { SessionCustomizer } from "./pi/session-registry.ts";

/** The supervisor connection, narrowed to what a plugin may use: its own requests and the messages pushed to this host. */
export interface SupervisorLink {
	request(op: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>;
	onMessage(listener: (message: Record<string, unknown>) => void): () => void;
}

export interface PluginContext {
	/** The host's command line (without node and the script): a plugin reads its own flags from it. */
	readonly args: readonly string[];
	readonly supervisor: SupervisorLink;
	readonly log: (message: string) => void;
}

export interface Plugin {
	/** Gives `Message.agent` and the customization actions a meaning (see {@link SessionCustomizer}). */
	readonly customizer?: SessionCustomizer;
	/** A session is attached to the supervisor's pi child (after the first attach and after each mode change). */
	attached?(sessionId: string): void;
	/** The supervisor's own events (not pi's), which must not reach the chat: `true` consumes the event. */
	ownsEvent?(event: { type?: string }): boolean;
	/** A session was deleted. */
	sessionDeleted?(sessionId: string): void;
	/** The host stops. */
	dispose?(): void;
}

export type PluginFactory = (context: PluginContext) => Plugin | Promise<Plugin>;
