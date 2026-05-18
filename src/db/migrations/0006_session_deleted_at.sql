-- 0006_session_deleted_at.sql
-- change set ("add-session-deletion"):
--   1. Add a nullable `deleted_at` column to the `sessions` table so
--      operators can soft-delete an agent session row from the CLI and
--      the dashboard while preserving the audit trail. Default-visible
--      queries filter `WHERE deleted_at IS NULL`; `findById(...)` and
--      the explicit `--include-deleted` paths surface deleted rows.

ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;
