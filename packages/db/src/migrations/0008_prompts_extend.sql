-- 0008_prompts_extend.sql
-- change set ("add-prompts-dashboard-view"):
--   1. Add four nullable columns to `prompts` so we can carry retrieval
--      metadata (title, tags), the refine chain (replaces), and the
--      operator soft-delete marker (deleted_at). Existing rows get NULL
--      for every new column; no backfill needed.

ALTER TABLE prompts ADD COLUMN title text;
--> statement-breakpoint
ALTER TABLE prompts ADD COLUMN tags text;
--> statement-breakpoint
ALTER TABLE prompts ADD COLUMN replaces text;
--> statement-breakpoint
ALTER TABLE prompts ADD COLUMN deleted_at integer;
