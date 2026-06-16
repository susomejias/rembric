-- Hybrid search: rebuild memory_vec with a scope partition key + status/type
-- metadata so the agent-facing kNN (memory.search dense branch) can pre-filter
-- scope/status/type inside the vector index. This REVERSES the 0002_vec_setup.sql
-- note "consolidation only; not on the agent retrieval hot path" and supersedes
-- its 2-column shape — do not edit 0002 (applied migrations are immutable).
--
-- vec0-specific recipe: ALTER TABLE … RENAME does NOT rename a vec0 vtable's
-- shadow tables (silent corruption) and INSERT … SELECT * fails on a column
-- mismatch, so the generic rebuild dance does not apply. Instead: stash the
-- existing vectors (+ derived metadata) into a normal table, DROP the vtable,
-- CREATE it fresh at the FINAL name, reinsert explicit columns. No re-embedding —
-- embeddings are copied as blobs.
CREATE TABLE `_memory_vec_rebuild` (
    memory_id TEXT PRIMARY KEY,
    partition_key TEXT NOT NULL,
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    embedding BLOB NOT NULL
);
--> statement-breakpoint
INSERT INTO `_memory_vec_rebuild` (memory_id, partition_key, status, type, embedding)
SELECT v.memory_id,
       coalesce(m.project_id, '__global__'),
       m.status,
       m.type,
       v.embedding
FROM memory_vec v
    JOIN memory m ON m.id = v.memory_id;
--> statement-breakpoint
DROP TABLE memory_vec;
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_vec` USING vec0(
    memory_id TEXT PRIMARY KEY,
    partition_key TEXT partition key,
    status TEXT,
    type TEXT,
    embedding FLOAT[768]
);
--> statement-breakpoint
INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
SELECT memory_id, partition_key, status, type, embedding
FROM `_memory_vec_rebuild`;
--> statement-breakpoint
DROP TABLE `_memory_vec_rebuild`;
--> statement-breakpoint
-- Mirror memory.status into the vec0 metadata so the dense branch's status
-- filter stays correct. Same pattern as the memory_fts triggers (on the base
-- table, never ON the vtable — vec0 forbids triggers on a virtual table).
-- partition_key/type are immutable per memory, so only status is synced.
CREATE TRIGGER `memory_vec_status_sync` AFTER UPDATE OF status ON memory BEGIN
    UPDATE memory_vec SET status = new.status WHERE memory_id = new.id;
END;
