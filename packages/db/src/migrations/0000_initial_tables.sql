-- Initial schema. Mirrors the Drizzle definitions under src/db/schema/.
-- If you change a schema file, run `npm run db:generate` to regenerate
-- migrations OR write a new numbered file by hand and add it to the
-- migrations runner.

CREATE TABLE `projects` (
    `id` text PRIMARY KEY NOT NULL,
    `path` text NOT NULL,
    `display_name` text,
    `archived_at` integer,
    `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);
--> statement-breakpoint
CREATE INDEX `projects_archived_idx` ON `projects` (`archived_at`);
--> statement-breakpoint

CREATE TABLE `memory` (
    `id` text PRIMARY KEY NOT NULL,
    `scope` text NOT NULL,
    `project_id` text,
    `type` text NOT NULL,
    `content` text NOT NULL,
    `tags` text DEFAULT '[]' NOT NULL,
    `status` text DEFAULT 'active' NOT NULL,
    `replaces` text DEFAULT '[]' NOT NULL,
    `created_at` integer NOT NULL,
    `last_seen_at` integer,
    `source` text,
    FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_scope_project_status_idx` ON `memory` (`scope`, `project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `memory_status_last_seen_idx` ON `memory` (`status`, `last_seen_at`);
--> statement-breakpoint
CREATE INDEX `memory_created_at_idx` ON `memory` (`created_at`);
--> statement-breakpoint

CREATE TABLE `confirmations` (
    `id` text PRIMARY KEY NOT NULL,
    `memory_id` text NOT NULL,
    `event_ts` integer NOT NULL,
    `source` text,
    FOREIGN KEY (`memory_id`) REFERENCES `memory`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `confirmations_memory_id_idx` ON `confirmations` (`memory_id`);
--> statement-breakpoint
CREATE INDEX `confirmations_event_ts_idx` ON `confirmations` (`event_ts`);
--> statement-breakpoint

CREATE TABLE `consolidation_runs` (
    `id` text PRIMARY KEY NOT NULL,
    `started_at` integer NOT NULL,
    `finished_at` integer,
    `llm_provider` text,
    `llm_model` text,
    `scope` text,
    `summary` text
);
--> statement-breakpoint
CREATE INDEX `consolidation_runs_started_at_idx` ON `consolidation_runs` (`started_at`);
--> statement-breakpoint

CREATE TABLE `consolidation_ops` (
    `id` text PRIMARY KEY NOT NULL,
    `consolidation_id` text NOT NULL,
    `op_type` text NOT NULL,
    `affected_ids` text NOT NULL,
    `created_id` text,
    `reasoning` text,
    `applied_at` integer NOT NULL,
    `reverted_at` integer,
    FOREIGN KEY (`consolidation_id`) REFERENCES `consolidation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `consolidation_ops_consolidation_id_idx` ON `consolidation_ops` (`consolidation_id`);
--> statement-breakpoint
CREATE INDEX `consolidation_ops_reverted_at_idx` ON `consolidation_ops` (`reverted_at`);
--> statement-breakpoint

CREATE TABLE `tokens` (
    `id` text PRIMARY KEY NOT NULL,
    `name` text NOT NULL,
    `hash` text NOT NULL,
    `scope` text NOT NULL,
    `project_id` text,
    `created_at` integer NOT NULL,
    `expires_at` integer,
    `revoked_at` integer,
    FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_name_unique` ON `tokens` (`name`);
--> statement-breakpoint
CREATE INDEX `tokens_revoked_at_idx` ON `tokens` (`revoked_at`);
--> statement-breakpoint

CREATE TABLE `dashboard_sessions` (
    `id` text PRIMARY KEY NOT NULL,
    `token_id` text NOT NULL,
    `csrf_secret` text NOT NULL,
    `created_at` integer NOT NULL,
    `expires_at` integer NOT NULL,
    `last_seen_at` integer NOT NULL,
    FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dashboard_sessions_token_id_idx` ON `dashboard_sessions` (`token_id`);
--> statement-breakpoint
CREATE INDEX `dashboard_sessions_expires_at_idx` ON `dashboard_sessions` (`expires_at`);
