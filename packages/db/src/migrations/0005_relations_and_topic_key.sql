-- 0005_relations_and_topic_key.sql
--
-- Two related changes that ship together because the topic_key upsert
-- path writes into memory_relations atomically:
--
--   1. New `memory_relations` table: the judgment graph. Status FSM
--      pending → judged | orphaned. Append-only at the row level;
--      `judgment_id`, `source_id`, `target_id`, `created_at` never
--      change after insert.
--   2. `memory.topic_key` column (nullable) + partial index for the
--      "find active row in this (scope, project_id, topic_key) slot"
--      query that runs on every save with a topic_key.
--
-- No backfill. Existing memory rows keep `topic_key = NULL`. The
-- consolidator's orphan-promotion pass is the long-tail safety net for
-- candidates the agent never judged.

CREATE TABLE memory_relations (
  id text PRIMARY KEY NOT NULL,
  judgment_id text NOT NULL,
  source_id text NOT NULL REFERENCES memory(id),
  target_id text NOT NULL REFERENCES memory(id),
  relation text,
  status text NOT NULL,
  reason text,
  evidence text,
  confidence real,
  marked_by_kind text,
  marked_by_actor text,
  judged_at integer,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_relations_judgment_id_unique ON memory_relations (judgment_id);
--> statement-breakpoint
CREATE INDEX memory_relations_source_status_idx ON memory_relations (source_id, status);
--> statement-breakpoint
CREATE INDEX memory_relations_target_status_idx ON memory_relations (target_id, status);
--> statement-breakpoint
CREATE INDEX memory_relations_status_created_idx ON memory_relations (status, created_at);
--> statement-breakpoint

ALTER TABLE memory ADD COLUMN topic_key text;
--> statement-breakpoint
CREATE INDEX memory_topic_key_active_idx
  ON memory (scope, project_id, topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL;
