-- 0018_agent_sessions_bridge_instance.sql
-- change set ("fix-cross-session-misattribution"):
--   Add a nullable `bridge_instance_id` column to `sessions` so MCP
--   tool-call session auto-attachment (memory.save / memory.confirm /
--   memory.session_summary) can disambiguate concurrently active sessions
--   under one token by the calling MCP bridge's stable instance id,
--   instead of falling back to "most recently started active session"
--   with no transport identity at all. Additive, no backfill — existing
--   rows get `bridge_instance_id = NULL`.

ALTER TABLE sessions ADD COLUMN bridge_instance_id TEXT;
--> statement-breakpoint

CREATE INDEX `sessions_token_bridge_instance_idx` ON `sessions` (`token_id`, `bridge_instance_id`);
