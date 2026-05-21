-- 0009_prompts_fts.sql
-- FTS5 virtual table kept in sync with the `prompts` table via triggers.
-- Indexes the `content` column and the JSON `tags` array as a flattened
-- whitespace-joined string for cheap keyword matching. Same shape as the
-- `memory_fts` setup in 0001_fts5_setup.sql.

CREATE VIRTUAL TABLE `prompts_fts` USING fts5(
    content,
    tags,
    content='prompts',
    content_rowid='rowid'
);
--> statement-breakpoint

-- INSERT: index the new row.
CREATE TRIGGER `prompts_ai` AFTER INSERT ON `prompts` BEGIN
    INSERT INTO prompts_fts(rowid, content, tags)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), '')
    );
END;
--> statement-breakpoint

-- DELETE: physical deletion happens only through `PromptsService.purgeDeleted`;
-- keep the trigger defensively in case of test teardown or future maintenance.
CREATE TRIGGER `prompts_ad` AFTER DELETE ON `prompts` BEGIN
    INSERT INTO prompts_fts(prompts_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, '');
END;
--> statement-breakpoint

-- UPDATE: required because soft-delete and refine flips are UPDATEs on the
-- row even though `content` itself never changes. Re-issue the index entry
-- (delete-then-insert) so the indexed content/tags stay in lock-step.
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

-- Backfill existing rows so the index is complete on first boot after this
-- change. No-op on a fresh DB (table is empty).
INSERT INTO prompts_fts(rowid, content, tags)
SELECT rowid,
       content,
       coalesce((SELECT group_concat(value, ' ') FROM json_each(prompts.tags)), '')
  FROM prompts;
