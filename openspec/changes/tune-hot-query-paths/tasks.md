# Tasks

Ordered so the cheapest, highest-value and least-reversible-risk work lands first. Sections 1–3 are worth doing even if nothing else ships.

## 1. The two hard failures

- [ ] 1.1 Bound the purge: batch `purgeByIds`, or switch it to the `json_each(JSON.stringify(ids))` form already used elsewhere in the same file (also 11× cheaper per id). Fix the caller too — `services/memory.ts` passing an unbounded `findPurgeableDisconnectedArchivedIds()` result is the actual defect; the 32 766 bind ceiling is only where it surfaces.
- [ ] 1.2 Test: 40 000 purgeable archived rows purge successfully. Confirm it fails before the fix.
- [ ] 1.3 Audit the other `inArray` helpers (`existingIds`, `markSupersededMany`, `reactivate`, `touchLastSeenBatch`, `unsafeGetByIds`) — all currently fed bounded lists, so decide per call site whether to bound the caller or convert the query.
- [ ] 1.4 Declare `primaryKey({ columns: [entityId, memoryId] })` and `withoutRowid` on `memoryEntityLinks`, and `withoutRowid` on `memoryEntityScan`, matching `0023_memory_entities.sql`. No migration needed — the DB already has them; this fixes the schema that claims to be the truth.

## 2. Close the drift that let 1.4 happen

- [ ] 2.1 Extend `test/schema-drift.test.ts` with an index snapshot (name + `sql` from `sqlite_master`), asserted as an exact set, not a subset. It currently snapshots tables, columns and triggers and never indexes, so this whole class is invisible to CI.
- [ ] 2.2 Record the two indexes that are genuinely inexpressible in Drizzle — `memory_topic_key_active_uidx` (expression-based, and only an expression index can enforce that uniqueness) and `memory_scope_seen_idx` (`COALESCE(last_seen_at, created_at) DESC`, from `0019`) — as explicit allow-listed entries with a comment, so they read as deliberate rather than as omissions. The comment at `schema/memory.ts:88-90` mentions the topic_key pair but not `memory_scope_seen_idx`.
- [ ] 2.3 Verify a fresh install and an upgraded install end with identical `sqlite_master` index sets.

## 3. Stop the planner coin-flip

- [ ] 3.1 Run `PRAGMA analysis_limit=1000; ANALYZE` at boot in `db/client.ts` (6–7ms at 50k), and/or `PRAGMA optimize` on an interval rather than only at close — close-time never runs on `SIGKILL`, OOM or `docker kill`, which is how a production DB ends up permanently without statistics.
- [ ] 3.2 Reproduce the instability first so the fix is evidence-backed: two independently-seeded 50k corpora planned the same `adminList(status)` query differently, 0.28ms against 49.8ms. And `linkMemory` degrades 61× with `sqlite_stat1` deleted.
- [ ] 3.3 Measure boot-time cost at 50k and confirm it does not delay `listen()` meaningfully.

## 4. Per-turn indexes and rewrites (the real value)

