# Tasks

Ordered so the cheapest, highest-value and least-reversible-risk work lands first. Sections 1–3 are worth doing even if nothing else ships.

## 1. The two hard failures

- [x] 1.1 Bound the purge: batch `purgeByIds`, or switch it to the `json_each(JSON.stringify(ids))` form already used elsewhere in the same file (also 11× cheaper per id). Fix the caller too — `services/memory.ts` passing an unbounded `findPurgeableDisconnectedArchivedIds()` result is the actual defect; the 32 766 bind ceiling is only where it surfaces.
  - Took the `json_each` form (D4), via a module-local `idJsonSet(ids)` helper in `memory-repository.ts`. The four DELETEs keep their existing order (`memory_vec` → `memory_entity_links` → `memory_entity_scan` → `memory`; no ON DELETE CASCADE on the entity tables). Caller now deletes in `PURGE_DELETE_SLICE = 5_000` slices inside the same transaction, so the payload of any one statement is independent of corpus size; `deletedIds` and the single journal op are unchanged.
- [x] 1.2 Test: 40 000 purgeable archived rows purge successfully. Confirm it fails before the fix.
  - Two tests, both confirmed failing with `SqliteError: too many SQL variables` when the fix is reverted: `memory-repository.perf.test.ts` calls `purgeByIds` with all 40 000 ids directly (proves the query conversion, and that the derived `memory_vec` / entity-link / entity-scan / FTS rows all go); `services/memory.test.ts` drives the whole operator path through `purgeDisconnectedArchived` (proves the sliced caller).
- [x] 1.3 Audit the other `inArray` helpers (`existingIds`, `markSupersededMany`, `reactivate`, `touchLastSeenBatch`, `unsafeGetByIds`) — all currently fed bounded lists, so decide per call site whether to bound the caller or convert the query.
  - **The premise is wrong: they are not bounded.** `findDecayCandidateIds` has no LIMIT either, so the sweep's `applyDecay` → `archiveActive(ids)` hits the same ceiling on a corpus with >32 766 decay candidates, and undoing such a `decay` op re-feeds that same list to `existingIds`, `unsafeGetByIds`, `reactivate` and `touchLastSeenBatch`. Decision: convert the query in all of them plus `archiveActive` (behaviour-neutral, one line each) rather than bound the callers, since capping the sweep would change swept-per-run semantics and needs a spec decision.
  - `markSupersededMany` has **no production call site** (tests only), so its list is trivially bounded; converted anyway to keep one idiom in the file.
  - Left on `inArray` deliberately: `reviewTimestampsByIds`, `confirmationCountsByIds`, `rankingMetadataByIds` — the read helpers design.md D4 defers as a follow-on, all fed a bounded rank window or page.
  - **Still unfixed, needs a decision:** `findDecayCandidateIds`' missing LIMIT is the root cause, and `applyDecay`/`purgeDisconnectedArchived` still write an unbounded id array into one `consolidation_ops.affected_ids` cell (~1.1MB at 40 000 ids). Not a hard failure — a single bind, far under `SQLITE_MAX_LENGTH` — so left alone.
- [x] 1.4 Declare `primaryKey({ columns: [entityId, memoryId] })` and `withoutRowid` on `memoryEntityLinks`, and `withoutRowid` on `memoryEntityScan`, matching `0023_memory_entities.sql`. No migration needed — the DB already has them; this fixes the schema that claims to be the truth.
  - **Deviation:** `primaryKey(...)` declared as specified; `withoutRowid` is **not expressible** — neither drizzle-orm 0.36.4 nor drizzle-kit 0.27.2 has any notion of `WITHOUT ROWID` (grepped both packages: zero hits). Recorded as an allow-listed inexpressible under 2.2 alongside the two expression indexes, and asserted directly against `sqlite_master` in `schema-drift.test.ts` instead. The PK is the part that carried the 2100× cliff, and that is now declared.

## 2. Close the drift that let 1.4 happen

