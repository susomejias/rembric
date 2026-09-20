-- Expression index backing MemoryService.recentForContext (the memory.context
-- hot path), which orders by COALESCE(last_seen_at, created_at) DESC within a
-- scope. Without it the query is a full SCAN + TEMP B-TREE sort. The ordering
-- expression emitted by the repository must match this COALESCE shape for the
-- planner to select the index.
CREATE INDEX `memory_scope_seen_idx`
  ON `memory` (`scope`, `project_id`, COALESCE(`last_seen_at`, `created_at`) DESC);
