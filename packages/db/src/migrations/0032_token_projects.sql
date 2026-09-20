-- 0032_token_projects.sql
--
-- Which projects a set-scoped token (`projects` / `read:projects`) reaches.
--
-- Purely additive: one CREATE TABLE, nothing else. In particular `tokens` is
-- NOT rebuilt — `tokens_project_scope_check`'s first disjunct is
-- `project_id IS NULL`, which already admits any scope string alongside a NULL
-- binding, and that is the shape both set arms use.
--
-- Both foreign keys are real, so a project slug written where an id belongs is
-- rejected by SQLite rather than by convention. WITHOUT ROWID because the table
-- is nothing but its composite key: the primary-key index IS the table, so a
-- rowid would be a second copy of the same two columns. No secondary index —
-- every read is keyed by `token_id`, the leading column of that key.
--
-- A later per-project access verb is additive from here:
-- `ALTER TABLE token_projects ADD COLUMN access TEXT NOT NULL DEFAULT 'write'`
-- is accepted on the populated table (the DEFAULT is what makes it so).

CREATE TABLE `token_projects` (
  `token_id` TEXT NOT NULL REFERENCES `tokens`(`id`),
  `project_id` TEXT NOT NULL REFERENCES `projects`(`id`),
  PRIMARY KEY (`token_id`, `project_id`)
) WITHOUT ROWID;
