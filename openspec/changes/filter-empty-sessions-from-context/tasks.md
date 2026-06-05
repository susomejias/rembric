## 1. Extract the shared predicate

- [ ] 1.1 In `apps/server/src/services/agent-sessions.ts`, add a private `sessionHasContentSql(alias: string)` helper that returns the SQL fragment defined in design.md Decision 3. The helper SHALL NOT be exported.
- [ ] 1.2 Co-located unit tests in `apps/server/src/services/agent-sessions.test.ts` exercising the helper directly via a tiny seed: (a) session with `summary='x'` → true, (b) session with `title_final=1` → true, (c) session with one memory row → true, (d) session with one prompt → true, (e) session with one confirmation → true, (f) session with all the above absent → false.

## 2. Refactor purge call-sites to consume the helper

- [ ] 2.1 Replace the inline content predicate in `AgentSessionsService.countPurgeableEmpty` with `AND NOT ${sessionHasContentSql('s')}`. Keep the surrounding `status IN ('ended','abandoned') AND deleted_at IS NULL AND ended_at < ${cutoff}` clauses untouched.
- [ ] 2.2 Replace the inline content predicate in `AgentSessionsService.purgeEmpty` with `AND NOT ${sessionHasContentSql('s')}`. Verify the surrounding transaction + `consolidation_ops` insert remain unchanged.
- [ ] 2.3 Add a behavior-parity regression test: seed a fixture with one purgeable empty + one non-purgeable (has memory) + one non-purgeable (has summary). Assert `countPurgeableEmpty() === 1`, then `purgeEmpty({adminBypass:true}).deletedIds.length === 1`, and that the surviving rows are untouched.

## 3. Apply the predicate to `recentForContext`

- [ ] 3.1 In `AgentSessionsService.recentForContext`, add `AND ${sessionHasContentSql('agent_sessions')}` (or whatever alias drizzle generates — check by introspecting the existing query first) to the WHERE clause. Preserve the existing `isNull(agentSessions.deletedAt)` filter.
- [ ] 3.2 Confirm the resulting query is filter-then-truncate (Option B): the predicate is in the WHERE clause, ORDER BY follows, LIMIT applies last. Do NOT wrap the existing query in a subquery.
- [ ] 3.3 Unit tests in `agent-sessions.test.ts`:
  - Empty active session (no memories, no prompts, no summary) is NOT returned.
  - Active session with one memory anchored to it IS returned.
  - Ended session with a summary IS returned.
  - With three empty sessions starting at t1<t2<t3 and one useful session at t0, requesting limit:1 returns the useful one at t0 (backfill semantics).
  - Soft-deleted session with content is NOT returned (existing behavior preserved).

## 4. Integration test for `memory.context`

- [ ] 4.1 Update `apps/server/src/test/mcp-integration.test.ts` test at line 257 ("memory.context should include the session as recent and `ended`"). The current assertion `recentSessions.find((s) => s.id === startedPayload.sessionId)` SHALL stand only after the test seeds at least one memory into that session, since the new contract requires content presence.
- [ ] 4.2 Add a new integration scenario: start a session, end it WITHOUT writing memories or a summary, then call `memory.context` — assert the empty session does NOT appear in `recentSessions`.
- [ ] 4.3 Add a new integration scenario: in a scope with N=3 empty sessions in front of one useful one, call `memory.context({sessions: 1})` — assert the response contains exactly the useful session.

## 5. Spec deltas

- [ ] 5.1 Apply the spec delta under `openspec/changes/filter-empty-sessions-from-context/specs/sessions/spec.md` to the canonical `openspec/specs/sessions/spec.md` — MODIFIED requirement for `recentForContext` + new normative reference to `sessionHasContent`.
- [ ] 5.2 Apply the spec delta under `openspec/changes/filter-empty-sessions-from-context/specs/mcp-api/spec.md` to the canonical `openspec/specs/mcp-api/spec.md` — MODIFIED scenario for `memory.context.recentSessions`.
- [ ] 5.3 Run `openspec validate filter-empty-sessions-from-context --strict` and resolve any reported drift.

## 6. Verify and ship

- [ ] 6.1 `pnpm run typecheck` clean.
- [ ] 6.2 `pnpm run lint` clean.
- [ ] 6.3 `pnpm test` clean (full suite — the new and existing tests cover the boundary).
- [ ] 6.4 Manual smoke: `pnpm run dev:docker:up`, watch for default seed data, then from a Claude Code session call `memory.context` and inspect `recentSessions` — confirm noise is gone.
- [ ] 6.5 Conventional Commit message naming the changed surface: `feat(sessions): filter empty sessions out of memory.context recentSessions`.
- [ ] 6.6 After merge, archive the change: `openspec archive filter-empty-sessions-from-context`.
