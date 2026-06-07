## Context

A session summary is the only bridge across a multi-agent / cross-client handoff: a new client (e.g. Codex resuming Claude Code's work) inherits no in-context state, only what Rembric surfaces. After `snippet-context-session-summaries`, `memory.context` returns a 350-char snippet of the summary, and there is no MCP tool to fetch the full summary (verified: `memory.get` is memory-only; `memory.timeline` returns memory neighbours). The stored summary is also capped at 2000 chars, enforced redundantly by a SQLite `CHECK (length(summary) <= 2000)` (migration `0011`) and the server constant `SUMMARY_MAX_CHARS`.

Because the snippet change decoupled stored size from `memory.context` token cost, the 2000 cap no longer protects context; it only bounds storage, redundantly. This change makes summaries rich enough to carry a handoff and reachable on demand.

## Goals / Non-Goals

**Goals:**

- Allow richer stored summaries (raise the cap) without re-inflating `memory.context` (the snippet already bounds it).
- Make the cap a server-side tunable: change it by editing one constant, with no future table rebuilds.
- Give agents a way to read a session's full summary on demand for handoff.

**Non-Goals:**

- Changing `memory.context` behaviour (still returns the 350-char snippet).
- Touching the four plugin clients (POST-and-forget; none read summaries back).
- Append-only changes (sessions are mutable by design; this does not alter that).
- A second summary column or agent-authored condensed text (that path stays parked).

## Decisions

**Decision 1 — Drop the DB `CHECK`; enforce the cap solely in the server.**
A table-rebuild migration recreates `sessions` without the `summary` `CHECK`. The cap then lives only in `SUMMARY_MAX_CHARS` (already consumed by the service, MCP zod, and HTTP truncation).

- _Why:_ SQLite cannot relax a `CHECK` in place; keeping it means a table rebuild for every cap change. Moving enforcement to the server makes the cap a one-line tunable forever after this one rebuild.
- _Alternative — keep the DB `CHECK` and rebuild whenever the cap changes:_ rejected; recurring rebuild cost and risk for a value that is purely a server policy.
- _Alternative — keep duplicating (CHECK at the new value):_ rejected; same drift/rebuild problem, just at a higher number.

**Decision 2 — New cap value. (OPEN — recommend 10000.)**
The HTTP layer already accepts up to 20000 before truncating; 10000 leaves headroom while comfortably carrying a rich multi-field handoff summary. Alternatives: keep 2000 (defeats the purpose), 8000 (more conservative), 20000 (match the HTTP ceiling). Unbounded is rejected — a sanity ceiling protects storage and the context snippet's source. **Final value to be confirmed before/at apply.**

**Decision 3 — Pure server-only cap vs a generous DB guard. (OPEN — recommend pure server-only.)**
Pure server-only is simplest and matches the "cap is server policy" framing. A generous guard `CHECK` (e.g. `length(summary) <= 1048576`) would re-add a pathological-size backstop at the DB without pinning the operative cap (it would essentially never change, so no recurring rebuilds). Trade-off: the guard restores a last-line integrity net at the cost of one more constraint to reason about. **To be confirmed at apply.**

**Decision 4 — A dedicated `memory.session_get` tool, not an overload of `memory.get`.**
`memory.get` is contractually memory-row-only (cross-scope/unknown ids → `not_found`); overloading it with session semantics would muddy that contract. A dedicated tool is clearer and easier to scope-guard.

- _Alternative — extend `memory.context` with a per-session full-fetch flag:_ rejected; context is a batch awareness payload, not a by-id fetch, and a flag that un-truncates would re-create the token cost we removed.
- _Alternative — return the full summary in `memory.timeline`:_ rejected; timeline is about memory neighbours, not the session record.

**Decision 5 — `memory.session_get` returns a bounded session projection.**
Return id, agent, status, started/ended timestamps, title, and the full `summary` — reusing `AgentSessionsService.getById` plus scope/soft-delete checks. Read-only.

## Risks / Trade-offs

- **[Trade-off] Removing the DB `CHECK` drops the last-line integrity net for summary length** → Mitigated: CLAUDE.md confines all SQL to `db/`, every write goes through `AgentSessionsService` which enforces `SUMMARY_MAX_CHARS`, and there is no raw write path. Optionally restored by the Decision-3 guard `CHECK`.
- **[Risk] Table-rebuild data loss / corruption** → Mitigated: relaxing a constraint rejects no existing rows; `INSERT … SELECT` copies all; the `migrate.ts` runner wraps the body in `PRAGMA foreign_keys=OFF` → `BEGIN IMMEDIATE` → `PRAGMA foreign_key_check` (pre-commit gate) → `COMMIT`, so it is atomic, and the `migration runner FK-safety` invariant test guards the pattern. The rebuild must recreate all indexes/triggers on `sessions`.
- **[Risk] `memory.session_get` leaks cross-scope session content** → Mitigated: the handler resolves scope via the documented precedence and returns `not_found` for out-of-scope or soft-deleted ids, mirroring `memory.get`.
- **[Trade-off] Larger stored summaries cost more disk and more tokens _when fetched in full_** → Accepted: full fetch is opt-in (`memory.session_get`), so the cost is paid only when an agent deliberately pulls the full text for a handoff; `memory.context` stays cheap.

## Migration Plan

1. Add a migration that rebuilds `sessions` without the `summary` `CHECK` (optionally with the generous guard `CHECK` from Decision 3): `CREATE TABLE sessions_new (… no value-pinning CHECK …)` → `INSERT INTO sessions_new SELECT * FROM sessions` → `DROP TABLE sessions` → `ALTER TABLE sessions_new RENAME TO sessions` → recreate all indexes/triggers. No manual pragmas (the runner supplies them).
2. Raise `SUMMARY_MAX_CHARS` to the Decision-2 value.
3. Register and implement `memory.session_get`.

**Rollback:** revert the constant and the tool registration; the migration itself is forward-only (a relaxed constraint is harmless to leave in place). No data is lost in either direction.

## Open Questions

- **Cap value** (Decision 2): 10000 recommended — confirm.
- **Guard `CHECK`** (Decision 3): pure server-only vs a 1 MB pathological guard — confirm.
- **Tool name / projection** (Decisions 4–5): `memory.session_get` and the returned fields — confirm naming and whether to include anything beyond `{ id, agent, status, startedAt, endedAt, title, summary }`.
