-- 0034_session_nudge_gate.sql
--
-- Three of the four nullable timestamps backing the server-gated
-- session-summary reminder (`sessions`, "Session rows MUST carry the four
-- nudge-gate timestamps, three of them monotone and the turn anchor free
-- to follow the clock"); the fourth, `last_turn_report_at`, arrives in
-- 0036. Purely additive: three ALTER TABLE ADD COLUMN statements, no
-- rebuild, no CHECK, no NOT NULL, no foreign key.
--
-- NULL means "never" on all three; every existing row reads NULL and the
-- gate treats that as silent until a client's turn report sets one. No
-- backfill: nothing on the row records when a summary was last written,
-- so `last_summary_at` starts NULL rather than being inferred.

ALTER TABLE `sessions` ADD COLUMN `last_work_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `last_summary_at` INTEGER;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `last_nudge_at` INTEGER;
