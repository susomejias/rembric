-- Heal pre-existing duplicate-active topic_key slots (keep newest), then add a
-- UNIQUE partial index. Keyed on COALESCE(project_id, '') because SQLite treats
-- NULL as distinct in a UNIQUE index, which would leave global slots unconstrained.

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
