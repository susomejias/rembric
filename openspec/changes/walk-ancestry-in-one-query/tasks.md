# Tasks

Ordered so the equivalence proof exists before the code that has to satisfy it. Phase 1 is the instrument; phases 2–4 are behaviour-preserving; phase 5 is the only one that can change an observable value, and only in the dangling-id case D5 names.

## 1. Baseline, with the instrument the numbers depend on

- [ ] 1.1 Build the fresh-connection statement counter as a reusable test helper: seed the corpus on one connection, close it, reopen, then wrap `run`/`get`/`all` on the statement returned by a proxied `prepare`. Counting `prepare` calls instead undercounts (drizzle caches prepared statements — an earlier attempt saw 3 of 19). `memory-repository.perf.test.ts::explainWhileRunning` is the shape to follow; it already proxies `prepare` this way for plan capture.
- [ ] 1.2 Record the BEFORE numbers with it, as committed assertions rather than a note: save-time detection on a plain save = **2** statements, none touching `replaces`; on a save at the cap of a `topic_key` chain = **12**, of which **9** are `select "replaces" from "memory" where "id" = ?`; `memory.get` on the head of a 30-save chain = **14**, of which **11** are full-row selects. Confirm the nine — the loop breaks after inserting the tenth id and before probing it, so the incoming report's "10x" is an off-by-one.
- [ ] 1.3 Pin the shipped BFS loops verbatim in the test file as equivalence ORACLES, the way `memory-repository.perf.test.ts` keeps `LEGACY_NOT_EXISTS`. Every later assertion compares against the oracle's output, not against a hand-written expectation, so an assertion cannot silently encode the new behaviour.

## 2. The traversal, in the repository

- [ ] 2.1 `MemoryRepository.unsafeAncestorIds({ startIds, limit })` — recursive CTE seeded from `json_each(JSON.stringify(startIds))`, recursive term `SELECT je.value FROM anc, memory m, json_each(m.replaces) je WHERE m.id = anc.id`, `UNION` (not `UNION ALL`), **id-only projection** (D3 — a depth column deduplicates on the whole row and duplicates a shared ancestor), `LIMIT` on the outer select (D-risk 2 — moving the bound into JS restores O(chain) cost). Empty `startIds` returns `[]` without a query.
- [ ] 2.2 `MemoryRepository.unsafeProjectionByIds(ids)` — Drizzle builder partial select of `Pick<Memory, 'id' | 'title' | 'status' | 'createdAt'>`. Builder, not raw SQL, so `createdAt` stays schema-mapped (D6). No `ORDER BY`; the caller re-orders.
- [ ] 2.3 Assert the plan: the `memory` join reports `SEARCH … (id=?)`, and no line reports `AUTOMATIC COVERING INDEX`, `SCAN memory` or `SCAN memory_replaces`. Capture it with `explainWhileRunning` while the repository method runs, not from a reconstructed query string.
- [ ] 2.4 Record why not `memory_replaces` as an executable test, not a comment: the ancestor-direction form over the edge table plans `SEARCH mr USING AUTOMATIC COVERING INDEX (successor_id=?)`, and `sqlite_master` holds exactly one object for that table (the table itself, `WITHOUT ROWID`, no index). Re-measure the three sizes if you want the numbers refreshed — 0.0151 / 0.1654 / 1.6398 ms at 39 / 1 999 / 19 999 edges against a flat 0.0136 / 0.0147 / 0.0154 ms — but the plan line and the absent index are the durable assertions.
- [ ] 2.5 Do **not** add `memory_replaces(successor_id)` (D2). If a later change proposes it, `data-access` now carries the rejection.

## 3. Equivalence, before either call site moves

- [ ] 3.1 Five fixtures, asserting ids **and order** against the 1.3 oracles: linear chain longer than the bound; DAG with two start ids and a shared grandparent; `replaces` cycle; ancestor id with no `memory` row; fan-in wide enough to truncate mid-level (25 parents, bound 10). All five were verified equal during the proposal — the tasks re-verify against the real repository method rather than the probe.
- [ ] 3.2 Empty and degenerate inputs: `startIds: []`, a start id that does not exist, and a row whose `replaces` is `[]`. Note the failure-mode change explicitly: `json_each(NULL)` yields zero rows, but `json_each('not json')` raises `malformed JSON` where the old loop continued. The column is `text NOT NULL DEFAULT '[]'`, so decide and record that a corrupt cell SHOULD fail the save loudly rather than adding a defensive `json_valid` guard for a state no code path can produce.
- [ ] 3.3 Flatness: the same statement against a 40-deep and a 1 000-deep chain reads the same number of rows and costs the same. Measured 0.0149 ms/call at 1 000 deep with the `LIMIT` against 0.7962 ms/call without it — assert the row count and the single-statement count, and keep the timing as a recorded number rather than a threshold assertion.

## 4. Move the save path

