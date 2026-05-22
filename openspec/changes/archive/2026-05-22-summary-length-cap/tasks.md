## 1. Constant + service-layer validation

- [ ] 1.1 In `apps/server/src/services/agent-sessions.ts`, export `SUMMARY_MAX_CHARS = 2000`.
- [ ] 1.2 Add an internal `truncateSummary(s: string): string` helper that returns `s` unchanged when `s.length <= SUMMARY_MAX_CHARS`, else `s.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + SUFFIX` where `SUFFIX = '…[truncated]'`. Export it for HTTP-layer use.
- [ ] 1.3 In `writeSummary`, after the existing `summary.trim().length === 0` check, add `if (input.summary.length > SUMMARY_MAX_CHARS) throw new DomainError('invalid_input', ...)` with a message containing the literal `'2000'`.
- [ ] 1.4 Apply the same upper-bound check in `end()` and `summarize()` (back-compat wrapper).
- [ ] 1.5 Confirm `composeDerivedSummary` output stays well under the cap (auto-curate path is untouched).

## 2. MCP zod schema + tool descriptions

- [ ] 2.1 In `apps/server/src/mcp/sessions-tools.ts`, import `SUMMARY_MAX_CHARS` and set `sessionSummarySchema.summary = z.string().min(1).max(SUMMARY_MAX_CHARS)`.
- [ ] 2.2 In `apps/server/src/mcp/server.ts`, update the `memory.session_summary` tool description (line ~158-163) to state the cap and that overflow returns `invalid_input`.
- [ ] 2.3 In `apps/server/src/mcp/instructions.ts`, update the `BASE` string's session-close protocol sentence to include `≤2000 chars` inline. Keep total length ≤800 chars per variant (existing `INSTRUCTIONS_MAX_LENGTH` test must stay green).

## 3. HTTP handler truncation

- [ ] 3.1 In `apps/server/src/server/api-router.ts`, keep `sessionSummarySchema.summary` and `sessionEndSchema.summary` zod max at `20_000` (wire DoS guard).
- [ ] 3.2 In the `POST /:slug/sessions/:id/summary` handler, replace `parsed.data.summary` with `truncateSummary(parsed.data.summary)` before the `agentSessions.writeSummary` call.
- [ ] 3.3 In the `POST /:slug/sessions/:id/end` handler, apply the same truncation when `parsed.data.summary !== undefined` before the `agentSessions.end` call.
- [ ] 3.4 Add inline comment at each call site referencing the SUMMARY_MAX_CHARS / SUFFIX constants and the asymmetry vs MCP (reject vs truncate).

## 4. DB migration `0010_summary_length_check.sql`

- [ ] 4.1 Catalogue every CREATE INDEX, CREATE TRIGGER, and FOREIGN KEY declaration that touches the `sessions` table across `0003_sessions_and_slugs.sql` and any later migration (e.g., `0007_sessions_title_and_final_flags.sql`).
- [ ] 4.2 Write `apps/server/src/db/migrations/0010_summary_length_check.sql`: `PRAGMA foreign_keys = OFF; BEGIN;` → `UPDATE sessions SET summary = substr(summary, 1, 1987) || '…[truncated]' WHERE summary IS NOT NULL AND length(summary) > 2000;` → `CREATE TABLE sessions_new (… + CHECK (summary IS NULL OR length(summary) <= 2000) …);` → `INSERT INTO sessions_new SELECT * FROM sessions;` → `DROP TABLE sessions;` → `ALTER TABLE sessions_new RENAME TO sessions;` → recreate every index/trigger from 4.1 → `COMMIT; PRAGMA foreign_keys = ON;`.
- [ ] 4.3 Audit `apps/server/src/scripts/seed-dev.ts` for any seeded `summary` exceeding 2000 chars — shorten at the source so the seed survives the new CHECK.
- [ ] 4.4 Audit test fixtures (`apps/server/src/**/*.test.ts`, `apps/server/src/test/fixtures/*`) for hard-coded summaries exceeding 2000 chars — shorten or replace with `'A'.repeat(2000)` style.
- [ ] 4.5 Verify schema in `apps/server/src/db/schema/agent-sessions.ts` reflects the constraint declaratively if drizzle's `text(...).check(...)` API supports it; otherwise rely on the raw migration and document the divergence in a comment.

