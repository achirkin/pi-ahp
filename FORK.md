# Differences from upstream pi-ahp

Upstream: <https://github.com/Qusic/pi-ahp> (MIT). This fork keeps its protocol layer and adds what a host with a
supervised pi needs. Each item is independent; nothing here is specific to one deployment.

## Additions (new files, no upstream file touched)

- `src/supervisor/`, `src/bin/supervised.ts`, `docs/supervisor-protocol.md`: turns run on a pi child owned by a local
  supervisor over a unix socket (`pi-ahp-supervised`). The line transport (`line-transport.ts`) serves AHP as JSON lines on a
  unix socket for a relay.
- `test/disposal-guard.test.ts`: unit tests of the disposal guard below.

## Changes to upstream files

- `src/transport/websocket.ts`: `socketPath` option, a WebSocket listener on a unix socket (mode 0600).
- `src/host/terminal-service.ts`: `node-pty` is loaded on first use and is an optional dependency; a host where it cannot load
  loses terminals and nothing else.
- `src/pi/parcel-watch-pool.ts`, `src/pi/chokidar-watch-source.ts`: the pool's default recursive source is chokidar (pure
  JavaScript) instead of the native `@parcel/watcher`, so one install runs on every CPU and libc.
- `src/host/pi-host.ts`: `PiHost.models()` and `PiHost.setModels(models, current?)` (replace the advertised list, and the
  model a new session starts on, and publish `root/agentsChanged` when the list differs); the default model is computed per session.
- `src/core/client-workarounds.ts`, `connection.ts`, `host.ts`: VS Code's `disposeSession` is both the user's Delete and its own
  provisional-session cleanup. The guard keeps a per-client ledger of the sessions the client created through
  `createSession` and refuses only a disposal of one it created *and used*, with a message that says why; any other session is
  an explicit delete and is allowed. Upstream refuses every durable session. Disposals are logged.
- `src/pi/event-mapper.ts`: a `toolcall_end` for a call whose `toolcall_start` was never seen emits the start first (a reducer
  drops a call it never saw start).
- `src/pi/session-registry.ts`: a session created but not yet started is kept out of the catalogue until its first turn (VS
  Code creates one per new chat and drops half without disposing them); deleting a session finds its file by id.
- `package.json`: `node-pty` moved to `optionalDependencies`; the `pi-ahp-supervised` bin. `pnpm-lock.yaml` follows.

## Rebasing

`git fetch upstream && git rebase upstream/main`. The files in the second list are the only ones that can conflict. After a
rebase run `pnpm test`.