- [ ] 4.1 Export `DISMISSAL_ANCESTRY_CAP = 10` from `services/save-time-candidates.ts`; delete `collectAncestorIds`; call `repos.memory.unsafeAncestorIds({ startIds: saved.replaces, limit: DISMISSAL_ANCESTRY_CAP })`. Drop the `PREDECESSOR_CAP` import, and strip the second justification from `PREDECESSOR_CAP`'s docstring in `services/memory.ts` so it documents only `memory.get`'s projection budget.
- [ ] 4.2 Grep-assert the decoupling: nothing outside `memory.get`'s predecessor projection reads `PREDECESSOR_CAP`, and a test changes `PREDECESSOR_CAP` (or asserts against both constants) to show suppression depth does not move with it.
- [ ] 4.3 AFTER statement counts: chained save detection **12 → 4** (1 CTE + 1 `listNotConflictTargetsForSources` + 1 vec probe + 1 FTS query); plain save **2 → 2** with still zero ancestry statements. Assert the plain-save zero — it is the case the walk was already free in, and a regression there would be a new query on every non-topic-key save.
- [ ] 4.4 Suppression behaviour end to end, through `memory.save`: a `not_conflict` dismissal two saves back is still suppressed; one beyond the bound is not; a `conflicts_with` judgment still surfaces. The `memory` capability's existing scenarios cover the one-hop and the unrelated-save cases already.

## 5. Move `memory.get`

- [ ] 5.1 `MemoryService.collectPredecessors` becomes `unsafeAncestorIds({ startIds: start.replaces, limit: PREDECESSOR_CAP + 1 })` → `truncated = ids.length > PREDECESSOR_CAP` → `unsafeProjectionByIds(ids.slice(0, PREDECESSOR_CAP))` → re-order to the id order. Narrow `MemoryWithHistory.predecessors` to `Pick<Memory, 'id' | 'title' | 'status' | 'createdAt'>[]` and make `mcp/memory-tools.ts:1098` a pass-through.
- [ ] 5.2 Assert the response is unchanged for the ordinary cases: `predecessors` in the same order, same `predecessorCount`, same `truncated` at 3 predecessors (false) and at the cap (true). `services/memory.test.ts:682` is the existing site.
- [ ] 5.3 Assert the ONE intended divergence (D5) against a dangling fixture: with an ancestor id inside the bound whose row is absent, the bound now counts that id, so `predecessorCount` may be one short of the cap while `truncated` stays true. State in the test why the state is not expected — the purge predicate refuses to purge a row another row's `replaces` references — so a future reader does not treat the fixture as a supported shape.
- [ ] 5.4 AFTER statement count for `memory.get` on a 30-save chain: **14 → 6**, and assert no statement selects `content` for a predecessor. The second half is the point of D6 — ten ~1.3 KB bodies were being read to emit ten titles.
- [ ] 5.5 Confirm no third traversal was left behind: grep for breadth-first walks of `replaces` outside `db/repositories/`. `dashboard/memories.ts:342` is a one-hop `adminGetByIds(row.replaces)` and stays; `findHead`'s forward loop is a different walk with a different terminal condition and stays.

## 6. Verify

- [ ] 6.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test`.
- [ ] 6.2 `pnpm run eval` — save-time suppression decides which pairs an agent is asked to judge, so a change here can move retrieval-adjacent behaviour even though ranking is untouched. Non-regression check, no metric change expected.
- [ ] 6.3 **Real Docker smoke against pre-existing seeded data.** Bring up `pnpm run dev:docker:up` against a database seeded before the change, then: save twice on one `topic_key` and confirm candidates behave as before; `memory.get` the chain head and diff the response against the pre-upgrade one field for field; open `/dashboard/memories/<id>` and confirm the Predecessors section still renders. No migration ships, so the check is that a populated database needs nothing — the point is proving that, not assuming it.
- [ ] 6.4 Re-run the 1.2 baseline on the upgraded stack and record the AFTER numbers next to the BEFORE ones in this file, so the archived change carries the measurement rather than the claim.

## 7. Specs and provenance

- [ ] 7.1 Confirm the delta specs still match what shipped before archiving — in particular `DISMISSAL_ANCESTRY_CAP`'s landed value, the ids-count bound, and the plan lines asserted in `data-access`. A spec that overclaims is worse than a missing one.
- [ ] 7.2 State the figures as measured-relative ordering on one host, not as absolute guarantees, wherever they appear.

## Deferred, recorded so it is not lost

- [ ] D-a Q1: renaming `findReplaces` / `findSuccessorId` into the `unsafe*` family. `data-access` says there is no unprefixed category; both are unscoped and id-keyed. Default: leave them; the tension is recorded in design.md, not fixed here.
- [ ] D-b Q2: whether `PREDECESSOR_CAP = 10` is still the right payload budget now that predecessors are a four-field projection. Answerable on its own evidence once D9's split has landed.
- [ ] D-c `tune-hot-query-paths` task 4.5 (`scopeActiveMemoryCount`, 1.09 ms per save at 50k) is the next statement-count item on this same path. It stays in that change (design.md D10); whoever runs it should reuse the 1.1 counter.
