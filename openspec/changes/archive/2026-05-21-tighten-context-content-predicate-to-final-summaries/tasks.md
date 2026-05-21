## 1. Split the predicate

- [x] 1.1 In `apps/server/src/services/agent-sessions.ts:26-34`, add a new SQL fragment helper `sessionIsContextWorthySql(alias: 's' | 'sessions')` returning `((${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1) OR ${alias}.title_final = 1)`.
- [x] 1.2 Update the JSDoc on `sessionHasContentSql` to clarify its purge-only scope, and reference `sessionIsContextWorthySql` as the surfacing counterpart.
- [x] 1.3 In `recentForContext` (same file, ~line 416-429), replace `sessionHasContentSql('sessions')` in the WHERE clause with `sessionIsContextWorthySql('sessions')`.
- [x] 1.4 Confirm `countPurgeableEmpty` and `purgeEmpty` keep consuming `sessionHasContentSql('s')` unchanged.

## 2. Harden the HTTP path

- [x] 2.1 Locate the zod body schemas `sessionSummarySchema` and `sessionEndSchema` (likely in `apps/server/src/mcp/sessions-tools.ts` or `apps/server/src/server/schemas.ts`). Remove the `final` field from both.
- [x] 2.2 In `apps/server/src/server/api-router.ts:118-123` (handler for `POST /:slug/sessions/:id/summary`), replace `final: parsed.data.final` with `final: false`.
- [x] 2.3 In `apps/server/src/server/api-router.ts:153-160` (handler for `POST /:slug/sessions/:id/end`), replace `final: parsed.data.final` with `final: false`.
- [x] 2.4 Verify `apps/server/src/mcp/sessions-tools.ts:406-411` (`memory.session_summary` MCP handler) STILL hard-codes `final: true` — it remains the sole writer that lifts the flags.

## 3. Service-layer unit tests

- [x] 3.1 In `apps/server/src/services/agent-sessions.test.ts`, inside the existing `describe('recentForContext content filter (sessionHasContent predicate)')` block: rename the describe to `recentForContext content filter (sessionIsContextWorthy predicate)`.
- [x] 3.2 In the same describe block, FLIP the assertion of the existing test `includes a session referenced by at least one memory row` (lines ~485-495) to `excludes a session referenced ONLY by memory rows (memory still surfaces via recentMemories[])` — assert `recent.some(r => r.id === s.id)` is `false`.
- [x] 3.3 Same for `includes a session referenced by at least one prompt row` (lines ~497-507) and `includes a session referenced by at least one confirmation row` (lines ~509-526). Flip both to "excludes".
- [x] 3.4 Add a new test `excludes a session whose only content is a final:false summary`: start a session, call `writeSummary({ summary: 'raw transcript', final: false })`, assert NOT in `recentForContext` result.
- [x] 3.5 Add a new test `includes a session with curated summary (final:true)`: start a session, call `writeSummary({ summary: 'Goal: x', final: true })`, assert IN `recentForContext` result.
- [x] 3.6 Add a new test in a separate describe block (`purge protection vs surfacing asymmetry`): start a session, write a memory row referencing it, advance time past 1h grace, end the session. Assert (a) `countPurgeableEmpty()` returns 0 (session is purge-protected by EXISTS memory), AND (b) `recentForContext` does NOT include the session (no curation).
- [x] 3.7 Confirm the existing test `includes a session that has a summary written` (uses `sessions.summarize()` which sets `final:true` via back-compat wrapper) STILL passes — no change needed.

## 4. HTTP-layer test updates

