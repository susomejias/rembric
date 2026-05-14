-- 0003_sessions_and_slugs.sql
--
-- Three operations bundled together because they all land in the same
-- change set ("add-sessions-and-research-tools"):
--
--   1. Rename `projects.path` to `projects.slug`. The column previously
--      held URL-slug-shaped values (the URL regex already enforced
--      [a-zA-Z0-9_.-]+) — the rename clarifies the actual semantics:
--      slug is the cross-machine logical identity of the project, not
--      a filesystem path.
--   2. Create the `sessions` table (append-only, status FSM) plus its
--      indexes.
--   3. Add nullable `session_id` to `memory` and `confirmations` so
--      observations can anchor to their originating session.

-- 1. projects.path -> projects.slug
ALTER TABLE projects RENAME COLUMN path TO slug;
--> statement-breakpoint
DROP INDEX IF EXISTS projects_path_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX projects_slug_unique ON projects (slug);
--> statement-breakpoint

-- 2. sessions table
CREATE TABLE sessions (
  id text PRIMARY KEY NOT NULL,
  token_id text NOT NULL REFERENCES tokens(id),
  project_id text REFERENCES projects(id),
  agent text NOT NULL,
  description text,
  started_at integer NOT NULL,
  ended_at integer,
  summary text,
  status text NOT NULL DEFAULT 'active'
);
--> statement-breakpoint
CREATE INDEX sessions_token_status_idx ON sessions (token_id, status);
--> statement-breakpoint
CREATE INDEX sessions_project_started_idx ON sessions (project_id, started_at);
--> statement-breakpoint
CREATE INDEX sessions_status_started_idx ON sessions (status, started_at);
--> statement-breakpoint

-- 3. memory.session_id + confirmations.session_id
ALTER TABLE memory ADD COLUMN session_id text REFERENCES sessions(id);
--> statement-breakpoint
ALTER TABLE confirmations ADD COLUMN session_id text REFERENCES sessions(id);
--> statement-breakpoint
CREATE INDEX memory_session_idx ON memory (session_id);
--> statement-breakpoint
CREATE INDEX confirmations_session_idx ON confirmations (session_id);
