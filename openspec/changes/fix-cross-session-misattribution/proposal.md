## Why

When two agent sessions are concurrently active under the same token+project (a normal occurrence given Rembric's multi-client design — e.g. a Claude Code window and an opencode window open on the same project at once), any MCP tool call that auto-resolves its target session (`memory.save`, `memory.confirm`, `memory.session_summary`, `memory.session_start`) can silently land on the _wrong_ session. The fallback query (`findActiveForTransport`) picks "the most recently started active session for this token+project" with no way to know which client actually made the call. Confirmed live: an opencode-originated `memory.session_summary` call was mislabeled onto a concurrently-active Claude Code session. This is silent cross-session data misattribution, not a cosmetic bug — a summary, save, or confirmation can be written against the wrong conversation's history.

Wiring every client to call `memory.session_start` does **not** fix this: that tool's own "reuse an existing session" logic uses the same ambiguous query, so it just as happily adopts a different client's concurrently-active session. The real gap is structural: every client already knows its own correct session id (via the HTTP session-lifecycle hooks/plugin/provider code), but that identity is never communicated to the separately-spawned MCP bridge subprocess that carries the model's tool calls — the two sides of each client's integration currently share no correlation key at all.

## What Changes

- `apps/plugin/bin/rembric-bridge.mjs` generates (or reuses) a stable `bridgeInstanceId` once per bridge process and writes it to a local correlation file keyed by a hash of the project `cwd`, under `$TMPDIR`. This value is static for the bridge's whole lifetime (no staleness problem), unlike the session id itself — see `design.md` for why the mechanism carries an instance id rather than the session id directly.
- The bridge forwards `bridgeInstanceId` as a new HTTP header (`X-Rembric-Bridge-Instance`) via `mcp-remote`'s existing `--header` flag, fixed for the connection's lifetime.
- Each client's existing session-lifecycle HTTP calls (Claude Code/Codex hook scripts, opencode's `plugin.ts`, Hermes's `RembricMemoryProvider`) read that same correlation file and tag their _already-firing_ lifecycle POSTs (`POST /sessions`, `/summary`, `/end`) with the `bridgeInstanceId` — no new POSTs needed, one added field on existing ones.
- The server persists `bridgeInstanceId` on the `agent_sessions` row (new nullable column) when present on a lifecycle POST, and `resolveSessionId` / `resolveActiveSessionId` treat a present, valid `X-Rembric-Bridge-Instance` header (resolved to an active session via that column) as the highest-precedence signal — ahead of the `SessionRouter` transport mapping and the ambiguous DB fallback — closing the cross-client collision this change targets.
- **Explicitly out of scope / accepted residual limitation**: two concurrent windows of the _same_ client in the _same_ project directory share the same correlation file (and thus the same `bridgeInstanceId` once the second bridge overwrites it) and remain ambiguous between themselves. Closing that case would require a genuine per-running-instance identifier per client (investigated during `/opsx:explore` and deliberately not pursued now — recorded as future work in `design.md`).
- One additive database migration: nullable `agent_sessions.bridge_instance_id` column (plain `ADD COLUMN`, no table rebuild needed).

## Capabilities

### New Capabilities

(none — this closes a correctness gap in existing session-identity resolution, it does not introduce a new capability)

### Modified Capabilities

- `mcp-api`: the session-resolution precedence used by `memory.save`, `memory.confirm`, and `memory.session_summary` gains a new highest-precedence signal (the `X-Rembric-Session-Id` header) ahead of the existing `SessionRouter` mapping and DB fallback.
- `plugin-session-protocol`: the per-client lifecycle mapping gains a new, uniform side effect — writing the current session id to the local correlation file — alongside each client's existing HTTP session-lifecycle calls.
- `claude-code-plugin`: the MCP bridge contract (`rembric-bridge.mjs`, shared by Claude Code, Codex, and opencode) gains the correlation-file read + `X-Rembric-Session-Id` header-forwarding behavior.

## Impact

- `apps/plugin/bin/rembric-bridge.mjs` — read the correlation file, add the header to the `mcp-remote` spawn args.
- `apps/plugin/scripts/session-start.sh`, `apps/plugin/scripts/session-end.sh`, `apps/plugin/scripts/stop-sync.sh` — write the correlation file (Claude Code + Codex, shared scripts).
- `apps/plugin/.opencode-plugin/plugin.ts` — write the correlation file from the `session.created` / `session.deleted` / `on_session_switch`-equivalent event branches.
- `apps/plugin/.hermes-plugin/__init__.py` — write the correlation file from `initialize` / `on_session_switch` / `on_session_end`.
- `apps/server/src/mcp/_shared.ts` (`resolveSessionId`), `apps/server/src/mcp/memory-tools.ts` (`resolveActiveSessionId`) — new header-based precedence step.
- `apps/server/src/server/request-context.ts` / HTTP request handling — read and validate the new header into request context.
- `apps/server/src/db/schema.ts` + a new migration — nullable `agent_sessions.bridge_instance_id` column.
- `apps/server/src/db/repositories/agent-sessions-repository.ts`, `apps/server/src/services/agent-sessions.ts` — accept/persist `bridgeInstanceId` on session create/update; new lookup by `(tokenId, bridgeInstanceId)`.
- `apps/server/src/server/api-router.ts` — accept optional `bridgeInstanceId` on the existing `/sessions`, `/summary`, `/end` HTTP endpoints.
- New shared helper for the correlation-file path/read/write (single implementation, imported by the bridge; the Bash and Python clients get their own small readers per the existing per-language discipline — mirrors `rembric-dotenv.mjs`'s single-source-of-truth pattern for the JS side).
