-- 0029_tokens_project_binding.sql
--
-- Make a scope string that disagrees with `project_id` unrepresentable.
--
-- `tokens` is an FK PARENT of `dashboard_sessions.token_id` (0000) and
-- `sessions.token_id` (0003), and `dashboard_sessions` is populated on any
-- instance an operator has logged into.
--
-- The INSERT is a verbatim copy — no CASE, no normalisation — because every
-- pre-existing row already satisfies the CHECK for one of two reasons: the
-- dashboard passed `project_id NULL` (the NULL arm), and the dev seed paired
-- `project_id` with a scope string composed from the same id (a matching arm).
-- The malformed `project:<slug>` rows the dashboard minted before the producer
-- was corrected pass via the NULL arm and must stay inert: rewriting the segment
-- to a resolved id would activate a credential the operator has never seen work.
-- A row that did disagree would abort the migration, which is the intended
-- outcome and is covered by a test.
--
-- `tokens_revoked_at_idx` is deliberately NOT recreated: 0028 dropped it as
-- unusable and `schema-drift.test.ts` asserts the index set exactly.

CREATE TABLE tokens_new (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  hash text NOT NULL,
  scope text NOT NULL,
  project_id text,
  created_at integer NOT NULL,
  expires_at integer,
  revoked_at integer,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE no action,
  CONSTRAINT tokens_project_scope_check CHECK (
    project_id IS NULL
    OR scope = 'project:' || project_id
    OR scope = 'read:project:' || project_id
  )
);
--> statement-breakpoint

INSERT INTO tokens_new (id, name, hash, scope, project_id, created_at, expires_at, revoked_at)
SELECT id, name, hash, scope, project_id, created_at, expires_at, revoked_at FROM tokens;
--> statement-breakpoint

DROP TABLE tokens;
--> statement-breakpoint

ALTER TABLE tokens_new RENAME TO tokens;
--> statement-breakpoint

CREATE UNIQUE INDEX tokens_name_unique ON tokens (name);
