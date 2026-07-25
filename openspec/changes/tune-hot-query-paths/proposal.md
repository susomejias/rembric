## Why

A full audit of every query method in all thirteen repositories plus `db/diagnostics.ts`, with `EXPLAIN QUERY PLAN` captured for each and wall-clock measured at 1k / 20k / 50k memories (and separately at 50k **sessions**, since `sessions` scales with agent activity rather than corpus size). One Node process, one **synchronous** better-sqlite3 connection: a slow query does not slow one request, it stalls every MCP client, the HTTP API, the dashboard and `/healthz` together.

Most of the codebase is genuinely clean — `projects`, `oauth`, `dashboard-sessions`, `tokens` and `consolidation` are clean end to end, and `recentForContext`'s `COALESCE(...) DESC` ordering is already served by the expression index added in `0019`. What the audit found is concentrated in three groups.

**1. Two latent hard failures that are not about speed at all.**

- `purgeByIds` builds one bind variable per id and `MemoryService.purgeDisconnectedArchived` feeds it the **unbounded** result of `findPurgeableDisconnectedArchivedIds()`. Reproduced: 40 000 purgeable archived rows → `SqliteError: too many SQL variables` (SQLite's ceiling is 32 766). The transaction rolls back so nothing corrupts, but the operator purge simply becomes impossible past that point. The same ceiling is latent in every `inArray` helper (`existingIds`, `markSupersededMany`, `reactivate`, `touchLastSeenBatch`, `unsafeGetByIds`) — all currently fed bounded lists.
- **The Drizzle schema for `memory_entity_links` declares neither the composite `PRIMARY KEY (entity_id, memory_id)` nor `WITHOUT ROWID`, both of which `0023_memory_entities.sql` creates.** Today the database has them and every entity read is a PK seek at 0.036ms. Under the schema the code claims is the truth there is no index on `entity_id` at all: measured **76.9ms**, a 2100× cliff, with `entityLinkCount` going 0.045 → 51.9ms. `memory_entity_scan` is likewise `WITHOUT ROWID` in SQL and a plain rowid table in Drizzle. A `db:generate` would "correct" this in the wrong direction.

**2. The drift that lets group 1 exist, and a planner coin-flip.**

`apps/server/src/test/schema-drift.test.ts` snapshots tables, columns and triggers — **never indexes** — and `migrations/meta/` holds only `_journal.json`. So the entire divergence class is invisible to CI. Five live objects on `memory` and the entity tables exist only in migration SQL. Two of them are legitimately inexpressible in Drizzle (`memory_topic_key_active_uidx` is expression-based; `memory_scope_seen_idx` is an expression index on `COALESCE(last_seen_at, created_at) DESC`) and must simply be recorded as such; the entity-table ones are plain omissions.

Separately, `client.ts` runs `PRAGMA optimize` at open and close, and its re-analyze heuristic only fires on a ~10× row-count change. At 50k rows the recorded `sqlite_stat1` count was still 27 005. Consequences measured: across two independently-seeded 50k corpora the **same** `adminList(status)` query planned differently and measured **0.28ms against 49.8ms**, purely on which index the planner guessed; and `linkMemory` degrades **61×** (0.058 → 3.538ms) with `sqlite_stat1` absent — which is the state a production database sits in permanently after any `SIGKILL`, OOM or `docker kill`, because close-time `optimize` never runs. A full `ANALYZE` costs 6–7ms at 50k.

**3. Real per-turn and growth-unbounded costs.** Headlines, all measured at 50k:

| path                                                                                   | frequency                         | now                      | after               |
| -------------------------------------------------------------------------------------- | --------------------------------- | ------------------------ | ------------------- |
| `searchMemoryIds` (temp B-tree sorting 28k in-scope rows to return 20)                 | per-turn                          | 12.8–38.6ms              | **0.03–0.40ms**     |
| `linkMemory` get-or-create (OR chain defeats the 4-column index)                       | every `memory.save`               | 0.37ms / 3.54ms no-stats | **0.024 / 0.028ms** |
| `vectors.backlogCount` (one vec0 probe per memory row)                                 | `memory.doctor`, boot, hourly     | 658–760ms                | **48ms**            |
| `adminListEntities` / `adminCountEntities` (whole join aggregated, offset-independent) | dashboard                         | 98.7 / 61.2ms            | **0.027 / 0.014ms** |
| `relations.adminListWithContent({})` (unfiltered default page)                         | dashboard                         | 115.6ms                  | **0.32ms**          |
| sessions recency lists (no index serves `ORDER BY started_at DESC`)                    | dashboard + `memory.session_list` | 14–19ms @50k sessions    | **0.10–0.18ms**     |
| `findActiveForTransport`                                                               | **every MCP call**                | 1.53ms @50k sessions     | **0.151ms**         |

## What Changes

### Fix the two hard failures first

- Batch `purgeByIds`, or move it to the `json_each(JSON.stringify(ids))` form already used elsewhere in the same file — which is also **11× cheaper per id** (see below). Bound the caller regardless: an unbounded id list reaching SQL is the defect, the ceiling is just where it surfaces.
- Declare `primaryKey({ columns: [entityId, memoryId] })` and `withoutRowid` on `memoryEntityLinks`, and `withoutRowid` on `memoryEntityScan`.

### Close the drift, and stop the coin-flip

- Extend `schema-drift.test.ts` with an index snapshot, so a migration or a schema edit that diverges fails CI. Record the two genuinely inexpressible indexes explicitly rather than letting them read as omissions.
- Run `PRAGMA analysis_limit=1000; ANALYZE` at boot (6–7ms at 50k) and/or `PRAGMA optimize` on an interval rather than only at close. This is cheap insurance and it is independent of every index below: without it, index choice is a coin-flip on a database that crashed.

### Indexes to add

`memory(scope, project_id, status, created_at)` — replaces `memory_scope_project_status_idx`, which is a strict prefix, so **index-count neutral**; write delta measured at −0.0006ms/save. `memory(status, created_at)` — makes `memory_status_last_seen_idx` droppable. `memory(scope, project_id, type)` — covering for the `memory.stats` by-type group. `memory_relations(created_at)`. Partial indexes on `sessions` for the recency lists and for `findActiveForTransport` (an **expression** index over `COALESCE(last_activity_at, started_at)`, precedent `0019`), and on `prompts` for `created_at` and `deleted_at`.

### Query rewrites, each measured against the status quo

`linkMemory`'s OR chain → one row-value `(kind, value) IN (VALUES …)` predicate, which makes the 4-column index seek **unconditional** rather than stats-dependent. `vectors.backlogCount` and `findMissingEmbeddings` → arithmetic difference of two index-only counts (`memory_vec.status` is trigger-synced; verified identical). `adminCountEntities({})` → plain `count(*)`, the join and GROUP BY being pure waste when `singleReferenceOnly` is false. `adminCountWithFilters` → drop two FK→PK joins that cannot change a count. `adminCountBySession` (and its `memory` twin) → filter to the page's session ids instead of grouping the whole table. `prompts` `sessionIdPrefix` `LIKE` → an explicit range, since SQLite's LIKE optimisation needs `NOCASE` and the index is BINARY. Optionally `searchBm25Ids` → `rank MATCH 'bm25(...)'` with `ORDER BY memory_fts.rank`, which removes a temp B-tree with byte-identical result order.

### Materialise `memory_entities.link_count`

Trigger-maintained, plus `(link_count DESC, value)` and `(kind, link_count DESC, value)`. This is the only structural change proposed, and it is what turns the entities dashboard from 98.7ms-per-page into 0.027ms with paging that no longer costs the same at page 41 as at page 1. One-off backfill and index build measured at 181ms.

### Drop what nothing can use

`confirmations_event_ts_idx` never appeared in any of the 120 captured plans — all three readers take `MAX(event_ts)` _inside_ a `memory_id`-filtered subquery, which a bare `(event_ts)` index cannot serve. Also `consolidation_ops_reverted_at_idx`, `oauth_tokens_expires_at_idx`, `tokens_revoked_at_idx`, `dashboard_sessions_token_id_idx`. And `adminTopEntities`, which has no call site outside its own test and carries the same 87.3ms full-aggregate shape.

## Impact

Affected specs: `data-access` (the measured index contract), `persistence` (DDL, and the index-snapshot guarantee).

Affected code: one migration, `db/schema/{memory,entities,sessions,prompts,confirmations,consolidation,oauth,tokens,dashboard-sessions}.ts`, `db/repositories/{memory,vectors,relations,entities,agent-sessions,prompts}-repository.ts`, `db/client.ts`, `services/memory.ts` (the purge bound), `test/schema-drift.test.ts`.

No behaviour change is intended anywhere. That is the acceptance criterion, not a hope: a pure index addition that changes a result set means the query was relying on scan order, and the `link_count` triggers must be proven to agree with a recomputed count.

Cross-reference: `index-confirmation-review-reads` owns the `confirmations(memory_id, verdict, event_ts)` index. Worth noting there that it buys more than the needs-review reads — it also makes `reviewTimestampsByIds` covering and removes its `USE TEMP B-TREE FOR GROUP BY`, 1.86 → 0.86ms at 400 ids on the per-turn search path.
