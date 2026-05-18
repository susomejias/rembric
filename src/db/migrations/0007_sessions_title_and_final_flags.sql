-- 0007_sessions_title_and_final_flags.sql
-- change set ("fix-session-summary-all-clients"):
--   1. Add a nullable `title` column to `sessions` so the dashboard can
--      render a human-readable label for each session in the list view.
--      Initial title is written at row creation as a placeholder of the
--      form `basename(cwd) · HH:MM UTC`; later writes (model via
--      memory.session_summary, bash hook fallback) overwrite subject to
--      the precedence rules below.
--   2. Add `summary_final` and `title_final` boolean columns (INTEGER 0/1
--      per SQLite/Drizzle convention) to encode the write-once-with-final
--      precedence. A write carrying `final:true` flips the corresponding
--      `_final` column to 1 and locks the value against subsequent
--      `final:false` writes. Model writes via memory.session_summary are
--      always `final:true`; bash/Python hook fallbacks are always
--      `final:false`.
--   Migration is additive: existing rows get `title=NULL`,
--   `summary_final=0`, `title_final=0`. No backfill.

ALTER TABLE sessions ADD COLUMN title TEXT;
ALTER TABLE sessions ADD COLUMN summary_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN title_final INTEGER NOT NULL DEFAULT 0;
