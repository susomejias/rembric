-- 0004_prompts.sql
--
-- Persist agent prompts (user requests) so `memory.context.recentPrompts`
-- can surface them to the next session. Append-only. Indexed by
-- (project_id, created_at) for the recency query.

CREATE TABLE prompts (
  id text PRIMARY KEY NOT NULL,
  session_id text REFERENCES sessions(id),
  project_id text REFERENCES projects(id),
  content text NOT NULL,
  agent text,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX prompts_project_created_idx ON prompts (project_id, created_at);
--> statement-breakpoint
CREATE INDEX prompts_session_idx ON prompts (session_id);
