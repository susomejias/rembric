-- 0013_oauth_tables.sql
--
-- Additive OAuth 2.1 authorization-server state. Three new tables; the
-- static `tokens` table is untouched, so no rebuild / FK-drop dance is
-- needed. Secrets are stored hashed (same scheme as `tokens`).

CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY NOT NULL,
  client_name text,
  redirect_uris text NOT NULL,
  token_endpoint_auth_method text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE oauth_authorization_codes (
  id text PRIMARY KEY NOT NULL,
  hash text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  subject text NOT NULL,
  expires_at integer NOT NULL,
  consumed_at integer,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX oauth_authorization_codes_hash_idx ON oauth_authorization_codes (hash);
--> statement-breakpoint
CREATE TABLE oauth_tokens (
  id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  hash text NOT NULL,
  client_id text NOT NULL,
  family_id text NOT NULL,
  scope text NOT NULL,
  subject text NOT NULL,
  expires_at integer NOT NULL,
  rotated_at integer,
  revoked_at integer,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX oauth_tokens_hash_idx ON oauth_tokens (hash);
--> statement-breakpoint
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
--> statement-breakpoint
CREATE INDEX oauth_tokens_expires_at_idx ON oauth_tokens (expires_at);
