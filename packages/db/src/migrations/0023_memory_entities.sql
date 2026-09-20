-- Derived entity index (add-entity-index): `memory_entities` is the
-- normalized (scope, project, kind, value) referent, `memory_entity_links`
-- joins memories to the entities their title+content mention, and
-- `memory_entity_scan` records which memories have already been scanned so
-- the resumable backfill worker can tell "processed, found nothing" apart
-- from "not yet processed" — a plain LEFT JOIN over the link table alone
-- can't make that distinction, unlike the embedding table where every row
-- always gets exactly one embedding.
--
-- All three tables are pure derived data, reconstructible at any time from
-- `memory.title`/`memory.content` alone via the extractor in
-- `services/entities.ts` — never authoritative, never hand-edited. No
-- change to `memory` itself: extraction runs in application code (it needs
-- the JS regex extractor, which a SQL trigger cannot run), not via a
-- trigger on INSERT, so there is no table-rebuild/FK dance here.

CREATE TABLE `memory_entities` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `scope` TEXT NOT NULL,
  `project_id` TEXT REFERENCES `projects`(`id`),
  `kind` TEXT NOT NULL,
  `value` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX `memory_entities_identity_idx`
  ON `memory_entities` (`scope`, `project_id`, `kind`, `value`);
--> statement-breakpoint

CREATE TABLE `memory_entity_links` (
  `entity_id` TEXT NOT NULL REFERENCES `memory_entities`(`id`),
  `memory_id` TEXT NOT NULL REFERENCES `memory`(`id`),
  PRIMARY KEY (`entity_id`, `memory_id`)
) WITHOUT ROWID;
--> statement-breakpoint

CREATE INDEX `memory_entity_links_memory_idx` ON `memory_entity_links` (`memory_id`);
--> statement-breakpoint

CREATE TABLE `memory_entity_scan` (
  `memory_id` TEXT PRIMARY KEY NOT NULL REFERENCES `memory`(`id`),
  `scanned_at` INTEGER NOT NULL
) WITHOUT ROWID;
