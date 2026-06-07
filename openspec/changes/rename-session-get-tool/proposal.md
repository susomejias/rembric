## Why

The session-lifecycle MCP tools are named `memory.session_start`, `memory.session_end`, `memory.session_summary` — a `memory.session_*` family. The full-summary fetch tool shipped (in server-v0.21.7) as `memory.get_session`, breaking that pattern. Renaming it to `memory.session_get` restores one consistent family. It is **not** a breaking change in practice: the tool was released ~1 day ago with no adopters, and no plugin client references it (verified by grep over `apps/plugin/`).

## What Changes

- Rename the MCP tool **`memory.get_session` → `memory.session_get`** (the wire-level tool name in `apps/server/src/mcp/server.ts`).
- Rename the internal symbols to match the family convention (`handleSessionSummary`/`sessionSummarySchema`/`sessionSummary`), confined to `apps/server/src/mcp/{server,sessions-tools}.ts`:
  - `getSessionSchema` → `sessionGetSchema`
  - `handleGetSession` → `handleSessionGet`
  - builder key `getSession` → `sessionGet` (and call site `sessions.getSession` → `sessions.sessionGet`)
- Update the integration tests, the `sessions` spec requirement, the doc-comments (migration `0012`, `db/schema/agent-sessions.ts`), and the docs (README tool box, `docs/agents.md`).
- No behavior change, no migration, no data change. `feat(server)` commit, **not** flagged breaking.
- **Out of scope / must NOT touch**: the unrelated dashboard `getSession(c: Context)` cookie-session resolver (~40 occurrences across `src/dashboard/*.ts`). A blind rename would corrupt it.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `sessions`: the requirement that defines the full-summary fetch tool is renamed from `memory.get_session …` to `memory.session_get …` (same behavior, scope-resolution, and `not_found` semantics — only the tool name changes).

## Impact

- **Code**: `apps/server/src/mcp/server.ts` (registered name + import + schema/handler refs), `apps/server/src/mcp/sessions-tools.ts` (schema, handler, builder key).
- **Tests**: `apps/server/src/test/mcp-integration.test.ts` (4 tool-call names + comments/titles).
- **Spec**: `openspec/specs/sessions/spec.md` — rename the `memory.get_session` requirement to `memory.session_get`.
- **Doc-comments**: `apps/server/src/db/migrations/0012_drop_summary_length_check.sql`, `apps/server/src/db/schema/agent-sessions.ts`.
- **Docs**: `README.md` (tool box row — `memory.session_get` is also 18 chars, so the 76-col box alignment is unchanged), `docs/agents.md` (_Reading prior context_ section). These docs were introduced (with the old name) on the current branch / PR #118; this change updates them to the final name.
- **Archived change docs**: realign `get_session` → `session_get` in `openspec/changes/archive/2026-06-07-rich-session-summaries-for-handoff/*` for record consistency.
- **No impact**: `apps/server/CHANGELOG.md` (0.21.7 is historical; the next release records the rename from the new commit), DB schema/migrations behavior, the four plugin clients (none call the tool), and every other MCP tool.
- **Invariants**: none touched (append-only, scope-at-service, `topic_key`, judgment freshness all unaffected — pure surface rename).
