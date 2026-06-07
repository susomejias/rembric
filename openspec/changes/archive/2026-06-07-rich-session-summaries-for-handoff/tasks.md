## 0. Confirm open decisions (before coding)

- [x] 0.1 `SUMMARY_MAX_CHARS` = **10000**.
- [x] 0.2 **Pure server-only** — drop the `summary` length `CHECK` entirely; no DB guard `CHECK`.
- [x] 0.3 Tool name **`memory.get_session`**, projection `{ id, agent, status, startedAt, endedAt, title, summary }`.

## 1. Database: drop the value-pinning CHECK

- [x] 1.1 Add a migration under `apps/server/src/db/migrations/` that rebuilds `sessions` without the `summary` length `CHECK` (optionally with the agreed pathological guard `CHECK`): `CREATE TABLE sessions_new (…)` → `INSERT INTO sessions_new SELECT * FROM sessions` → `DROP TABLE sessions` → `ALTER TABLE sessions_new RENAME TO sessions` → recreate every index/trigger on `sessions`. Add no manual pragmas (the runner wraps FK-off / `BEGIN IMMEDIATE` / `foreign_key_check` / `COMMIT`).
- [x] 1.2 Update `apps/server/src/db/schema/agent-sessions.ts` so the Drizzle schema matches the rebuilt table (drop or widen the `summary` `CHECK` annotation; update the column doc-comment that references the 2000 cap).

## 2. Server: cap becomes a tunable constant

- [x] 2.1 Raise `SUMMARY_MAX_CHARS` in `apps/server/src/services/agent-sessions.ts` to the confirmed value; verify the MCP zod schema (`mcp/sessions-tools.ts`) and HTTP truncation (`server/api-router.ts`) still import it (no literal duplication).

## 3. New MCP tool: memory.get_session

- [x] 3.1 Register `memory.get_session` in `apps/server/src/mcp/server.ts` with an input schema `{ sessionId: string }` and a description noting it returns the FULL summary (vs the `memory.context` snippet).
- [x] 3.2 Implement the handler in `apps/server/src/mcp/sessions-tools.ts`: resolve scope via `scopeFromContext` / `resolveEffectiveProject`, load via `AgentSessionsService.getById`, return `not_found` when the row is missing, out-of-scope (`project_id` mismatch), or soft-deleted; otherwise return `{ id, agent, status, startedAt, endedAt, title, summary }` with the full untruncated `summary`. Read-only.

## 4. Tests

- [x] 4.1 Migration test: a `sessions` row with a 2000-char summary survives the CHECK-drop rebuild; `PRAGMA foreign_key_check` is clean; indexes/triggers exist post-migration.
- [x] 4.2 Cap test: `writeSummary`/`end`/`summarize` accept a summary at the new `SUMMARY_MAX_CHARS` and reject `SUMMARY_MAX_CHARS + 1` with `DomainError('invalid_input')` whose message contains the cap value; no DB `CHECK` rejects a value at the cap.
- [x] 4.3 `memory.get_session` test (in `apps/server/src/test/mcp-integration.test.ts`): returns the full (untruncated) summary for an in-scope session, while the same session via `memory.context` is the 350-char snippet.
- [x] 4.4 Scope tests: `memory.get_session` returns `not_found` for a cross-scope id and for a soft-deleted session.

## 5. Spec & verification

- [ ] 5.1 Sync `openspec/specs/sessions/spec.md` per the delta (MODIFIED cap requirement; ADDED `memory.get_session` requirement) at archive time.
- [x] 5.2 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 5.3 `pnpm test` (full suite) green, including the migration applied against a seeded DB.
- [ ] 5.4 Smoke against `pnpm run dev:docker:up`: migration applies cleanly on boot; `memory.get_session` returns full summary; `memory.context` still snippets.
- [x] 5.5 `openspec validate rich-session-summaries-for-handoff --strict` passes.
