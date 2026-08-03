-- Per-term document frequencies over `memory_fts`, for the relevance level's
-- IDF-weighted lexical component.
--
-- `fts5vocab` is a read-only view over the postings `memory_fts` already keeps:
-- it stores nothing, needs no backfill on an existing installation, and creates
-- no shadow tables of its own. It resolves `memory_fts` by name at query time,
-- so a later migration that drops and recreates `memory_fts` leaves this table
-- working with no DDL change (a read issued between the drop and the recreate
-- fails with `no such fts5 table`, which no serving request can reach —
-- migrations run before the server serves).

CREATE VIRTUAL TABLE `memory_fts_vocab` USING fts5vocab('memory_fts', 'row');