- [x] 2.1 Extend `test/schema-drift.test.ts` with an index snapshot (name + `sql` from `sqlite_master`), asserted as an exact set, not a subset. It currently snapshots tables, columns and triggers and never indexes, so this whole class is invisible to CI.
  - `EXPECTED_INDEXES` (48 entries) asserted with `toEqual` over every index on a table we own; FTS5/vec0 shadow tables are excluded because their index set varies by extension version (same reason the existing table check tolerates extra tables). DDL normalized for backticks and line breaks only. Autoindexes are included with `sql: null`, so a table silently losing `WITHOUT ROWID` shows up as a new autoindex.
  - **The exact-set assertion immediately found a third undeclared index the proposal had not counted as inexpressible: `memory_topic_key_active_idx`.** It is expressible (plain partial index, `.where()` is supported), so it is now declared in `schema/memory.ts` rather than allow-listed.
  - Two assertions added beyond the snapshot, because an index snapshot alone does **not** catch 1.4: a `WITHOUT ROWID` set assertion, and a Drizzle-vs-`PRAGMA table_info` primary-key cross-check. Confirmed the PK check fails when 1.4's `primaryKey(...)` is reverted (`primary key drift on 'memory_entity_links'`); the index snapshot alone stayed green, which is exactly why it was not sufficient.
