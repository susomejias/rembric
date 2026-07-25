-- Composite index backing the review axis. `findNeedsReview`,
-- `countNeedsReview`, `adminCountNeedsReview` and `findDecayCandidateIds` each
-- derive their answer from a correlated subquery per candidate row of the shape
-- `SELECT MAX(event_ts) ... WHERE memory_id = ? AND verdict = ?`. Column order
-- is load-bearing: equality on `memory_id`, then equality on `verdict`, then
-- `event_ts` last so MAX/range comes from the index's own ordering. All three
-- together also make the index covering for these subqueries — the plan reads
-- `USING COVERING INDEX` and never touches the table. Additive, so no rebuild.
CREATE INDEX `confirmations_memory_verdict_ts_idx`
  ON `confirmations` (`memory_id`, `verdict`, `event_ts`);
