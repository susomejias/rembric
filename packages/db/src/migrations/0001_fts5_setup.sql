-- FTS5 virtual table kept in sync with the `memory` table via triggers.
-- Indexes the `content` column and the JSON `tags` array as a flattened
-- whitespace-joined string for cheap keyword matching.

CREATE VIRTUAL TABLE `memory_fts` USING fts5(
    content,
    tags,
    content='memory',
    content_rowid='rowid'
);
--> statement-breakpoint

-- INSERT: index the new row.
CREATE TRIGGER `memory_ai` AFTER INSERT ON `memory` BEGIN
    INSERT INTO memory_fts(rowid, content, tags)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), '')
    );
END;
--> statement-breakpoint

-- DELETE: not expected in practice (we never DELETE FROM memory), but kept
-- defensively in case of test teardown or future maintenance.
CREATE TRIGGER `memory_ad` AFTER DELETE ON `memory` BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, '');
END;
--> statement-breakpoint

-- UPDATE: only tags / status / last_seen_at can change in practice (content
-- is immutable). We re-index to be safe.
CREATE TRIGGER `memory_au` AFTER UPDATE ON `memory` BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, '');
    INSERT INTO memory_fts(rowid, content, tags)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), '')
    );
END;
