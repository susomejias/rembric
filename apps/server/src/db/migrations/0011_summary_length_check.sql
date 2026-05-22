-- 0011_summary_length_check.sql
--
-- Tighten `sessions.summary` to length <= 2000 chars (`SUMMARY_MAX_CHARS`).
--
-- Rationale: `memory.context.recentSessions` injects `summary` verbatim
-- into the LLM's next turn. With the prior 20,000-char zod cap, five
-- sessions could pull back ~100,000 chars of summary alone — useless as
-- priming context. The cap is enforced at every layer (service, MCP zod,
-- HTTP truncate helper); this CHECK is the defense-in-depth backstop so
-- no future write path can drift past it.
--
-- SQLite cannot ALTER an existing column to add a CHECK constraint
-- directly, so we follow the standard table-rebuild dance:
--   1. Truncate any existing row whose summary exceeds the cap. The
--      `…[truncated]` suffix is the operator-visible signal that the
--      content was server-trimmed. summary_final is NOT lifted by this
--      step — a curated row stays curated, just shorter.
--   2. Recreate the table with the CHECK constraint plus every column
--      and default the prior migrations declared (0003, 0006, 0007).
--   3. Re-create the three indexes (DROP TABLE cascades them).
--
-- Append-only invariant: `sessions.summary` is enumerated as a mutable
-- column in `apps/server/src/db/schema/agent-sessions.ts`. The migration
-- UPDATE is therefore consistent with the invariant; no immutable column
-- (`agent`, `token_id`, `project_id`, `started_at`) is touched and no row
-- is deleted. Truncation is one-way; operators wanting to preserve
-- pre-cap content SHOULD take a `sqlite3 .backup` before the upgrade.
--
-- FK safety: this rebuild DROPs `sessions`, which is the parent of
-- prompts.session_id / memory.session_id / confirmations.session_id. The
-- migration runner (`apps/server/src/db/migrate.ts`) wraps every migration
-- in `PRAGMA foreign_keys=OFF` … `PRAGMA foreign_key_check` … `COMMIT`
-- so the DROP succeeds and the post-rebuild integrity is still validated.

UPDATE sessions
   SET summary = substr(summary, 1, 1987) || '…[truncated]'
 WHERE summary IS NOT NULL
   AND length(summary) > 2000;
--> statement-breakpoint

CREATE TABLE sessions_new (
  id text PRIMARY KEY NOT NULL,
  token_id text NOT NULL REFERENCES tokens(id),
  project_id text REFERENCES projects(id),
  agent text NOT NULL,
  description text,
  title text,
  started_at integer NOT NULL,
  ended_at integer,
  summary text CHECK (summary IS NULL OR length(summary) <= 2000),
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
