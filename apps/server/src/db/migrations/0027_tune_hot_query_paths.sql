-- Hot-path index set from `tune-hot-query-paths`. Measured basis and rejected
-- alternatives: `openspec/specs/{data-access,persistence}/spec.md`.

CREATE INDEX `memory_scope_project_status_created_idx`
  ON `memory` (`scope`, `project_id`, `status`, `created_at`);
--> statement-breakpoint

DROP INDEX `memory_scope_project_status_idx`;
--> statement-breakpoint

CREATE INDEX `memory_type_in_scope_idx`
  ON `memory` (`scope`, `project_id`, `type`);
--> statement-breakpoint

CREATE INDEX `memory_status_created_idx`
  ON `memory` (`status`, `created_at`);
--> statement-breakpoint

DROP INDEX `memory_status_last_seen_idx`;
--> statement-breakpoint

-- The repository's filter must keep this COALESCE shape (same contract as 0019).
CREATE INDEX `sessions_active_transport_idx`
  ON `sessions` (`token_id`, `project_id`, COALESCE(`last_activity_at`, `started_at`) DESC)
  WHERE `status` = 'active' AND `deleted_at` IS NULL;
--> statement-breakpoint

CREATE INDEX `memory_relations_created_at_idx`
  ON `memory_relations` (`created_at`);
--> statement-breakpoint

CREATE INDEX `prompts_created_active_idx`
  ON `prompts` (`created_at`)
  WHERE `deleted_at` IS NULL;
--> statement-breakpoint

CREATE INDEX `prompts_deleted_idx`
  ON `prompts` (`deleted_at`)
  WHERE `deleted_at` IS NOT NULL;
