# Supervisor socket

`pi-ahp-supervised` (`src/bin/supervised.ts`) runs turns on a pi child that a local supervisor owns, instead of embedding pi.
The supervisor starts one `pi --mode rpc` per session, shares it with whatever else drives that session, and offers it on a
unix socket. This is the whole contract that `src/supervisor/supervisor-client.ts` relies on.

Transport: line-delimited JSON on a unix stream socket, named by `PI_AHP_SUPERVISOR_SOCK`.

## Requests

`{"id": <number>, "op": "<op>", ...fields}`, answered by `{"id": <same>, "ok": true, "data": {...}}` or
`{"id": <same>, "ok": false, "error": "<text>", "holder": <optional>}`. `holder` says who owns a session that another party
holds (the client attaches it to the thrown error). A request not answered in 60 s fails.

| op | fields | effect |
|---|---|---|
| `attach` | `path` (working directory), `session` (session id) or `new: true` (the supervisor makes one; `data.session`) | Starts or joins the pi child of the session and subscribes this connection to its events. `data.state` may carry `model: {provider, id}` and `thinkingLevel`, the child's current settings. |
| `attach` (mode) | as `attach`, plus `mode` (an opaque name) | Stores the session's mode and runs the child in it: a child running in another mode is restarted first (never during a turn). Without `mode` the stored one stays. `data.mode` says which one the child runs in. Modes come from a plugin (below); a supervisor that has none ignores the field. |
| `call` | `session`, `command` | Sends one pi RPC command to the child (`prompt`, `steer`, `abort`, `set_model`, `set_thinking_level`, `get_available_models`; images ride in `command.images`). |
| `detach` | `session` | Unsubscribes; the supervisor may close the child. |

## Pushed lines

Lines without an `id` are events for attached sessions: `{"event": <pi RPC event, verbatim>, "session": "<id>"}`. A turn ends
at pi's own `agent_settled` event. The supervisor adds one event of its own, `{"type": "child_exit"}`, when the child died
while attached; a running turn then fails with "pi stopped while the turn was running".

## Plugins

`--plugin <module>` loads an ES module whose default export is a function (`src/plugin.ts`): it receives the host's command
line, a link to the supervisor (`request`, `onMessage`) and a logger, and returns what it adds:

- a `customizer` (`SessionCustomizer`, `src/pi/session-registry.ts`): the agents a client may name in `Message.agent`
  (advertised in `AgentInfo.customizations` and each `SessionState.customizations`), the mode each message runs in, and what the
  customization actions (`session/customizationToggled`, `session/mcpServer*Requested`) do. The host sets `LiveSession.mode`
  when a turn starts, and `SupervisorBackend.ensure` sends an `attach` with that `mode` whenever it differs from the one the
  child was attached in. A message queued behind a running turn cannot name another mode than that turn;
- hooks for a session being attached or deleted, and `ownsEvent` for the supervisor's own pushed events that must not reach the
  chat;
- the agent a past turn ran in is read from the session file's custom entry `ahp-agent` (`data.agent`: the agent's URI; no
  `agent` means the client's default), which a pi extension appends when a run starts.

Without a plugin `Message.agent` and the customization actions are refused, as before.

## What stays outside the socket

Session files, the catalogue and history are read from pi's directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) exactly as for
an embedded pi, because the files live on the same machine.

The model list is read the same way, in the host's own process (`models.json`, extensions, and the default provider, model and
thinking level of `settings.json`). Listing runs no `apiKey` command, so the host needs no credential: a provider whose key is a
command (`!cat <file>`, say) has it run by the pi child, per request. A session still starts on the model its
child reports in the `attach` reply (`data.state.model`, `thinkingLevel`). (`attach` accepts `new: true` instead of `session`; the
reply carries the session id as `data.session`.)
