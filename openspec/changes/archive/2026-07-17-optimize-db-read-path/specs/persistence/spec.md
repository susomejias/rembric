## MODIFIED Requirements

### Requirement: The data store MUST be SQLite with extensions

The server SHALL use a single SQLite database file (default `~/.rembric/data.db`, override via `REMBRIC_DATA_DIR`) opened via `better-sqlite3`, with the `sqlite-vec` extension loaded and FTS5 enabled.

On the **writable** connection, initialization SHALL apply the following pragmas, in this order, before running migrations:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`
- `cache_size = -65536` (64 MB page cache)
- `mmap_size = 268435456` (256 MB)
- `temp_store = MEMORY`

The server SHALL run `PRAGMA optimize` after migrations complete on startup, and again on graceful `close()`, so the query planner has up-to-date `sqlite_stat1` statistics. `PRAGMA optimize` (and any explicit `ANALYZE`) SHALL run ONLY on the writable connection.

On the **read-only** connection (e.g. the CLI `status` path), initialization SHALL apply the read-only-safe pragmas — `busy_timeout = 5000`, `cache_size = -65536`, `mmap_size = 268435456`, `temp_store = MEMORY` — and SHALL NOT apply the write pragmas (`journal_mode`, `synchronous`, `foreign_keys`) nor `PRAGMA optimize`/`ANALYZE`. WAL mode is a persistent property of the database file, so a read-only connection observes it without setting it.

#### Scenario: Cold start with missing data dir

- **GIVEN** `REMBRIC_DATA_DIR` points at a path that does not exist
- **WHEN** the server starts
- **THEN** the server SHALL create the directory with mode 0700, create the DB file, load `sqlite-vec`, apply the writable-connection pragmas (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `cache_size=-65536`, `mmap_size=268435456`, `temp_store=MEMORY`), and apply all pending migrations

#### Scenario: Query planner statistics are refreshed

- **WHEN** the server finishes applying migrations on startup, and again when it shuts down gracefully
- **THEN** it SHALL run `PRAGMA optimize` on the writable connection so `sqlite_stat1` reflects current table shapes

#### Scenario: Read-only connection avoids write pragmas but keeps a busy timeout

- **GIVEN** the CLI `status` path opens the database read-only
- **WHEN** the connection is initialized
- **THEN** it SHALL set `busy_timeout=5000`, `cache_size`, `mmap_size`, and `temp_store`, and SHALL NOT execute `journal_mode`, `synchronous`, `foreign_keys`, `PRAGMA optimize`, or `ANALYZE`

#### Scenario: sqlite-vec failed to load

- **WHEN** the server is started and `sqlite-vec` cannot be loaded
- **THEN** the server SHALL exit with a non-zero code and a clear error message instructing the operator about installation requirements

## ADDED Requirements

### Requirement: The `memory` table MUST carry a recency index for context reads

The schema SHALL provide an index that serves `MemoryService.recentForContext` — the `memory.context` hot path — which orders by most-recent activity within a scope. Because activity recency is `last_seen_at` when present and otherwise `created_at`, the index SHALL be an expression index over the same `COALESCE`:

```
CREATE INDEX memory_scope_seen_idx
  ON memory (scope, project_id, COALESCE(last_seen_at, created_at) DESC)
```

The ordering expression emitted by the repository query SHALL be textually equivalent to the indexed expression (identical `COALESCE(last_seen_at, created_at)` shape and column identifiers) so the planner selects the index. The `status != 'archived'` predicate SHALL remain a residual filter applied while walking the index in order, preserving the `LIMIT` early-stop. Adding the index is index-only DDL and requires no table rebuild.

#### Scenario: recentForContext uses the index instead of a scan

- **GIVEN** the `memory_scope_seen_idx` index exists
- **WHEN** `EXPLAIN QUERY PLAN` is run on the `recentForContext` query
- **THEN** the plan SHALL report `SEARCH memory USING INDEX memory_scope_seen_idx` and SHALL NOT report `SCAN memory` with `USE TEMP B-TREE FOR ORDER BY`

#### Scenario: recentForContext returns the same rows as before the index

- **GIVEN** a scope with a mix of `active`, `superseded`, and `archived` memories, some with `last_seen_at` set and some NULL
- **WHEN** `recentForContext` is queried with a `limit`
- **THEN** it SHALL return the same rows in the same order as an equivalent scan-based query ordering by `COALESCE(last_seen_at, created_at) DESC`
