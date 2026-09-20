-- 0012_drop_summary_length_check.sql
--
-- Remove the `sessions.summary` length CHECK introduced in 0011. The cap
-- now lives solely in the server (`SUMMARY_MAX_CHARS`), so changing it is a
-- one-line constant edit with no further table rebuilds. `memory.context`
-- truncates summaries to a display snippet (see
-- snippet-context-session-summaries), so a larger stored summary no longer
-- inflates the context payload; richer summaries support multi-agent /
-- cross-client handoff via `memory.session_get`.
--
-- Loss-free: relaxing a constraint rejects no existing rows (every stored
-- summary is <= 2000 and trivially satisfies the unconstrained column);
-- `INSERT … SELECT` copies all rows. The migration runner
-- (`apps/server/src/db/migrate.ts`) wraps this in
-- `PRAGMA foreign_keys=OFF` … `BEGIN IMMEDIATE` … `PRAGMA foreign_key_check`
-- … `COMMIT`, so the DROP of this FK parent is safe and post-rebuild
-- integrity is validated before commit. Column set, defaults and the three
-- indexes match 0011 exactly, minus the `summary` CHECK.

CREATE TABLE sessions_new (
  id text PRIMARY KEY NOT NULL,
  token_id text NOT NULL REFERENCES tokens(id),
  project_id text REFERENCES projects(id),
  agent text NOT NULL,
  description text,
  title text,
  started_at integer NOT NULL,
  ended_at integer,
  summary text,
  summary_final integer NOT NULL DEFAULT 0,
  title_final integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  deleted_at integer
);
--> statement-breakpoint

INSERT INTO sessions_new (
  id, token_id, project_id, agent, description, title,
  started_at, ended_at, summary, summary_final, title_final,
  status, deleted_at
)
SELECT
  id, token_id, project_id, agent, description, title,
  started_at, ended_at, summary, summary_final, title_final,
  status, deleted_at
FROM sessions;
--> statement-breakpoint

DROP TABLE sessions;
--> statement-breakpoint

ALTER TABLE sessions_new RENAME TO sessions;
--> statement-breakpoint

CREATE INDEX sessions_token_status_idx ON sessions (token_id, status);
--> statement-breakpoint
CREATE INDEX sessions_project_started_idx ON sessions (project_id, started_at);
--> statement-breakpoint
CREATE INDEX sessions_status_started_idx ON sessions (status, started_at);
