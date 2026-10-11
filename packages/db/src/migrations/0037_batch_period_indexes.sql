CREATE INDEX memory_scope_project_created_id_idx
  ON memory (scope, project_id, created_at DESC, id DESC);

CREATE INDEX sessions_project_started_id_live_idx
  ON sessions (project_id, started_at DESC, id DESC)
  WHERE deleted_at IS NULL;