- [ ] 4.1 `CREATE INDEX memory_scope_project_status_created_idx ON memory(scope, project_id, status, created_at)` and **DROP** `memory_scope_project_status_idx` (strict prefix, so index-count neutral). Fixes `searchMemoryIds`' temp B-tree: 12.8–38.6ms → 0.03–0.40ms, and `includeGlobal` 27.6 → 0.06ms.
- [ ] 4.2 Rewrite `linkMemory`'s get-or-create OR chain as one row-value predicate `(kind, value) IN (VALUES …)`. Plan must become an unconditional 4-column seek. Verify with `sqlite_stat1` both present and **deleted** — the point is removing stats-dependence (0.058/3.538ms → 0.024/0.028ms), not the best-case gain.
- [ ] 4.3 `CREATE INDEX memory_type_in_scope_idx ON memory(scope, project_id, type)` — covering for `countByStatusAndTypeInScope`'s by-type group: 17.4 → 1.15ms. Note a single `GROUP BY status, type` rewrite does **not** help (20.9ms, still a temp B-tree).
- [ ] 4.4 Partial expression index for `findActiveForTransport` (**every MCP call**): `sessions (token_id, project_id, COALESCE(last_activity_at, started_at) DESC) WHERE status='active' AND deleted_at IS NULL`. 1.53 → 0.151ms and 1.38 → 0.095ms at 50k sessions.
- [ ] 4.5 `scopeActiveMemoryCount` counts the whole scope partition on every save (1.09ms at 50k, linear onward) purely as a rarity-gate denominator. Cache per `(scope, projectId)` for the request, or maintain a counter.
- [ ] 4.6 Decide on `searchBm25Ids`: `rank MATCH 'bm25(1.0,1.0,2.0)'` + `ORDER BY memory_fts.rank` removes the temp B-tree with **verified byte-identical order and set**, but the gain is marginal (mid-selectivity 16.8 → 10.9ms; match-all no gain) because the FTS scan dominates. Ship only if the diff stays small.
- [ ] 4.7 `prompts.searchByScope`'s FTS match runs twice (page + unpaginated count) on a per-turn path: 12.63ms at 50k. Skip the count when no total is rendered, or compute it only at offset 0.
- [ ] 4.8 `findMemoriesByEntity` / `findOtherMemoriesForEntity`: `ORDER BY memory.created_at DESC` forces a temp B-tree over **every** link before `LIMIT`, so cost is O(fan-out) not O(limit) — 0.13ms at typical fan-out, **5.33ms** at a 7143-link entity. No index fixes it (tested `memory(created_at DESC, status)`: 5.33 → 4.70ms). Cap fan-out or denormalise `created_at` onto the link row.

## 5. Boot and background

- [ ] 5.1 `vectors.backlogCount` → `(SELECT count(*) FROM memory WHERE status!='archived') - (SELECT count(*) FROM memory_vec WHERE status!='archived')`. `memory_vec.status` is trigger-synced; verified identical (both 137 with a 137-row backlog). 658–760ms → **48ms**. Reachable from `memory.doctor`, so an agent can trigger it.
- [ ] 5.2 `findMissingEmbeddings` — gate on the cheap count above and skip the scan when zero. Keep the LEFT JOIN for the non-empty case: it exits early (0.93ms with 137 pending); the 760ms is the steady state scanning the whole table to find nothing.
- [ ] 5.3 `entities.adminBacklogCount` → same arithmetic shape, 10.68 → 0.871ms (12×), but it over-counts archived-scanned rows. Gated on design.md Q3. Rejected alternatives, measured: `NOT EXISTS` 9.64ms, partial index 9.70ms, `LIMIT 501` cap 9.93ms.
- [ ] 5.4 `abandonInactiveSince`: the expression index `sessions (COALESCE(last_activity_at, started_at)) WHERE status='active'` gives 4× at 5k sessions but the planner reverts to the status index at 50k. Ship only alongside 4.4, which shares the expression.

## 6. Dashboard — only where growth is unbounded or the fix is free

