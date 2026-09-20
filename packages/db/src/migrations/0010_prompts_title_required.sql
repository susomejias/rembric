-- 0010_prompts_title_required.sql
-- Tighten the `prompts.title` column to NOT NULL.
--
-- `title` was added in 0008 as nullable; the app contract now requires it
-- (memory.save_prompt's zod schema and PromptsService.save both reject
-- missing title). SQLite cannot ALTER an existing column to add a NOT NULL
-- constraint directly, so we follow the standard table-rebuild dance:
--   1. Backfill any NULL titles with the literal placeholder '(untitled)'
--      — operator can rename via a future detail-page edit if/when added.
--   2. Recreate the table with `title TEXT NOT NULL`.
--   3. Re-create indexes (DROP TABLE cascades them).
--   4. Re-create the prompts_fts triggers (DROP TABLE cascades them).
--   5. Rebuild the FTS5 index so it re-indexes against the new rowids.

UPDATE prompts SET title = '(untitled)' WHERE title IS NULL;
--> statement-breakpoint

CREATE TABLE prompts_new (
  id text PRIMARY KEY NOT NULL,
  session_id text REFERENCES sessions(id),
  project_id text REFERENCES projects(id),
  content text NOT NULL,
  title text NOT NULL,
  tags text,
  replaces text,
  agent text,
  created_at integer NOT NULL,
  deleted_at integer
);
--> statement-breakpoint

INSERT INTO prompts_new (id, session_id, project_id, content, title, tags, replaces, agent, created_at, deleted_at)
SELECT id, session_id, project_id, content, title, tags, replaces, agent, created_at, deleted_at
  FROM prompts;
--> statement-breakpoint

DROP TABLE prompts;
--> statement-breakpoint

ALTER TABLE prompts_new RENAME TO prompts;
--> statement-breakpoint

CREATE INDEX prompts_project_created_idx ON prompts (project_id, created_at);
--> statement-breakpoint
CREATE INDEX prompts_session_idx ON prompts (session_id);
--> statement-breakpoint

-- Re-install the FTS5 triggers from 0009 (they were dropped with the table).
CREATE TRIGGER `prompts_ai` AFTER INSERT ON `prompts` BEGIN
    INSERT INTO prompts_fts(rowid, content, tags)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), '')
    );
END;
--> statement-breakpoint

CREATE TRIGGER `prompts_ad` AFTER DELETE ON `prompts` BEGIN
    INSERT INTO prompts_fts(prompts_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, '');
END;
--> statement-breakpoint

CREATE TRIGGER `prompts_au` AFTER UPDATE ON `prompts` BEGIN
    INSERT INTO prompts_fts(prompts_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, '');
    INSERT INTO prompts_fts(rowid, content, tags)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), '')
    );
END;
--> statement-breakpoint

-- Rebuild the contentless FTS5 index against the new rowids.
INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild');
