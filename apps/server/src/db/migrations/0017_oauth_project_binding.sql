-- 0017_oauth_project_binding.sql
--
-- Bind each OAuth grant to the project it was consented for (2026-07-11
-- auth-surface hardening, finding #3). Two nullable columns — additive, so no
-- table-rebuild / FK-drop dance. Legacy grants carry NULL project_id; to avoid
-- any pre-binding token surviving as globally scoped, every still-active
-- oauth_tokens row is REVOKED here (force re-consent, maintainer decision).
-- After this migration NULL project_id unambiguously means a NEW global grant.

ALTER TABLE oauth_authorization_codes ADD COLUMN project_id text;
--> statement-breakpoint
ALTER TABLE oauth_tokens ADD COLUMN project_id text;
--> statement-breakpoint
UPDATE oauth_tokens
SET revoked_at = (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE revoked_at IS NULL;
