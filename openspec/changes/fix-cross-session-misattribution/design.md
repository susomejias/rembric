## Context

`resolveSessionId` (`apps/server/src/mcp/_shared.ts`) and `resolveActiveSessionId` (`apps/server/src/mcp/memory-tools.ts`) auto-attach a target session to `memory.save`, `memory.confirm`, and `memory.session_summary` when the caller omits an explicit `sessionId`. Precedence today:

1. Explicit `sessionId` arg (never supplied by any shipped client).
2. `SessionRouter` entry for `(tokenId, mcpSessionId)` — populated only by an explicit `memory.session_start` call, which no shipped client makes.
3. `AgentSessionsRepository.findActiveForTransport({tokenId, projectId})` — "most recently started active session for this token+project," with **no transport or agent identity at all**.

Step 3 is what breaks under concurrency: two sessions from different clients (or the same client, different windows) racing under one token collide, and the later-started one always wins regardless of which connection actually called the tool. Confirmed live during `/opsx:explore`: an opencode session's `memory.session_summary` call landed on a concurrently-active Claude Code session.

`memory.session_start`'s own "reuse an existing session" logic (`session-tools.ts`) calls the _same_ `findActiveForTransport` query to decide whether to adopt an existing row instead of minting a new one — so wiring every client to call `session_start` at connection time does not fix the ambiguity; it just moves it.

Every client already knows its own correct session id at multiple points (HTTP session-lifecycle hooks/plugin/provider code) but never communicates it to the separately-spawned MCP bridge subprocess (`rembric-bridge.mjs` → `mcp-remote`) that carries the model's tool calls. The two halves of each client's integration share no correlation key today.

## Goals / Non-Goals

**Goals:**

- Eliminate cross-_client_ session misattribution (the bug actually observed): Claude Code, Codex, opencode, and Hermes sessions running concurrently under one token must never have their MCP writes land on each other's rows.
- No new steady-state latency or reliability cost: the fix must degrade to today's behavior (not fail harder) when the mechanism is unavailable (bridge not yet started, correlation file missing/stale, header absent).
- No client-visible behavior change: no new tool arguments for the model to remember to pass, no prompt/nudge changes.

**Non-Goals:**

- Disambiguating two concurrent windows of the _same_ client in the _same_ project directory. This would require a genuine per-running-instance identifier per client (investigated below; deliberately deferred — see Open Questions).
- Any change to `memory.session_start`'s reuse semantics beyond consulting the new signal in the same precedence chain other tools use.
- Any change to the RRF/search, consolidation, or dashboard surfaces.

## Decisions

### 1. Correlation payload is a stable _bridge instance id_, not the session id itself

**Rejected first design** (the one sketched during `/opsx:explore`): have each client write the _current session id_ to the correlation file, and have the bridge read it "fresh, not cached at spawn" before forwarding it as a header via `mcp-remote --header`.

This does not work: `mcp-remote` is a long-lived subprocess for the whole MCP connection's lifetime, and its `--header` arguments are fixed at spawn time — there is no mechanism to re-read a file and refresh an already-running process's outgoing headers per request. A single bridge/`mcp-remote` process commonly outlives more than one session (e.g., Claude Code does not restart configured MCP servers on `/clear` or `/resume`), so a session-id-in-header design would silently go stale after the first session-boundary event within a long-lived connection — worse, it would then _actively misattribute_ to the wrong (stale) session rather than degrading to today's ambiguous-but-at-least-fresh DB fallback.

**Chosen design**: the bridge generates a random `bridgeInstanceId` once, at its own startup, and writes it to the correlation file. This value is static for the connection's entire lifetime, so freezing it into a `mcp-remote --header` at spawn time is correct and never goes stale. The _evolving_ piece of information — which session is currently active for this bridge instance — travels instead via the session-lifecycle HTTP POSTs every client already makes on every relevant event (`POST /sessions`, `/summary`, `/end`), each now carrying an added `bridgeInstanceId` field read from the same correlation file. Those POSTs are already fresh-by-construction (fired exactly when the client's session state changes), so this sidesteps the staleness problem entirely instead of working around it.

### 2. Correlation file location and format

`${TMPDIR:-/tmp}/rembric-bridge-instance/<sanitized-cwd>`, content = the raw `bridgeInstanceId` string (a ULID or UUID, no JSON wrapper — trivial to read/write identically across Bash, Node, and Python). `<sanitized-cwd>` mirrors the existing `SAFE_ID` pattern in `prompt-nudge.sh` (non-alnum → `_`) rather than a cryptographic hash, to avoid needing a hash implementation in three languages for a value that only needs to be unique-enough and filesystem-safe, not secret. Risk of filename-length edge cases on deeply nested paths is accepted (same failure mode as today: the field is just omitted, no crash).

**Alternative considered**: hash the cwd (e.g. a short FNV/SHA prefix) for a guaranteed-bounded filename. Rejected for this change — adds a hash dependency/implementation to Bash and Python for marginal benefit; revisit only if the sanitized-name approach proves to actually collide or exceed filesystem limits in practice.

### 3. Bridge writes the file; clients only read it