- [x] 4.1 In `apps/server/src/server/api-router.test.ts`, audit every test that POSTs `{ final: true }` (lines ~217, ~263-281, ~379-384) and migrate them: replace the "set up locked state via HTTP `final:true` POST" with "set up locked state via the service layer (agentSessions.writeSummary with final:true), which is the only legitimate path".
- [x] 4.2 Add a new test `HTTP body final:true is silently ignored on /summary`: POST `{ summary, title, final: true }` to `/api/foo/sessions/<S>/summary` on a fresh active session; assert response has `summaryFinal: false`, `titleFinal: false`; assert DB row matches.
- [x] 4.3 Add a new test `HTTP body final:true is silently ignored on /end`: same shape, against `/api/foo/sessions/<S>/end`.
- [x] 4.4 Update any test that asserts the body schema accepts `final` to assert that zod rejects an unknown field if `strict()` is in use, OR that the field is silently dropped (depending on the schema definition style). [Zod's default object behavior silently strips unknown fields, so the assertion is just that the field has no effect.]

## 5. MCP integration tests

- [x] 5.1 In `apps/server/src/test/mcp-integration.test.ts`, add a new scenario alongside `memory.context excludes a session ended without memories or summary` (around line 277): scenario `memory.context excludes a session with anchored memory but no curated summary, while the memory itself surfaces in recentMemories`. [Placed AFTER the candidates test to avoid polluting the FTS5 BM25 corpus that the candidates test relies on.]
- [x] 5.2 Within the new scenario: `memory.session_start` → `memory.save({content})` (auto-anchors to session) → `memory.session_end` (without prior `memory.session_summary`). Assert (a) `ctx.recentSessions.some(s => s.id === sessionId)` is `false`, AND (b) `ctx.recentMemories.some(m => m.id === savedMemoryId)` is `true`.
- [x] 5.3 Verify the existing scenarios `memory.context returns a bootstrap snapshot` (line 257-272) and `memory.context excludes a session ended without memories or summary` (line 277-302) STILL pass under the new predicate — the first uses `memory.session_summary` (`final:true`), the second has no content at all.
- [x] 5.4 Update the existing `memory.context backfills past empty sessions to return useful older ones` to call `memory.session_summary` (the only path to curation under the new contract). Renamed to `...curated older ones`.

## 6. Server-side auto-curate at terminal transition

- [x] 6.1 In `apps/server/src/services/agent-sessions.ts`, add a pure helper `composeDerivedSummary(counts, lastMemoryContent)` returning the exact template `[auto] N memorias[, P prompts[, C confirmaciones]][ — última: '<snippet of lastMemoryContent>']`. Use `snippet(text, 80)` for truncation. Function is exported for unit testing.
- [x] 6.2 Add a private helper `computeAutoCurate(sessionId)` that: (a) counts anchored rows in `memory`, `prompts` (where deleted_at IS NULL), `confirmations` referencing the session, (b) returns null if total = 0, (c) SELECTs the most recent memory content, (d) composes the derived summary and returns it.
- [x] 6.3 In `end()` active→ended transition: compute `willHaveCuratedSummary` from precedence result; if false, call `computeAutoCurate` and merge the derived summary into the same UPDATE set. Atomic with the status flip.
- [x] 6.4 In `abandonStale()`: convert the bulk UPDATE to a per-row loop. For each stale row, build a set with `status=abandoned` + `ended_at`, and if `summary_final=0` AND `computeAutoCurate` returns a value, add it to the set. UPDATE per row with `WHERE id=? AND status='active'` for concurrency safety. Return the count.
- [x] 6.5 Relax the guard in `writeSummary()`: allow the write when `existing.status !== 'active'` BUT `input.final === true`. Reject only when `existing.status !== 'active' AND input.final !== true`. Adjust the UPDATE WHERE clause accordingly (no `status='active'` gate when overriding a terminal session).
- [x] 6.6 Service-layer tests added (12 new tests covering composeDerivedSummary, end() auto-curate scenarios, abandonStale auto-curate, writeSummary override).
- [x] 6.7 MCP integration test updated: full lifecycle — save memory, end without curation, `memory.context` surfaces the session with `[auto]` prefix.
- [x] 6.8 Existing "asymmetry" test updated to reflect the new behavior: now the session SURFACES after `end()` (via auto-curate) AND remains purge-protected.

## 7. Spec validation

- [x] 7.1 Run `openspec validate tighten-context-content-predicate-to-final-summaries --strict` — must exit clean.
- [x] 7.2 Run `openspec validate --specs --strict` against the change's spec deltas (sessions, mcp-api, http-api) — must exit clean.

## 8. Validation gates

- [x] 8.1 Run `pnpm run typecheck` from repo root — must exit 0.
- [x] 8.2 Run `pnpm run lint` — must exit 0 against the touched files.
- [x] 8.3 Run `pnpm test` — full suite must pass. (540 tests passing, 12 new auto-curate tests added.)

## 9. End-to-end smoke (automated against dev docker stack)

- [x] 9.1 With `pnpm run dev:docker:up` running, drive 3 scenarios via MCP HTTP transport at `/mcp/demo`: - Tipo A: `session_start` → `session_end` (no anchored content, no curate). - Tipo B: `session_start` → `memory.save` → `session_end` (no curate — auto-curate must fire). - Tipo C: `session_start` → `memory.save` → `memory.session_summary` → `session_end` (agent curated).
- [x] 9.2 Call `memory.context({sessions:25, memories:25})` and assert: - Tipo A NOT in recentSessions ✓ - Tipo B IS in recentSessions with `summary` starting with `[auto]` ✓ - Tipo C IS in recentSessions with agent-curated summary ✓ - Memories from B and C surface in recentMemories ✓
- [x] 9.3 Direct SQLite inspection of mounted `data-dev/data.db` confirms DB state: - Tipo A: `summary_final=0, summary=NULL` (excluded from context, eligible for purge) - Tipo B: `summary_final=1, summary='[auto] 1 memorias — última: ...'` - Tipo C: `summary_final=1, summary='Goal: ...'`
- [x] 9.4 Dashboard `/dashboard/sessions` (via admin cookie login) lists ALL 4 smoke sessions including Tipo A — operator visibility preserved.
- [x] 9.5 HTTP hardening verified: POST `/api/demo/sessions/<id>/summary` with body `{"final":true}` returns `summaryFinal:false, titleFinal:false` and the DB row stays `summary_final=0` — the server silently ignores the body field as designed.

## 10. Archive readiness

- [x] 10.1 Confirm there are no untracked artifacts under `openspec/changes/tighten-context-content-predicate-to-final-summaries/` beyond `proposal.md`, `design.md`, `tasks.md`, `specs/sessions/spec.md`, `specs/mcp-api/spec.md`, `specs/http-api/spec.md`.
- [x] 10.2 Confirm the commit message follows Conventional Commits and references the change name.
- [x] 10.3 Run `/opsx:archive tighten-context-content-predicate-to-final-summaries` to move the change to `openspec/changes/archive/` and apply the spec deltas to `openspec/specs/`. (Archived AS PART of this PR — repo flow is archive-before-merge per prior session history.)
