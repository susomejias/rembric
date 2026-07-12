## 1. Predicate parameterization

- [x] 1.1 In `apps/server/src/db/repositories/agent-sessions-repository.ts`, change `sessionHasContentSql(alias)` to `sessionHasContentSql(alias, opts: { requireCuratedSummary: boolean } = { requireCuratedSummary: true })`, with clause 1 becoming `requireCuratedSummary ? "${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1" : "${alias}.summary IS NOT NULL"`. Clauses 2–5 unchanged.
- [x] 1.2 Update `recentForContext` to call `sessionHasContentSql('sessions', { requireCuratedSummary: true })` (explicit, matching current behavior).
- [x] 1.3 Update `countPurgeableEmpty` and `findPurgeableEmptyIds` to call `sessionHasContentSql('s', { requireCuratedSummary: false })`.

## 2. Tests

- [x] 2.1 Rewrote the test to `"does not purge a session with a genuine but uncurated summary (summary_final=0)"`, asserting the row survives.
- [x] 2.2 Already covered by the existing, unmodified `"purges ended sessions with no referencing rows past the grace period"` test (`agent-sessions.test.ts:388`) — a genuinely empty session (no summary at all). No new test needed.
- [x] 2.3 `"excludes a session with only a raw, uncurated summary (summary_final=0)"` (`agent-sessions.test.ts:544`) passes unmodified — `recentForContext` still evaluates `requireCuratedSummary: true`.
- [x] 2.4 Already covered by the existing, unmodified `"skips sessions with a summary written"` test (`agent-sessions.test.ts:439`), which uses `sessions.summarize()` — that helper calls `end()` with `final: true`, i.e. a curated summary. No new test needed; noted here since design.md called out this exact case.

## 3. Verification

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 Full suite: `pnpm vitest run` — 84 files, 1136 passed, 1 skipped (pre-existing, unrelated). `agent-sessions.test.ts` alone: 57/57.
- [x] 3.3 Confirmed by code inspection (no change needed): `/dashboard/maintenance`'s purged-count banner reads `summary.purgedSessionIds?.length` from the sweep's own return value at request time, not a cached/stale count — it will automatically reflect the smaller purge set.

## 4. Spec archival coordination

- [ ] 4.1 Before archiving this change, confirm the archival order with the still-unarchived `close-session-context-pollution-gap` change (both touch `openspec/specs/sessions/spec.md`'s `sessionHasContent`/purge requirements) — whichever archives first must leave the canonical spec text correct for the other to apply cleanly afterward. This is a documentation-sequencing task, not a code task.
