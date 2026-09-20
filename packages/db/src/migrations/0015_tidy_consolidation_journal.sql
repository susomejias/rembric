-- 0015_tidy_consolidation_journal.sql
--
-- Post-LLM-removal tidy of the consolidation journal (see change
-- tidy-consolidation-journal):
--   1. Rebuild `consolidation_runs` to drop the always-NULL `llm_provider` /
--      `llm_model` columns and tighten `scope` to NOT NULL (it has been
--      written on every run/purge for a long time). Legacy rows that predate
--      scope population are backfilled with 'unknown'.
--   2. Rename `consolidation_ops.consolidation_id` -> `run_id` (it is a FK
--      onto a *run*; every consumer already calls the value `runId`) and
--      recreate its index under the matching name.
--
-- Loss-free: `INSERT … SELECT` copies every run row; `RENAME COLUMN` preserves
-- every op row including historical `merge` / `supersede` ops, which stay
-- renderable and undoable. The migration runner (apps/server/src/db/migrate.ts)
-- wraps this in `PRAGMA foreign_keys=OFF` … `BEGIN IMMEDIATE` …
-- `PRAGMA foreign_key_check` … `COMMIT`, so dropping the FK parent
-- (`consolidation_runs`, referenced by `consolidation_ops`) is safe and
-- post-rebuild integrity is validated before commit.

CREATE TABLE consolidation_runs_new (
  id text PRIMARY KEY NOT NULL,
  started_at integer NOT NULL,
  finished_at integer,
  scope text NOT NULL,
  summary text
);
--> statement-breakpoint

INSERT INTO consolidation_runs_new (id, started_at, finished_at, scope, summary)
SELECT id, started_at, finished_at, COALESCE(scope, 'unknown'), summary
FROM consolidation_runs;
--> statement-breakpoint

DROP TABLE consolidation_runs;
--> statement-breakpoint

ALTER TABLE consolidation_runs_new RENAME TO consolidation_runs;
--> statement-breakpoint

CREATE INDEX consolidation_runs_started_at_idx ON consolidation_runs (started_at);
--> statement-breakpoint

ALTER TABLE consolidation_ops RENAME COLUMN consolidation_id TO run_id;
--> statement-breakpoint

DROP INDEX consolidation_ops_consolidation_id_idx;
--> statement-breakpoint

CREATE INDEX consolidation_ops_run_id_idx ON consolidation_ops (run_id);
