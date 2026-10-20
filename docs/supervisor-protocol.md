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
| `call` | `session`, `command` | Sends one pi RPC command to the child (`prompt`, `steer`, `abort`, `set_model`, `set_thinking_level`, `get_available_models`; images ride in `command.images`). |
| `detach` | `session` | Unsubscribes; the supervisor may close the child. |

## Pushed lines

Lines without an `id` are events for attached sessions: `{"event": <pi RPC event, verbatim>, "session": "<id>"}`. A turn ends
at pi's own `agent_settled` event. The supervisor adds one event of its own, `{"type": "child_exit"}`, when the child died
while attached; a running turn then fails with "pi stopped while the turn was running".

## What stays outside the socket

Session files, the catalogue and history are read from pi's directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) exactly as for
an embedded pi, because the files live on the same machine.

The model list is not: before it listens, the host attaches a throwaway session (`attach` with `new: true`), asks its child
`{"type": "get_available_models"}` through `call`, takes `data.state.model` and `thinkingLevel` of the attach as what a new session
runs on, and detaches. pi lists a provider only when its credentials resolve, and the child is the process that has them. An answer
that is not `success` with `data.models` stops the host from starting. (`attach` accepts `new: true` instead of `session`; the reply
carries the session id as `data.session`.)