The bridge owns file creation (write-once per bridge startup, overwriting any prior instance id for that cwd). Client-side lifecycle code (hook scripts, `plugin.ts`, the Hermes provider) only _reads_ it, and treats a missing file as "no bridge instance known yet" — omit the field, exactly like every other best-effort field in these POSTs. This ordering is what the accepted residual limitation (§ below) follows from: whichever bridge started most recently "owns" the correlation file for that cwd.

### 4. Persistence: a real column, not a second in-memory router

`SessionRouter` is deliberately in-memory-only and cold-starts on server restart (documented rationale: `abandonStale` reconciles staleness anyway). This change adds `agent_sessions.bridge_instance_id` (nullable) as a real, persisted column instead of inventing a parallel in-memory instance-router, because:

- The lifecycle HTTP endpoints that would set it already write to `agent_sessions` rows directly — a column read is a natural extension of that existing write path, not a new subsystem.
- Persistence means a server restart doesn't lose the mapping the way an in-memory table would — consistent with how the session rows themselves already persist.

`resolveSessionId`'s new step: given a valid `X-Rembric-Bridge-Instance` header, look up the most recent `active` session for `(tokenId, bridge_instance_id)`. This is scoped to the calling token already (mirrors every other lookup in this file), so a header value can never cross a token boundary.

**Alternative considered**: extend `SessionRouter` with a second map keyed by `bridgeInstanceId`. Rejected — would need its own reconciliation-on-restart story that the persisted-column approach gets for free from the existing `agent_sessions` table.

### 5. Header validation and degradation

An `X-Rembric-Bridge-Instance` header that resolves to no active session (unknown instance id, or the matching session already ended) is treated exactly like a missing header — fall through to the existing `SessionRouter` → DB-fallback chain. The header is never grounds for a hard error; it can only narrow correctly or be silently ignored. This preserves "no worse than today" even if the mechanism is buggy, mid-rollout, or the bridge predates this change (old cached bridge binaries simply never send the header).

### 6. Codex's env-clearing does not apply

Codex CLI clears subprocess env before MCP spawn and only forwards allow-listed `env_vars` (per `per-client-gotchas.md`). This design communicates via a file on disk, not an environment variable, so it does not need any change to Codex's manifest `env_vars` allowlist. Confirmed no other part of this design relies on a new env var.

## Risks / Trade-offs

- **[Risk]** A hook/plugin/provider POST fires _before_ the bridge has written the correlation file for a freshly-opened project directory (bridge not started yet, or slower to start than the first lifecycle event) → that one POST omits `bridgeInstanceId`. **Mitigation**: harmless partial-coverage window — subsequent POSTs in the same session (there are always more than one: start, summary/end) pick it up once the file exists. Falls back to today's behavior for that single POST, not a regression.
- **[Risk]** Stale correlation file from a killed/crashed bridge process (file never cleaned up) could tag a POST with an instance id whose session has already ended. **Mitigation**: § Decision 5 — the server only uses the header if it resolves to a _currently active_ session; an ended/nonexistent match falls through to the existing chain.
- **[Trade-off]** Same-client, same-cwd, concurrent windows remain ambiguous (both share the same correlation file; the later-spawned bridge's instance id wins for both). **Accepted because**: closing this needs a genuine per-running-instance identifier per client, which is a materially bigger, per-client research effort (does Claude Code/Codex/opencode/Hermes expose anything, to both a hook subprocess and the MCP bridge subprocess, that identifies "this specific running instance" rather than "this project directory"?) that was explicitly scoped out during `/opsx:explore` — this residual case is narrower and lower-stakes than the cross-client case this change closes.
- **[Trade-off]** One additive schema migration (nullable column) where the original proposal assumed none. **Accepted because**: it's a plain `ADD COLUMN` (no rebuild dance per `CLAUDE.md`'s migration-runner rules), and it's materially simpler and more durable than a second in-memory router (Decision 4).

## Migration Plan

1. Server: migration adds `agent_sessions.bridge_instance_id` (nullable text); repository/service accept it on session create/update; `resolveSessionId`/`resolveActiveSessionId` gain the new precedence step. Fully backward compatible — old clients that never send the header are unaffected (column stays null, existing fallback chain unchanged).
2. `rembric-bridge.mjs`: generate + write instance id, forward header. Ships to all three bridge-consuming clients (Claude Code, Codex, opencode) simultaneously since they share the file.
3. Per-client lifecycle code: Claude Code/Codex hook scripts, opencode `plugin.ts`, Hermes provider — each reads the correlation file and adds `bridgeInstanceId` to its existing POSTs.
4. Rollout is independently revertable per layer: server-side change is inert until clients send the header; client-side changes are inert until the server understands the field. No coordinated flag day required.
5. Rollback: revert the relevant commits; the nullable column can remain unused/ignored indefinitely (no cleanup migration required for a rollback).

## Open Questions

- Whether a future change should chase the same-client/same-cwd/concurrent-windows case, and if so, what per-client instance identifier would work (needs its own investigation per client — not answered here).
- Exact correlation-file staleness/cleanup policy (e.g., should the bridge delete its file on clean shutdown? Given the file is overwritten on next bridge spawn regardless, this is a minor hygiene question, not a correctness one — left to implementation-time judgment during `/opsx:apply`).
