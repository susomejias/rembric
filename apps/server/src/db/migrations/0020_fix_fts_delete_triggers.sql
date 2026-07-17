-- Fix two FTS5 external-content trigger bugs:
--
-- 1. memory_ad/memory_au (delete branch) and prompts_ad/prompts_au (delete
--    branch) passed tags='' to the FTS5 'delete' command instead of the row's
--    real flattened tags. External-content FTS5 requires the delete command
--    to repeat the exact originally-indexed values; passing '' leaves a
--    dangling tag posting after a genuine physical purge
--    (memory.purgeDisconnectedArchived / prompts.purgeDeleted), and a later
--    rowid reuse then makes an unrelated new row inherit the phantom match.
--
-- 2. memory_au was an unscoped `AFTER UPDATE`, rewriting the FTS index on
--    every last_seen_at touch and status flip even though content/tags/title
--    are immutable for `memory`. Narrowed to `AFTER UPDATE OF content, tags,
--    title` — those are the only columns that can ever legitimately change.
--    prompts_au stays unscoped: deleted_at/replaces flips are UPDATEs on the
--    prompts row itself and must re-index (see persistence spec).

DROP TRIGGER `memory_ad`;
--> statement-breakpoint
DROP TRIGGER `memory_au`;
--> statement-breakpoint

CREATE TRIGGER `memory_ad` AFTER DELETE ON `memory` BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, tags, title)
    VALUES (
        'delete',
        old.rowid,
        old.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(old.tags)), ''),
        old.title
    );
END;
--> statement-breakpoint

CREATE TRIGGER `memory_au` AFTER UPDATE OF content, tags, title ON `memory` BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, tags, title)
    VALUES (
        'delete',
        old.rowid,
        old.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(old.tags)), ''),
        old.title
    );
    INSERT INTO memory_fts(rowid, content, tags, title)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), ''),
        new.title
    );
END;
--> statement-breakpoint

DROP TRIGGER `prompts_ad`;
--> statement-breakpoint
DROP TRIGGER `prompts_au`;
--> statement-breakpoint

CREATE TRIGGER `prompts_ad` AFTER DELETE ON `prompts` BEGIN
    INSERT INTO prompts_fts(prompts_fts, rowid, content, tags)
    VALUES (
        'delete',
        old.rowid,
        old.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(old.tags)), '')
    );
END;
--> statement-breakpoint

CREATE TRIGGER `prompts_au` AFTER UPDATE ON `prompts` BEGIN
    INSERT INTO prompts_fts(prompts_fts, rowid, content, tags)
    VALUES (
        'delete',
        old.rowid,
        old.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(old.tags)), '')
    );
    INSERT INTO prompts_fts(rowid, content, tags)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), '')
    );
END;
--> statement-breakpoint

-- Heal any already-deployed database carrying dangling postings from the
-- defective triggers above (a clean database rebuilds to the same state).
INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
--> statement-breakpoint
INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild');
