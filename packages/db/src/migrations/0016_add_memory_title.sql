-- 0016_add_memory_title.sql
--
-- Add a required, non-empty `title` column to `memory`. SQLite can neither
-- add a NOT NULL column without a default nor add a CHECK in place, so this
-- is the table-rebuild dance (see CLAUDE.md → "Table-rebuild migrations").
-- The migration runner already wraps every file in `foreign_keys = OFF` +
-- BEGIN IMMEDIATE + `foreign_key_check` gate, so no pragma authoring here.
--
-- rowid preservation is load-bearing: `memory_fts` is an external-content
-- FTS5 table (content='memory', content_rowid='rowid') and the hybrid-search
-- query joins `memory.rowid = memory_fts.rowid`. We therefore carry rowids
-- across verbatim (explicit `rowid` in the INSERT) and rebuild the FTS index
-- defensively afterwards. `memory_vec` is keyed by `memory_id` (rowid-
-- independent) and is left untouched, so embeddings survive without a copy.

CREATE TABLE `memory_new` (
    `id` text PRIMARY KEY NOT NULL,
    `scope` text NOT NULL,
    `project_id` text,
    `type` text NOT NULL,
    `title` text NOT NULL CHECK (length(`title`) BETWEEN 1 AND 100),
    `content` text NOT NULL,
    `tags` text DEFAULT '[]' NOT NULL,
    `status` text DEFAULT 'active' NOT NULL,
    `replaces` text DEFAULT '[]' NOT NULL,
    `created_at` integer NOT NULL,
    `last_seen_at` integer,
    `source` text,
    `session_id` text,
    `topic_key` text,
    FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
    FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

-- Backfill title = first content line, leading/trailing markdown markers
-- (`*`, `#`, backtick, space, tab, CR) trimmed, truncated to 100 chars. The
-- coalesce chain guarantees a non-empty result for ANY pre-existing row:
-- trimmed first line → else trimmed full content → else the literal
-- 'untitled'. The 'untitled' floor matters because the DB only enforces
-- `content NOT NULL` (no non-empty CHECK), so an empty/whitespace-only legacy
-- row must still satisfy `CHECK(length(title) BETWEEN 1 AND 100)` rather than
-- abort the (irreversible) migration. Approximates `deriveTitle` (a one-time
-- backfill of immutable titles; exact JS parity is not required and the two
-- differ on trailing markers — SQL trim() is two-sided, the JS strip is
-- leading-only).
INSERT INTO `memory_new` (
    rowid, `id`, `scope`, `project_id`, `type`, `title`, `content`,
    `tags`, `status`, `replaces`, `created_at`, `last_seen_at`, `source`,
    `session_id`, `topic_key`
)
SELECT
    rowid, `id`, `scope`, `project_id`, `type`,
    substr(
        coalesce(
            nullif(trim(
                substr(`content`, 1, CASE WHEN instr(`content`, char(10)) > 0
                                          THEN instr(`content`, char(10)) - 1
                                          ELSE length(`content`) END),
                ' *#' || char(96) || char(9) || char(13)), ''),
            nullif(trim(replace(replace(`content`, char(10), ' '), char(13), ' ')), ''),
            'untitled'),
        1, 100
    ) AS `title`,
    `content`, `tags`, `status`, `replaces`, `created_at`, `last_seen_at`,
    `source`, `session_id`, `topic_key`
FROM `memory`;
--> statement-breakpoint

DROP TABLE `memory`;
--> statement-breakpoint
ALTER TABLE `memory_new` RENAME TO `memory`;
--> statement-breakpoint

-- Recreate indexes (0000 / 0003 / 0005).
CREATE INDEX `memory_scope_project_status_idx` ON `memory` (`scope`, `project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `memory_status_last_seen_idx` ON `memory` (`status`, `last_seen_at`);
--> statement-breakpoint
CREATE INDEX `memory_created_at_idx` ON `memory` (`created_at`);
--> statement-breakpoint
CREATE INDEX `memory_session_idx` ON `memory` (`session_id`);
--> statement-breakpoint
CREATE INDEX `memory_topic_key_active_idx`
  ON `memory` (`scope`, `project_id`, `topic_key`)
  WHERE status = 'active' AND topic_key IS NOT NULL;
--> statement-breakpoint

-- Recreate `memory_fts` with a `title` column (it was content+tags in 0001) so
-- the lexical retriever indexes titles too. External-content FTS5 over `memory`;
-- the old vtable is dropped and rebuilt. The base-table rebuild above preserved
-- rowids, but the FTS *schema* changes here, so the rebuild below is now
-- load-bearing (repopulates content+tags+title), not merely defensive.
DROP TABLE `memory_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_fts` USING fts5(
    content,
    tags,
    title,
    content='memory',
    content_rowid='rowid'
);
--> statement-breakpoint

-- FTS5 sync triggers (0001) — dropped with the old `memory` table; recreated to
-- carry `title` alongside content/tags. The 'delete' commands pass the original
-- indexed values so the external-content index stays consistent (tags keep the
-- existing ''-on-delete behavior; content is immutable; title is set-once).
CREATE TRIGGER `memory_ai` AFTER INSERT ON `memory` BEGIN
    INSERT INTO memory_fts(rowid, content, tags, title)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), ''),
        new.title
    );
END;
--> statement-breakpoint
CREATE TRIGGER `memory_ad` AFTER DELETE ON `memory` BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, tags, title)
    VALUES ('delete', old.rowid, old.content, '', old.title);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_au` AFTER UPDATE ON `memory` BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content, tags, title)
    VALUES ('delete', old.rowid, old.content, '', old.title);
    INSERT INTO memory_fts(rowid, content, tags, title)
    VALUES (
        new.rowid,
        new.content,
        coalesce((SELECT group_concat(value, ' ') FROM json_each(new.tags)), ''),
        new.title
    );
END;
--> statement-breakpoint

-- Recreate the vec0 status-sync trigger (0014). memory_vec itself is keyed by
-- memory_id and was never dropped, so vectors are intact.
CREATE TRIGGER `memory_vec_status_sync` AFTER UPDATE OF status ON memory BEGIN
    UPDATE memory_vec SET status = new.status WHERE memory_id = new.id;
END;
--> statement-breakpoint

-- Rebuild the FTS index from the rebuilt content table (now includes title).
INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
