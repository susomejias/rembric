-- 0031_default_project.sql
--
-- Retire the global scope: every previously-global row is repointed onto a
-- newly created default project, so `scope` becomes a closed partition.
--
-- The destination is ALWAYS a new `projects` row and NEVER an existing one, not
-- even a project already slugged `default`: repointing into a populated project
-- merges two populations irreversibly (append-only keeps the rows while
-- `project_id` stops recording where they came from), and it turns two
-- impossible-by-construction UNIQUE collisions —
-- `memory_topic_key_active_uidx` and `memory_entities_identity_idx` — into live
-- ones. A brand-new destination holds no rows, so neither key can be occupied.
--
-- The slug is probed, never guessed: `projects_slug_unique` makes a taken slug
-- an aborted migration, i.e. a server that does not boot.
--
-- Idempotency is not free here. The `WHERE NOT EXISTS` on the INSERT is the
-- guard; without it a second execution of this body creates a second default
-- project and path-less resolution stops being deterministic. Every repointing
-- statement below is then a no-op on a second pass, because its WHERE clause is
-- already empty.
--
-- `memory_entities` is repointed IN PLACE rather than rebuilt. That is safe for
-- exactly one reason, invisible from the statement: the destination project is
-- created by this same migration, so its only entity rows are the repointed
-- ones and a collision on `memory_entities_identity_idx` is impossible by
-- construction.
--
-- `memory_vec` is the stashed set-based pair (design.md D4 variant B), chosen
-- for pure-`.sql` expressibility — the runner reads only `.sql`, so the per-row
-- form would move a loop into the boot-critical runner — and NOT for speed: the
-- measured bodies at 200 000 previously-global rows are 195.6 s set-based
-- against 232.4 s per-row, and the per-row form is the faster of the two at
-- 1 000 and 10 000. It costs +943 MB of file growth against +155 MB.
-- The stash table is mandatory, not incidental: re-INSERTing at the new
-- partition before the DELETE fails with `UNIQUE constraint failed on
-- memory_vec primary key`, because `memory_id` is unique across partitions and
-- the row cannot exist at two partition keys even transiently. And the move
-- must be DELETE + re-INSERT because sqlite-vec rejects the obvious statement:
-- "UPDATE on partition key columns are not supported yet."
--
-- The blob is carried across unchanged rather than re-embedded, so nothing
-- after COMMIT has to succeed for the dense branch to keep working.
--
-- `id` is 26 random hex characters rather than a ULID: a `.sql` file has no
-- ULID generator, and nothing reads a project id as a timestamp.

ALTER TABLE `projects` ADD COLUMN `is_default` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Enforced by the database, not only by the guard above: a second row holding 1
-- would make path-less resolution non-deterministic, and a later bug, a manual
-- UPDATE or a restored snapshot can produce what a migration guard cannot see.
CREATE UNIQUE INDEX projects_is_default_uidx ON projects(is_default) WHERE is_default = 1;
--> statement-breakpoint
-- Captured BEFORE the UPDATE: the reported count is the number of rows this
-- execution moved, which a count over the destination cannot distinguish from
-- rows a previous execution already moved.
CREATE TABLE `_repoint_report` (repointed INTEGER NOT NULL);
--> statement-breakpoint
INSERT INTO `_repoint_report` (repointed) SELECT count(*) FROM `memory` WHERE `scope` = 'global';
--> statement-breakpoint
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
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE NOT EXISTS (SELECT 1 FROM `projects` WHERE `is_default` = 1);
--> statement-breakpoint
-- Both columns in one statement.
UPDATE `memory`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1),
       `scope` = 'project'
 WHERE `scope` = 'global';
--> statement-breakpoint
-- progress: repointing the entity index
UPDATE `memory_entities`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1),
       `scope` = 'project'
 WHERE `scope` = 'global';
--> statement-breakpoint
-- Every path-less session ever registered. `tokens.project_id IS NULL` is
-- deliberately untouched: that records an unbound `*` token, not a scope, and
-- the CHECK added by 0029 depends on the null.
UPDATE `sessions`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1)
 WHERE `project_id` IS NULL;
--> statement-breakpoint
UPDATE `prompts`
   SET `project_id` = (SELECT `id` FROM `projects` WHERE `is_default` = 1)
 WHERE `project_id` IS NULL;
--> statement-breakpoint
-- Live rows only. Finished runs keep 'global' forever: the journal records what
-- happened.
UPDATE `consolidation_runs`
   SET `scope` = (SELECT `id` FROM `projects` WHERE `is_default` = 1)
 WHERE `scope` = 'global' AND `finished_at` IS NULL;
--> statement-breakpoint
-- progress: repartitioning the dense vector index (the largest step: 73% of this migration at scale)
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
--> statement-breakpoint
-- report:
SELECT 'repointed ' || (SELECT repointed FROM `_repoint_report`) ||
       ' previously-global memory row(s) into the default project ' ||
       (SELECT `slug` FROM `projects` WHERE `is_default` = 1);
--> statement-breakpoint
DROP TABLE `_repoint_report`;
