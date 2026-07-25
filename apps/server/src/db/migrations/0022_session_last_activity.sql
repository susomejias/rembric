-- 0022_session_last_activity.sql
-- change set (fix-audited-defects: zombie sessions block auto-attach):
--   1. Add a nullable `last_activity_at` column to `sessions`, backfilled
--      from `started_at` so every existing row is immediately classifiable.
--      A killed client (SIGKILL/OOM/closed terminal, no SessionEnd) leaves
--      an `active` row with no signal distinguishing it from a live one;
--      this column is what lets findActiveForTransport exclude it from
--      auto-attach resolution, and the periodic retirement pass reclaim
--      it, without introducing a recency tiebreak among genuinely
--      concurrent sessions.

ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER;
--> statement-breakpoint
UPDATE sessions SET last_activity_at = started_at WHERE last_activity_at IS NULL;
