-- Derived reverse-edge table over `memory.replaces` (a JSON array, forward
-- direction only: "what this row replaces"). `findSuccessorId` and the
-- purge predicate's disconnection check both need the reverse direction
-- ("what replaces this row"), which today costs a full-table json_each
-- scan. This table makes that a primary-key probe. It is derived data,
-- never authoritative, and is reconstructible at any time by re-running
-- the backfill below — `memory.replaces` remains the source of truth.

CREATE TABLE `memory_replaces` (
  `predecessor_id` TEXT NOT NULL,
  `successor_id` TEXT NOT NULL,
  PRIMARY KEY (`predecessor_id`, `successor_id`)
) WITHOUT ROWID;
--> statement-breakpoint

INSERT INTO memory_replaces (predecessor_id, successor_id)
SELECT je.value, m.id
  FROM memory m, json_each(m.replaces) je;
--> statement-breakpoint

CREATE TRIGGER `memory_replaces_ai` AFTER INSERT ON `memory` BEGIN
  INSERT INTO memory_replaces (predecessor_id, successor_id)
  SELECT je.value, new.id FROM json_each(new.replaces) je;
END;
--> statement-breakpoint

CREATE TRIGGER `memory_replaces_au` AFTER UPDATE OF replaces ON `memory` BEGIN
  DELETE FROM memory_replaces WHERE successor_id = old.id;
  INSERT INTO memory_replaces (predecessor_id, successor_id)
  SELECT je.value, new.id FROM json_each(new.replaces) je;
END;
--> statement-breakpoint

CREATE TRIGGER `memory_replaces_ad` AFTER DELETE ON `memory` BEGIN
  DELETE FROM memory_replaces WHERE predecessor_id = old.id OR successor_id = old.id;
END;
