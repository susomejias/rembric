## 1. Extract the shared predicate

- [x] 1.1 In `apps/server/src/services/agent-sessions.ts`, add a private `sessionHasContentSql(alias: string)` helper that returns the SQL fragment defined in design.md Decision 3. The helper SHALL NOT be exported.
- [x] 1.2 Co-located unit tests in `apps/server/src/services/agent-sessions.test.ts` exercising the helper directly via a tiny seed: (a) session with `summary='x'` → true, (b) session with `title_final=1` → true, (c) session with one memory row → true, (d) session with one prompt → true, (e) session with one confirmation → true, (f) session with all the above absent → false.

## 2. Refactor purge call-sites to consume the helper

- [x] 2.1 Replace the inline content predicate in `AgentSessionsService.countPurgeableEmpty` with `AND NOT ${sessionHasContentSql('s')}`. Keep the surrounding `status IN ('ended','abandoned') AND deleted_at IS NULL AND ended_at < ${cutoff}` clauses untouched.
- [x] 2.2 Replace the inline content predicate in `AgentSessionsService.purgeEmpty` with `AND NOT ${sessionHasContentSql('s')}`. Verify the surrounding transaction + `consolidation_ops` insert remain unchanged.
- [x] 2.3 Add a behavior-parity regression test: seed a fixture with one purgeable empty + one non-purgeable (has memory) + one non-purgeable (has summary). Assert `countPurgeableEmpty() === 1`, then `purgeEmpty({adminBypass:true}).deletedIds.length === 1`, and that the surviving rows are untouched.

## 3. Apply the predicate to `recentForContext`

- [x] 3.1 In `AgentSessionsService.recentForContext`, add `AND ${sessionHasContentSql('sessions')}` to the WHERE clause (drizzle uses the table name `sessions` as the implicit alias). Preserve the existing `isNull(agentSessions.deletedAt)` filter.
- [x] 3.2 Confirm the resulting query is filter-then-truncate (Option B): the predicate is in the WHERE clause, ORDER BY follows, LIMIT applies last. Do NOT wrap the existing query in a subquery.
- [x] 3.3 Unit tests in `agent-sessions.test.ts`:
  - Empty active session (no memories, no prompts, no summary) is NOT returned.
  - Active session with one memory anchored to it IS returned.
  - Ended session with a summary IS returned.
  - With three empty sessions starting at t1<t2<t3 and one useful session at t0, requesting limit:1 returns the useful one at t0 (backfill semantics).
  - Soft-deleted session with content is NOT returned (existing behavior preserved).

## 4. Integration test for `memory.context`

- [x] 4.1 The existing test at line 257 of `apps/server/src/test/mcp-integration.test.ts` already saves a memory AND writes a summary before calling `memory.context`, so it satisfies the `sessionHasContent` predicate as-is. A clarifying comment was added; no behavioural change needed.
- [x] 4.2 Add a new integration scenario: start a session, end it WITHOUT writing memories or a summary, then call `memory.context` — assert the empty session does NOT appear in `recentSessions`.
- [x] 4.3 Add a new integration scenario: in a scope with N=3 empty sessions in front of one useful one, call `memory.context({sessions: 1})` — assert the response contains exactly the useful session.

## 5. Spec deltas

- [x] 5.1 Run `openspec validate filter-empty-sessions-from-context --strict` and resolve any reported drift. The actual application of the deltas to `openspec/specs/sessions/spec.md` and `openspec/specs/mcp-api/spec.md` is handled by `openspec archive` at archive time (task 6.6), not during apply.

## 6. Verify and ship

- [x] 6.1 `pnpm run typecheck` clean.
- [x] 6.2 `pnpm -w run lint` clean.
- [x] 6.3 `pnpm test` clean (40 test files / 476 tests passing).
- [ ] 6.4 Manual smoke: `pnpm run dev:docker:up`, watch for default seed data, then from a Claude Code session call `memory.context` and inspect `recentSessions` — confirm noise is gone. _(deferred; will run from the worktree before merging)_
- [x] 6.5 Conventional Commit message naming the changed surface: `feat(sessions): filter empty sessions out of memory.context recentSessions`.
- [x] 6.6 Archive the change as part of the PR: `openspec archive filter-empty-sessions-from-context` applies the spec deltas to canonical `openspec/specs/sessions/spec.md` and `openspec/specs/mcp-api/spec.md` and moves the change folder to `openspec/changes/archive/<date>-filter-empty-sessions-from-context/`.
