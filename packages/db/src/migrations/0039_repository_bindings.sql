CREATE TABLE project_repositories (
  fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  remotes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (fingerprint, project_id)
);

CREATE INDEX project_repositories_project_idx ON project_repositories (project_id);

CREATE TABLE repository_pending (
  id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  remotes TEXT NOT NULL,
  root_name TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  discarded_at INTEGER,
  CONSTRAINT repository_pending_kind_check CHECK (kind IN ('unbound', 'suggestion', 'unknown_remote'))
);

CREATE UNIQUE INDEX repository_pending_identity_uidx
  ON repository_pending (fingerprint, kind, coalesce(project_id, ''));

CREATE TABLE repository_pending_tokens (
  pending_id TEXT NOT NULL REFERENCES repository_pending(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL,
  PRIMARY KEY (pending_id, token_id)
);

CREATE INDEX repository_pending_tokens_token_idx ON repository_pending_tokens (token_id);
