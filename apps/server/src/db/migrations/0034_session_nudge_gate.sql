-- 0034_session_nudge_gate.sql
--
-- Three nullable timestamps backing the server-gated session-summary
-- reminder (`session-nudges`, "Session rows MUST carry the three
-- nudge-gate timestamps..."). Purely additive: three ALTER TABLE ADD
-- COLUMN statements, no rebuild, no CHECK, no NOT NULL, no foreign key.
--
-- NULL means "never" on all three; every existing row reads NULL and the
-- gate treats that as silent until a client's turn report sets one. No
-- backfill: `last_summary_at` is deliberately NOT derived from
-- `session_summary_versions.created_at` (design.md D1) — a byte-identical
-- curated re-write appends no version row, so that table's newest
-- timestamp would misdate the column, and a later change retires the
-- table entirely.

ALTER TABLE `sessions` ADD COLUMN `last_work_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `last_summary_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `last_nudge_at` INTEGER;
