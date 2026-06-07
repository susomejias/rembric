## Why

Multi-agent / cross-client handoff — continuing in Codex (or any client) work started in Claude Code — relies on the session summary as the bridge, because the new client inherits none of the prior client's in-context state. Today that bridge is doubly limited: the stored summary is capped at 2000 chars, and even within that cap the only agent-facing surface (`memory.context`) now returns just a 350-char snippet (per the `snippet-context-session-summaries` change). There is **no MCP tool for an agent to read a session's full summary** — `memory.get` is memory-only; `memory.timeline` returns memory neighbours. So richer summaries are both disallowed (cap) and unreachable (no fetch).

The snippet change already decoupled stored summary size from `memory.context` token cost, so the 2000-char cap's original justification (bounding context) is gone. The cap now only bounds storage, and it is duplicated in two places (a SQLite `CHECK` and the server constant). This change makes summaries rich enough for handoff and reachable on demand.

## What Changes

- **Move the summary cap from the database to the server.** Drop the SQLite `CHECK (length(summary) <= 2000)` (added in migration `0011`) via a table-rebuild migration. The cap then lives **only** in `SUMMARY_MAX_CHARS` (already imported by the service, MCP zod schema, and HTTP truncation), making it a tunable: future cap changes become a one-line constant edit with **no further table rebuilds**. **BREAKING** for nothing on the wire — purely an internal constraint move.
- **Raise `SUMMARY_MAX_CHARS`** to a value generous enough for a rich, multi-field handoff summary. Recommended default **10000** (the HTTP layer already accepts up to 20000 before truncating). **OPEN DECISION (see design):** exact value, and whether to keep a very generous DB `CHECK` (e.g. 1 MB) as a pathological-size guard versus a pure server-only cap.
- **Add a new MCP tool `memory.session_get`** that returns a single session (by id) with its **full, untruncated** summary, scope-enforced. `memory.context` keeps emitting the 350-char snippet; agents call `memory.session_get` when the snippet is not enough (e.g. resuming a session surfaced in context). New MCP tool ⇒ this proposal is the required OpenSpec change for it.

## Capabilities

### New Capabilities

<!-- none — extends the existing sessions capability -->

### Modified Capabilities

- `sessions`: (1) the summary-length cap requirement changes from "DB `CHECK` + service + zod + HTTP all pinned to 2000" to "enforced solely in the server at `SUMMARY_MAX_CHARS`; no DB `CHECK` pins the value" (with the value raised). (2) Adds a new requirement for a `memory.session_get` tool that returns a session's full summary by id under the documented scope-resolution precedence (cross-scope ids ⇒ `not_found`).

## Impact

- **DB migration**: new migration performing the FK-safe table-rebuild dance on `sessions` to recreate it **without** the `summary` `CHECK` (and, if chosen, with a generous guard `CHECK`). Follows the `migrate.ts` contract (runner wraps `PRAGMA foreign_keys=OFF` → `BEGIN IMMEDIATE` → body → `foreign_key_check` → `COMMIT`); author adds no pragmas. **No data loss** — relaxing a constraint never rejects existing rows; `INSERT … SELECT` copies all; the migration is transactional.
- **Schema**: `apps/server/src/db/schema/agent-sessions.ts` — drop the `summary` `CHECK` annotation (or widen it to the guard value).
- **Cap constant**: `apps/server/src/services/agent-sessions.ts` — raise `SUMMARY_MAX_CHARS`; it remains the single source consumed by the service, MCP zod schema (`mcp/sessions-tools.ts`), and HTTP truncation (`server/api-router.ts`).
- **New tool**: `apps/server/src/mcp/server.ts` (register `memory.session_get` + description) and `apps/server/src/mcp/sessions-tools.ts` (handler resolving scope via `scopeFromContext` / `resolveEffectiveProject`, reusing `AgentSessionsService.getById`, returning `not_found` cross-scope/soft-deleted).
- **Spec**: `openspec/specs/sessions/spec.md` — update the summary-cap requirement; add the `memory.session_get` requirement and its scope-resolution scenario.
- **Invariants**: append-only memory untouched (sessions are mutable by design via `summary_final` precedence). The rebuild is governed by the existing `migration runner FK-safety` invariant test.
- **No impact**: the four plugin clients (POST-and-forget; none read summaries back), the `memory.context` snippet behaviour (unchanged — still 350), and the HTTP write contract (field names/shape unchanged).
