-- 0033_session_summary_versions.sql
--
-- Every curated session-summary write appends a version row in the same
-- transaction as the `sessions.summary` UPDATE it records — see
-- `services/agent-sessions.ts` and `openspec/specs/sessions/spec.md`,
-- "Every curated session-summary write MUST append a version row in the
-- same transaction". Purely additive: one CREATE TABLE, one named unique
-- index, no rebuild of `sessions`, no backfill.
--
-- No backfill: a version row asserts that its `content` was the stored
-- summary as of its `created_at`, and for a pre-existing curated summary
-- that timestamp is not recorded anywhere on `sessions`. Pre-existing
-- sessions start with an empty history; their next curated write starts
-- the history at `version = 1` with the NEW content.
--
-- No `CHECK` on `content` length: the cap is `SUMMARY_MAX_CHARS`, enforced
-- solely in the server, and a value-pinning `CHECK` would make the cap
-- require a migration.
--
-- `ON DELETE CASCADE`: purge-eligibility already requires a NULL summary,
-- and a session with a version row has a non-NULL summary by the invariant
-- above, so the cascade is unreachable under today's predicate. It exists
-- so a purge batch (`purgeByIds`, one `DELETE FROM sessions WHERE id IN
-- (…)`) never aborts with `FOREIGN KEY constraint failed` if that ever
-- ceases to hold.

CREATE TABLE `session_summary_versions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `session_id` TEXT NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `version` INTEGER NOT NULL,
  `content` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_summary_versions_session_version_unq`
  ON `session_summary_versions` (`session_id`, `version`);
