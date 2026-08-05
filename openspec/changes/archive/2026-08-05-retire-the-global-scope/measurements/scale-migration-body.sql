-- MEASUREMENT ARTEFACT, not the shipped migration.
--
-- The `retire-the-global-scope` migration body as design.md's "Migration Plan"
-- specifies it (steps 1-9), written as a real runner-compatible migration file
-- so it can be executed through `migrate()` (the runner supplies the
-- `PRAGMA foreign_keys = OFF` / `BEGIN IMMEDIATE` / `foreign_key_check` /
-- `COMMIT` envelope — this file adds no pragmas, per CLAUDE.md).
--
-- Two deliberate departures from what will ship, both irrelevant to wall-clock:
--   * `id` is `lower(hex(randomblob(13)))` (26 chars, same width as a ULID)
--     rather than a real ULID, because a .sql file has no ULID generator.
--   * `display_name` is a fixed literal.
--
-- Step 9 is the SET-BASED form (variant B in scale.md). The per-row form
-- (variant A) is not expressible here at all: the runner only reads `.sql`
-- files and splits them on the statement-breakpoint marker, so a loop would
-- require changing `db/migrate.ts`. scale.md measures A separately, in-process.
-- (The marker is deliberately not spelled out above: the runner's split is
-- textual and does not skip comments, so naming it inside one splits it.)

ALTER TABLE `projects` ADD COLUMN `is_default` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Idempotency guard folded into the INSERT's WHERE: a re-run finds an
-- `is_default` row and inserts nothing, so every step below repoints zero rows
-- (their WHERE clauses are already empty by then).
INSERT INTO `projects` (`id`, `slug`, `display_name`, `is_default`, `created_at`)
SELECT lower(hex(randomblob(13))),
       (WITH RECURSIVE cand(n, slug) AS (
            SELECT 1, 'default'
            UNION ALL SELECT n + 1, 'default-' || (n + 1) FROM cand WHERE n < 1000
        )
        SELECT slug FROM cand
        WHERE slug NOT IN (SELECT slug FROM `projects`)
        LIMIT 1),
       'Default',
       1,
       unixepoch('subsec') * 1000
WHERE NOT EXISTS (SELECT 1 FROM `projects` WHERE `is_default` = 1);
--> statement-breakpoint
UPDATE `memory`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1),
       `scope` = 'project'
 WHERE `scope` = 'global';
--> statement-breakpoint
UPDATE `memory_entities`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1),
       `scope` = 'project'
 WHERE `scope` = 'global';
--> statement-breakpoint
UPDATE `sessions`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1)
 WHERE `project_id` IS NULL;
--> statement-breakpoint
UPDATE `prompts`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1)
 WHERE `project_id` IS NULL;
--> statement-breakpoint
-- Live rows only. Finished runs keep 'global' forever: the journal records what
-- happened (D16).
UPDATE `consolidation_runs`
   SET `scope` = (SELECT `id` FROM `projects` WHERE `is_default` = 1)
 WHERE `scope` = 'global' AND `finished_at` IS NULL;
--> statement-breakpoint
-- sqlite-vec rejects `UPDATE memory_vec SET partition_key = …` ("UPDATE on
-- partition key columns are not supported yet."), so the ex-global vectors are
-- stashed, deleted and re-inserted with the identical blob.
CREATE TABLE `_vec_repartition` (
    memory_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    embedding BLOB NOT NULL
);
--> statement-breakpoint
INSERT INTO `_vec_repartition` (memory_id, status, type, embedding)
SELECT memory_id, status, type, embedding FROM `memory_vec`
 WHERE partition_key = '__global__';
--> statement-breakpoint
DELETE FROM `memory_vec` WHERE partition_key = '__global__';
--> statement-breakpoint
INSERT INTO `memory_vec` (memory_id, partition_key, status, type, embedding)
SELECT memory_id, (SELECT `id` FROM `projects` WHERE `is_default` = 1), status, type, embedding
  FROM `_vec_repartition`;
--> statement-breakpoint
DROP TABLE `_vec_repartition`;