## 5. Plugin protocol nudges

- [ ] 5.1 Update `apps/plugin/scripts/post-compact.sh`'s heredoc protocol block to mention `≤2000 chars` on the `summary` field. Keep total output ≤120 tokens.
- [ ] 5.2 Update `apps/plugin/.hermes-plugin/__init__.py` (region around line 313) to include `≤2000 chars` in the session-close protocol sentence.
- [ ] 5.3 Update `apps/plugin/commands/summary.md` description to mention the cap.
- [ ] 5.4 Adjust the comment in `apps/plugin/scripts/_transcript.sh` (line ~31) so the "server caps summary at 20000 chars" remark reads accurately (server now caps at 2000; bash tail stays as a wire upper bound).

## 6. Tests

- [ ] 6.1 `apps/server/src/services/agent-sessions.test.ts`: add cases for `writeSummary` / `end` / `summarize` rejecting `summary.length > SUMMARY_MAX_CHARS`; verify the error message contains `'2000'`; verify the row is unchanged. Add a positive case at exactly `SUMMARY_MAX_CHARS`.
- [ ] 6.2 `apps/server/src/mcp/sessions-tools.test.ts` (or the integration test file that exercises MCP zod): add a case for `memory.session_summary` with `summary` of length 2001 → `invalid_input` from zod boundary.
- [ ] 6.3 `apps/server/src/server/api-router.test.ts`: add cases for `POST /sessions/:id/summary` and `POST /sessions/:id/end` with `summary` of length 5000 → response 200, row.summary length === 2000 with `…[truncated]` suffix; case for 20001 → 400 invalid_input at zod boundary.
- [ ] 6.4 `apps/server/src/db/migrations.test.ts` (or new `apps/server/src/db/__tests__/0010_summary_length_check.test.ts`): seed 3 rows (lengths 500, 2001, 7500), run migration, assert all rows length ≤ 2000 and the latter two end with the suffix; then attempt direct `INSERT INTO sessions … summary = 'A'.repeat(2001)` and assert `SQLITE_CONSTRAINT_CHECK`.
- [ ] 6.5 `apps/server/src/mcp/instructions.test.ts`: extend the existing length test to also assert both `BASE` variants contain the substring `'2000'`.
- [ ] 6.6 Existing `apps/plugin/.hermes-plugin/tests/test_lifecycle_calls.py` cases that POST 20 000-byte summaries: update assertions to account for server-side truncation (or note that the existing 20 000 stays as a wire bound and the server truncates).

## 7. Validation gates

- [ ] 7.1 `pnpm run typecheck` clean.
- [ ] 7.2 `pnpm run lint` clean.
- [ ] 7.3 `pnpm test` clean (server + hermes workspaces).
- [ ] 7.4 `openspec validate summary-length-cap --strict` clean.
- [ ] 7.5 Smoke against `pnpm run dev:docker:up`: from a fresh `/mcp/demo` session, send a 5 000-char body via `memory.session_summary` → expect `invalid_input`; send same body via `POST /api/demo/sessions/<id>/summary` → expect 200 OK and `length(summary) === 2000` with `…[truncated]` suffix in DB; verify `/dashboard/sessions` renders the truncated row cleanly.

## 8. Land

- [ ] 8.1 Branch `feat/summary-length-cap` (use `git worktree add ../rembric-summary-cap feat/summary-length-cap`).
- [ ] 8.2 Stage changes selectively (no `git add -A`): server files, plugin files, migration, openspec change directory.
- [ ] 8.3 Conventional Commits: `feat(sessions)!: cap session.summary at 2000 chars (DB CHECK + reject/truncate)` for the main commit. Migration callout in the body.
- [ ] 8.4 Push branch + open PR. Body MUST flag the destructive migration ("Existing sessions with summary > 2000 chars are truncated in-place; back up before deploying") and reference this change directory.
- [ ] 8.5 Post-merge: `/opsx:archive summary-length-cap` to sync the deltas into `openspec/specs/` and move the change directory under `openspec/changes/archive/`.