- [ ] 6.1 `adminCountEntities({})` ≡ `SELECT count(*) FROM memory_entities` — the join and GROUP BY are pure waste when `singleReferenceOnly` is false (verified identical). 58.4 → **0.014ms**. `{kind}` → `count(*) … WHERE kind=?`, 46 → 0.71ms. **Free win, take it regardless of Q1.**
- [ ] 6.2 `CREATE INDEX memory_relations_created_at_idx ON memory_relations(created_at)` — the unfiltered judgments page has no status equality so `memory_relations_status_created_idx` cannot serve it: 115.6ms at 43k relations → **0.32ms**.
- [ ] 6.3 `adminCountWithFilters` — drop two `INNER JOIN memory` on FK→PK that cannot change a count: 13.8 → **0.00ms**.
- [ ] 6.4 `CREATE INDEX memory_status_created_idx ON memory(status, created_at)`; `memory_status_last_seen_idx` then becomes droppable (verified nothing regresses). `adminList`/`adminCount` 51.7/113.0 → 0.13/0.21ms.
- [ ] 6.5 `adminCountBySession` and its `memory` twin group the whole table to decorate 25 visible rows — pass the page's session ids: 6.29 → **0.038ms** (165×).
- [ ] 6.6 `prompts`: `created_at DESC WHERE deleted_at IS NULL` (10.9 → 0.143ms), `deleted_at WHERE deleted_at IS NOT NULL` (0.598 → 0.022ms), and rewrite `sessionIdPrefix`'s `LIKE` as an explicit range (0.606 → 0.098ms — SQLite's LIKE optimisation needs `NOCASE` and the index is BINARY).
- [ ] 6.7 `sessions` recency lists — partial indexes on `started_at DESC WHERE deleted_at IS NULL` plus one for the `activeFirst` CASE ordering. 14–19ms → 0.10–0.18ms at 50k sessions; writes measured to **improve**. Gated on design.md Q2.
- [ ] 6.8 `adminSearchFts` + `adminCountFts` duplicate identical FTS work for one render (92.1ms at 50k). Drop the exact total or cap it — `dashboard/memories.ts:163` already drops it for the `needs_review + query` case, so the precedent exists.
- [ ] 6.9 Decide Q1: materialise `memory_entities.link_count` with triggers plus `(link_count DESC, value)` and `(kind, link_count DESC, value)` — list page 92.5 → 0.027ms, page 41 → 0.047ms (3400×), one-off backfill 181ms. Design leans toward deferring; if shipped, add a reconciliation check against a recomputed count.
- [ ] 6.10 `diagnostics.readDbstatBytes` walks every page (97.8ms on 571MB) and is unbounded in DB size. Cache it or move it behind an explicit button.

## 7. Remove what nothing can use

Separate commit from the additions, so a bisect can tell them apart.

- [ ] 7.1 Drop `confirmations_event_ts_idx` — absent from all 120 captured plans; every reader takes `MAX(event_ts)` _inside_ a `memory_id`-filtered subquery, which a bare `(event_ts)` index cannot serve.
- [ ] 7.2 Drop `consolidation_ops_reverted_at_idx` (planner correctly prefers `consolidation_ops_run_id_idx`, verified at 200k ops), `oauth_tokens_expires_at_idx`, `tokens_revoked_at_idx`, `dashboard_sessions_token_id_idx`.
- [ ] 7.3 `confirmations_session_idx` is borderline — `agent-sessions-repository.ts:94`'s correlated `EXISTS` on `session_id` _could_ use it. Measure before deciding.
- [ ] 7.4 Delete `adminTopEntities` — no call site outside its own test, and it carries the same full-aggregate shape (87.3ms at 50k).

## 8. Specs

- [ ] 8.1 `data-access`: record the index contract with its measured basis, including the rejected alternatives so they are not re-proposed. Cross-reference `index-confirmation-review-reads` rather than duplicating it.
- [ ] 8.2 `persistence`: the new DDL, the dropped indexes, and a requirement that the index set is snapshot-asserted.
- [ ] 8.3 Record the dense-branch floor (design.md Q4): `knnByQueryVector` is ~42ms at 50k, `k` is not the lever (k=64 34.6ms, k=400 40.5ms), cost is linear in partition size. Writing it down stops it being rediscovered as a defect.
- [ ] 8.4 State the figures as measured-relative ordering on one machine, not as absolute guarantees.

## 9. Verify

- [ ] 9.1 **Result-identity is the acceptance criterion.** For every rewrite, assert the result set and order are unchanged. A pure index addition that changes a result set means the query relied on scan order — a latent defect either way.
- [ ] 9.2 Re-capture `EXPLAIN QUERY PLAN` for every touched query and confirm each new index is actually selected. An index nobody's plan picks is pure write cost.
- [ ] 9.3 Measure write amplification: per-save cost with the final index set (baseline 0.126ms including FTS and `memory_replaces` triggers; ~0.005ms per extra index).
- [ ] 9.4 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` · `pnpm run eval`.
- [ ] 9.5 Real Docker smoke against pre-existing seeded data: every migration applies cleanly to a populated DB, and the dashboard counters, the review queue and `memory.search` return the same rows as before.
- [ ] 9.6 If `link_count` ships, prove the triggers agree with a recomputed count after a full lifecycle (save, supersede, archive, purge, recipe-bump rebuild).
