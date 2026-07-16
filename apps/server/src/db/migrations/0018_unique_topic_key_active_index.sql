-- 0018_unique_topic_key_active_index.sql
--
-- Enforce topic_key convergence at the storage layer: at most one active row
-- per (scope, project_id, topic_key). A non-unique index previously permitted
-- duplicates (e.g. consolidation undo reactivating a row whose slot a newer
-- save had claimed). This migration:
--   1. heals any pre-existing duplicate-active slots by keeping the
--      most-recently-created active row per slot and superseding the rest
--      (a status flip only — append-only-safe: no content edit, no delete);
--   2. adds a UNIQUE partial index as a live backstop.
--
-- SQLite treats NULL as DISTINCT in UNIQUE indexes, so a plain UNIQUE index on
-- (scope, project_id, topic_key) would NOT enforce convergence for global
-- memories (project_id IS NULL). The unique index is therefore built on
-- COALESCE(project_id, '') so global slots are constrained too. The existing
-- non-unique `memory_topic_key_active_idx` is kept for the equality lookups in
-- `findActiveByTopicKey` (which filter on the raw project_id column).
--
-- Index-only DDL — no table rebuild, so no foreign_keys dance is required.

UPDATE memory
SET status = 'superseded'
WHERE status = 'active'
  AND topic_key IS NOT NULL
  AND id NOT IN (
    SELECT id FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY scope, project_id, topic_key
          ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM memory
      WHERE status = 'active' AND topic_key IS NOT NULL
    )
    WHERE rn = 1
  );
--> statement-breakpoint

CREATE UNIQUE INDEX `memory_topic_key_active_uidx`
  ON `memory` (`scope`, COALESCE(`project_id`, ''), `topic_key`)
  WHERE status = 'active' AND topic_key IS NOT NULL;
