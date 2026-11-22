CREATE TABLE memory_pin_events (
  id INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  action TEXT NOT NULL,
  cause TEXT NOT NULL,
  run_id TEXT REFERENCES consolidation_runs(id),
  actor TEXT,
  event_ts INTEGER NOT NULL,
  CONSTRAINT memory_pin_events_action_check CHECK (action IN ('pin', 'unpin'))
);

CREATE INDEX memory_pin_events_memory_idx ON memory_pin_events (memory_id);

CREATE INDEX memory_pin_events_project_idx ON memory_pin_events (project_id, memory_id);