- [x] 2.2 Record the two indexes that are genuinely inexpressible in Drizzle — `memory_topic_key_active_uidx` (expression-based, and only an expression index can enforce that uniqueness) and `memory_scope_seen_idx` (`COALESCE(last_seen_at, created_at) DESC`, from `0019`) — as explicit allow-listed entries with a comment, so they read as deliberate rather than as omissions. The comment at `schema/memory.ts:88-90` mentions the topic_key pair but not `memory_scope_seen_idx`.
  - `DRIZZLE_INEXPRESSIBLE_INDEXES` in the drift test, plus a rewritten comment in `schema/memory.ts` naming both. Verified the claim rather than assuming it: drizzle-kit 0.27.2 splits an `sql` index expression on its commas and back-quotes each fragment as an identifier, emitting `ON memory (scope,\`COALESCE("project_id"\`,\` '')\`,topic_key)`.
  - `WITHOUT ROWID` is allow-listed the same way (1.4's deviation).
- [x] 2.3 Verify a fresh install and an upgraded install end with identical `sqlite_master` index sets.
  - `migrations.test.ts::"fresh install vs staged upgrade"` compares full `sqlite_master` (tables, indexes, triggers, DDL) between a fresh install and an upgrade cut at **every** migration boundary — 24 upgrade paths, all identical.

## 3. Stop the planner coin-flip

- [x] 3.1 Run `PRAGMA analysis_limit=1000; ANALYZE` at boot in `db/client.ts` (6–7ms at 50k), and/or `PRAGMA optimize` on an interval rather than only at close — close-time never runs on `SIGKILL`, OOM or `docker kill`, which is how a production DB ends up permanently without statistics.
  - Took the boot `ANALYZE` only, replacing the open-time `PRAGMA optimize`; the close-time `optimize` is left in place. The interval variant was **not** added: `createDb` runs on every process start, so boot-time `ANALYZE` already covers the whole post-hard-kill failure mode the design describes, and an interval needs a scheduler hook that would be new surface for no measured gain.
  - Regression test `client.test.ts::"refreshes statistics that grew stale since the last clean shutdown"`. Confirmed failing when reverted: `expected '200 200 200 1' to match /^2000 /` — statistics frozen at the pre-growth row count, precisely the reported symptom.
- [x] 3.2 Reproduce the instability first so the fix is evidence-backed: two independently-seeded 50k corpora planned the same `adminList(status)` query differently, 0.28ms against 49.8ms. And `linkMemory` degrades 61× with `sqlite_stat1` deleted.
  - **Root cause reproduced exactly.** On a corpus grown 5k → 50k memories and 2k → 20k entities then closed without the close-time hook, boot-time `PRAGMA optimize` takes **0.1 ms and does nothing**: `sqlite_stat1` still records `memory` = `5000 1` and `memory_entities` = `2000 2000 2000 2000 1`. `analysis_limit=1000; ANALYZE` costs 2.8 ms and corrects them to `50000 1` / `20000 1001 1001 1001 1`. This is the "recorded count was still 27 005 at 50k rows" finding.
  - **`linkMemory` stats-dependence reproduced, larger than reported.** With no `sqlite_stat1` at all the OR chain plans as the degenerate `SEARCH memory_entities USING INDEX memory_entities_identity_idx (scope=? AND project_id=?)` scope scan at **6.960 ms**; with statistics it plans `MULTI-INDEX OR` over 18 four-column seeks at **0.014 ms**. ~500× here versus the 61× reported — same failure, sharper on this corpus.
  - **Not reproduced:** the `adminList(status)` plan coin-flip. Both seeds planned it identically (`memory_status_last_seen_idx` + `USE TEMP B-TREE FOR ORDER BY`) at 41.7 / 42.7 / 43.0 ms — matching the reported 49.8 ms arm, never the 0.28 ms arm. The temp B-tree is not a statistics problem; 6.4's `memory(status, created_at)` is its actual fix, so this claim should be re-verified there rather than treated as settled.
- [x] 3.3 Measure boot-time cost at 50k and confirm it does not delay `listen()` meaningfully.
  - `createDb` is synchronous and runs at `server/bootstrap.ts:90`, well before `listen()`, so this is serial boot time. Full `createDb` on a 50 000-memory / 20 000-entity / 20 000-link corpus, 5 runs each: **4.0 ms median after** versus **7.0 ms median before**. The change makes boot _faster_ — `analysis_limit=1000` caps the sample, whereas `PRAGMA optimize` on a never-analyzed table runs an uncapped ANALYZE. The isolated statistics step is 2.8 ms.

## 4. Per-turn indexes and rewrites (the real value)

- [x] 4.1 `CREATE INDEX memory_scope_project_status_created_idx ON memory(scope, project_id, status, created_at)` and **DROP** `memory_scope_project_status_idx` (strict prefix, so index-count neutral). Fixes `searchMemoryIds`' temp B-tree: 12.8–38.6ms → 0.03–0.40ms, and `includeGlobal` 27.6 → 0.06ms.
- [x] 4.2 Rewrite `linkMemory`'s get-or-create OR chain as one row-value predicate `(kind, value) IN (VALUES …)`. Plan must become an unconditional 4-column seek. Verify with `sqlite_stat1` both present and **deleted** — the point is removing stats-dependence (0.058/3.538ms → 0.024/0.028ms), not the best-case gain.
- [x] 4.3 `CREATE INDEX memory_type_in_scope_idx ON memory(scope, project_id, type)` — covering for `countByStatusAndTypeInScope`'s by-type group: 17.4 → 1.15ms. Note a single `GROUP BY status, type` rewrite does **not** help (20.9ms, still a temp B-tree).
- [x] 4.4 Partial expression index for `findActiveForTransport` (**every MCP call**): `sessions (token_id, project_id, COALESCE(last_activity_at, started_at) DESC) WHERE status='active' AND deleted_at IS NULL`. 1.53 → 0.151ms and 1.38 → 0.095ms at 50k sessions.
- [x] 4.5 `scopeActiveMemoryCount` counts the whole scope partition on every save (1.09ms at 50k, linear onward) purely as a rarity-gate denominator. Cache per `(scope, projectId)` for the request, or maintain a counter.
  - **Measured and declined** (`deferred.md`): 0.184 ms/save, not the 1.09 ms reported here. Both offered fixes cost more than they buy.
- [x] 4.6 Decide on `searchBm25Ids`: `rank MATCH 'bm25(1.0,1.0,2.0)'` + `ORDER BY memory_fts.rank` removes the temp B-tree with **verified byte-identical order and set**, but the gain is marginal (mid-selectivity 16.8 → 10.9ms; match-all no gain) because the FTS scan dominates. Ship only if the diff stays small.
  - **Measured and declined** (`deferred.md`): the rewrite removes the temp B-tree and is SLOWER in all three selectivity bands (12.5→18.6, 13.9→18.6, 29.9→39.8 ms), order byte-identical. The predicted ordering is reversed on this corpus.
- [x] 4.7 `prompts.searchByScope`'s FTS match runs twice (page + unpaginated count) on a per-turn path: 12.63ms at 50k. Skip the count when no total is rendered, or compute it only at offset 0.
- [x] 4.8 `findMemoriesByEntity` / `findOtherMemoriesForEntity`: `ORDER BY memory.created_at DESC` forces a temp B-tree over **every** link before `LIMIT`, so cost is O(fan-out) not O(limit) — 0.13ms at typical fan-out, **5.33ms** at a 7143-link entity. No index fixes it (tested `memory(created_at DESC, status)`: 5.33 → 4.70ms). Cap fan-out or denormalise `created_at` onto the link row.
  - **Measured, then reverted** (`deferred.md`): the alternative is 104× with an identical result set, but equivalent only while every `memory.id` is a ULID matching its `created_at`. Follow-up `order-entity-fanout-by-link-pk`; the invariant is now pinned by a test.

## 5. Boot and background

- [x] 5.1 `vectors.backlogCount` → `(SELECT count(*) FROM memory WHERE status!='archived') - (SELECT count(*) FROM memory_vec WHERE status!='archived')`. `memory_vec.status` is trigger-synced; verified identical (both 137 with a 137-row backlog). 658–760ms → **48ms**. Reachable from `memory.doctor`, so an agent can trigger it.
  - **Not taken in any form** (`deferred.md`): the arithmetic goes negative AND cancels to zero on orphaned `memory_vec` rows. Both pinned by tests. The orphan source (`seed-dev`'s wipe) is fixed; follow-up `memory-vec-orphans-on-wipe` cleans existing databases.
- [x] 5.2 `findMissingEmbeddings` — gate on the cheap count above and skip the scan when zero. Keep the LEFT JOIN for the non-empty case: it exits early (0.93ms with 137 pending); the 760ms is the steady state scanning the whole table to find nothing.
  - **Not taken**: `EmbeddingWorker.possiblyPending` already skips this scan at the service layer, and a repository gate measured as a 325× regression in front of the `LIMIT`-bounded query it guarded.
- [x] 5.3 `entities.adminBacklogCount` → same arithmetic shape, 10.68 → 0.871ms (12×), but it over-counts archived-scanned rows. Gated on design.md Q3. Rejected alternatives, measured: `NOT EXISTS` 9.64ms, partial index 9.70ms, `LIMIT 501` cap 9.93ms.
- [x] 5.4 `abandonInactiveSince`: the expression index `sessions (COALESCE(last_activity_at, started_at)) WHERE status='active'` gives 4× at 5k sessions but the planner reverts to the status index at 50k. Ship only alongside 4.4, which shares the expression.
  - **Measured, no index added** (`deferred.md`): 4.4's index carries an equality prefix this sweep has no predicate for; measured effect nil.

## 6. Dashboard — only where growth is unbounded or the fix is free

- [x] 6.1 `adminCountEntities({})` ≡ `SELECT count(*) FROM memory_entities` — the join and GROUP BY are pure waste when `singleReferenceOnly` is false (verified identical). 58.4 → **0.014ms**. `{kind}` → `count(*) … WHERE kind=?`, 46 → 0.71ms. **Free win, take it regardless of Q1.**
- [x] 6.2 `CREATE INDEX memory_relations_created_at_idx ON memory_relations(created_at)` — the unfiltered judgments page has no status equality so `memory_relations_status_created_idx` cannot serve it: 115.6ms at 43k relations → **0.32ms**.
- [x] 6.3 `adminCountWithFilters` — drop two `INNER JOIN memory` on FK→PK that cannot change a count: 13.8 → **0.00ms**.
- [x] 6.4 `CREATE INDEX memory_status_created_idx ON memory(status, created_at)`; `memory_status_last_seen_idx` then becomes droppable (verified nothing regresses). `adminList`/`adminCount` 51.7/113.0 → 0.13/0.21ms.
- [x] 6.5 `adminCountBySession` and its `memory` twin group the whole table to decorate 25 visible rows — pass the page's session ids: 6.29 → **0.038ms** (165×).
- [x] 6.6 `prompts`: `created_at DESC WHERE deleted_at IS NULL` (10.9 → 0.143ms), `deleted_at WHERE deleted_at IS NOT NULL` (0.598 → 0.022ms), and rewrite `sessionIdPrefix`'s `LIKE` as an explicit range (0.606 → 0.098ms — SQLite's LIKE optimisation needs `NOCASE` and the index is BINARY).
- [x] 6.7 `sessions` recency lists — partial indexes on `started_at DESC WHERE deleted_at IS NULL` plus one for the `activeFirst` CASE ordering. 14–19ms → 0.10–0.18ms at 50k sessions; writes measured to **improve**. Gated on design.md Q2.
  - **Deferred by operator decision Q2** (`deferred.md`).
- [x] 6.8 `adminSearchFts` + `adminCountFts` duplicate identical FTS work for one render (92.1ms at 50k). Drop the exact total or cap it — `dashboard/memories.ts:163` already drops it for the `needs_review + query` case, so the precedent exists.
- [x] 6.9 Decide Q1: materialise `memory_entities.link_count` with triggers plus `(link_count DESC, value)` and `(kind, link_count DESC, value)` — list page 92.5 → 0.027ms, page 41 → 0.047ms (3400×), one-off backfill 181ms. Design leans toward deferring; if shipped, add a reconciliation check against a recomputed count.
  - **Deferred by operator decision Q1** (`deferred.md`), but the basis moved: 1487 ms at the declared entity density, not 98.7 ms.
- [x] 6.10 `diagnostics.readDbstatBytes` walks every page (97.8ms on 571MB) and is unbounded in DB size. Cache it or move it behind an explicit button.

## 7. Remove what nothing can use

Separate commit from the additions, so a bisect can tell them apart.

- [x] 7.1 Drop `confirmations_event_ts_idx` — absent from all 120 captured plans; every reader takes `MAX(event_ts)` _inside_ a `memory_id`-filtered subquery, which a bare `(event_ts)` index cannot serve.
- [x] 7.2 Drop `consolidation_ops_reverted_at_idx` (planner correctly prefers `consolidation_ops_run_id_idx`, verified at 200k ops), `oauth_tokens_expires_at_idx`, `tokens_revoked_at_idx`, `dashboard_sessions_token_id_idx`.
- [x] 7.3 `confirmations_session_idx` is borderline — `agent-sessions-repository.ts:94`'s correlated `EXISTS` on `session_id` _could_ use it. Measure before deciding.
- [x] 7.4 Delete `adminTopEntities` — no call site outside its own test, and it carries the same full-aggregate shape (87.3ms at 50k).

## 8. Specs

- [x] 8.1 `data-access`: record the index contract with its measured basis, including the rejected alternatives so they are not re-proposed. Cross-reference `index-confirmation-review-reads` rather than duplicating it.
- [x] 8.2 `persistence`: the new DDL, the dropped indexes, and a requirement that the index set is snapshot-asserted.
- [x] 8.3 Record the dense-branch floor (design.md Q4): `knnByQueryVector` is ~42ms at 50k, `k` is not the lever (k=64 34.6ms, k=400 40.5ms), cost is linear in partition size. Writing it down stops it being rediscovered as a defect.
- [x] 8.4 State the figures as measured-relative ordering on one machine, not as absolute guarantees.

## 9. Verify

- [x] 9.1 **Result-identity is the acceptance criterion.** For every rewrite, assert the result set and order are unchanged. A pure index addition that changes a result set means the query relied on scan order — a latent defect either way.
- [x] 9.2 Re-capture `EXPLAIN QUERY PLAN` for every touched query and confirm each new index is actually selected. An index nobody's plan picks is pure write cost.
- [x] 9.3 Measure write amplification: per-save cost with the final index set (baseline 0.126ms including FTS and `memory_replaces` triggers; ~0.005ms per extra index).
- [x] 9.4 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` · `pnpm run eval`.
- [x] 9.5 Real Docker smoke against pre-existing seeded data: every migration applies cleanly to a populated DB, and the dashboard counters, the review queue and `memory.search` return the same rows as before.
- [x] 9.6 If `link_count` ships, prove the triggers agree with a recomputed count after a full lifecycle (save, supersede, archive, purge, recipe-bump rebuild).
  - Moot: conditional on 6.9, which did not ship.
