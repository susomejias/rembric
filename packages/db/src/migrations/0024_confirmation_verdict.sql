-- Adds the negative mirror of a confirmation (separate-access-from-usefulness):
-- an agent can now record that a memory it just surfaced was wrong or
-- stale, not only that it was still true. `verdict` carries the sign so
-- affirmation and refutation share one append-only channel instead of a
-- second table — the same kind of fact ("an agent rendered a verdict"),
-- opposite direction. Every existing row is an affirmation, so the
-- default backfills them for free. `reason` is optional at the DB level;
-- the service layer requires it for a refutation.

ALTER TABLE `confirmations` ADD COLUMN `verdict` TEXT NOT NULL DEFAULT 'affirm';
--> statement-breakpoint

ALTER TABLE `confirmations` ADD COLUMN `reason` TEXT;
