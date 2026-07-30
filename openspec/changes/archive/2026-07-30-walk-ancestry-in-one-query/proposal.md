## Why

`memory.save` walks the `replaces` DAG one query per ancestor. `collectAncestorIds` (`services/save-time-candidates.ts:263`) is a breadth-first loop whose body is `repo.findReplaces(id)` — a single-row `select "replaces" from "memory" where "id" = ?` — bounded by `PREDECESSOR_CAP = 10`. It runs on every save, to suppress targets the new row's ancestry already judged `not_conflict`.

Measured on this host (2026-07-29), with a statement counter installed on a **fresh** connection — drizzle caches prepared statements, so a counter installed on the connection that seeded the corpus undercounts and would report a flattering no-change:

| path                                                        | statements | of which the walk                    |
| ----------------------------------------------------------- | ---------- | ------------------------------------ |
| save-time detection, plain save (`replaces` empty)          | 2          | **0** — the walk does nothing at all |
| save-time detection, save at the cap of a `topic_key` chain | 12         | **9** `findReplaces` probes          |

Nine, not ten: the loop checks the cap after inserting the id and before probing it, so the tenth ancestor is never expanded. Wall-clock for the same ten ids, warmed, three trials of 2000 iterations against a 40-deep chain: **0.090–0.095 ms/call** for the BFS against **0.0144–0.0158 ms/call** for one recursive CTE returning the identical ids in the identical order — **6.0–6.5×**. (The incoming review reported 15× from 0.1505 / 0.0098 ms; these are host-relative figures and the ordering, not the ratio, is what the change rests on. The CTE measured here is the id-only `UNION` form, which is the form that is provably set- and order-equivalent — see design D3.)

This lands on the single **synchronous** better-sqlite3 connection shared by `/mcp`, `/api`, the dashboard and `/healthz`. Nine round trips are not nine slow queries; they are nine serialisation points on the one connection every other caller is queued behind, on the hottest write path the server has.

The same bounded walk then exists **twice**. `MemoryService.collectPredecessors` (`services/memory.ts:720`) is the same breadth-first traversal of the same DAG under the same constant; the only difference is the projection — full rows instead of ids — and it fetches those rows one `unsafeGetById` at a time. Measured: `memory.get` on a 30-save chain issues **14 statements, 11 of them full-row selects** (the requested row plus ten predecessors), and every one of those ten pulls `content` that the response is required to discard. Two traversals of one graph, in two modules, neither owned by the layer that materialises the graph.

Finally, `PREDECESSOR_CAP`'s own docstring justifies 10 as a **token budget** for `memory.get`'s payload. Dismissal suppression borrowing that number couples two unrelated decisions: raising it to show 25 predecessors would silently deepen suppression, and trimming it to 5 would silently lose dismissals an agent already made.

## What Changes

- **One bounded recursive CTE in `MemoryRepository` replaces both walks.** SQL belongs under `db/` (grep-enforced), and the ancestry graph is the memory aggregate's own edge structure — the traversal follows it there rather than being re-implemented by each consumer.
- **The CTE walks `memory.replaces` with `json_each`, NOT the `memory_replaces` edge table.** Verified rather than assumed, because the edge table is the intuitive choice and is wrong here: its primary key is `(predecessor_id, successor_id)` and `sqlite_master` holds **no index object for it at all** (it is `WITHOUT ROWID`, so the PK _is_ the table). The ancestor direction keys on `successor_id`, so SQLite builds a transient index per query — plan line `SEARCH mr USING AUTOMATIC COVERING INDEX (successor_id=?)` — costing **0.0151 / 0.1654 / 1.6398 ms** at 39 / 1 999 / 19 999 edges, i.e. linear in the whole edge table. The `memory.replaces` form plans `SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)` and is flat at **0.0136 / 0.0147 / 0.0154 ms** across the same three corpus sizes. `memory_replaces` keeps the forward hop (`findSuccessorId`), which is what it was built for.
- **Rejected: adding `memory_replaces(successor_id)`.** It would make the edge table competitive with a form that is already flat and free, at the price of a second index maintained by three triggers on the save path. An index that buys nothing over the alternative is pure write cost.
- **Dismissal suppression gets its own bound, `DISMISSAL_ANCESTRY_CAP`**, declared in `services/save-time-candidates.ts` and set to 10 — the same value, so no behaviour changes today. `PREDECESSOR_CAP` reverts to meaning only what its docstring says: `memory.get`'s projection budget. A future UX decision about predecessor payload then cannot move suppression reach, and neither can move without a spec change.
- **`memory.get` reads ancestry as ids-then-projection: 2 statements instead of 10**, and the projection is `Pick<Memory, 'id' | 'title' | 'status' | 'createdAt'>` selected through the Drizzle builder — so the ten `content` bodies are no longer read at all. `MemoryWithHistory.predecessors` narrows to that shape; the MCP response is byte-identical, because `memory-tools.ts:1098` already maps exactly those four fields.
- **The cap counts ancestor IDS in both walks, which it does not today.** `collectAncestorIds` bounds the id set; `collectPredecessors` bounds the _row_ count and keeps walking past ids with no row. The two differ only when an ancestor id has no `memory` row — a state the purge predicate structurally prevents, since it refuses to purge a row another row's `replaces` references. One cap, one meaning, and the difference is asserted against a dangling-id fixture rather than assumed away (design D5).
- Behaviour is otherwise identical, and identity is the acceptance criterion, not the hope: same ids, same order, same cap. Verified across five fixtures — linear-40, a diamond with two start ids and a shared grandparent, a 2-cycle, a dangling predecessor id, and a 25-wide fan-in truncated mid-level at the cap — ids **and order** identical in every case.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `data-access`: one ADDED requirement — bounded ancestry traversal SHALL be one recursive query owned by `MemoryRepository`, over `memory.replaces`, with the measured basis for that table choice and the rejected `memory_replaces(successor_id)` index recorded so neither is re-proposed.
- `memory`: one ADDED and three MODIFIED requirements. ADDED: dismissal suppression's ancestry bound is its own named constant, decoupled from `memory.get`'s token budget. MODIFIED: "`memory.save` MUST surface candidate conflicts at save-time" (its `replaces`-ancestry clause currently reads as one hop in one sentence and as a transitive walk in the next — the shipped behaviour is transitive-to-a-bound, and the ambiguity is resolved rather than re-published); "Supersedes-chain reads MUST be bounded and content-free" (the traversal is one bounded query whose cost is independent of both chain length and corpus size, the bound counts ancestor ids, and the predecessor read itself is now content-free rather than only the response); "Retrieval and lifecycle constants MUST be named and bounded in one place" (gains `DISMISSAL_ANCESTRY_CAP`; `PREDECESSOR_CAP` narrows to the projection bound it always claimed to be).

`persistence` is **not** modified: no schema change, no new index, no trigger change, and `memory_replaces` keeps exactly the contract it has.

## Impact

- `apps/server/src/db/repositories/memory-repository.ts` — `unsafeAncestorIds({ startIds, limit })` (the recursive CTE; `json_each` is on the requirement's allow-list of constructs the builder cannot express) and `unsafeProjectionByIds(ids)` (builder partial select, so dates and JSON columns stay drizzle-mapped and nothing is hand-hydrated). `findReplaces` stays — `consolidation/operations.ts:234` still needs the single hop for its read-modify-write.
- `apps/server/src/services/save-time-candidates.ts` — `collectAncestorIds` deleted; `findSaveTimeCandidates` calls `repos.memory.unsafeAncestorIds`; `DISMISSAL_ANCESTRY_CAP` exported here; the `PREDECESSOR_CAP` import goes.
- `apps/server/src/services/memory.ts` — `collectPredecessors` becomes two repository calls plus a re-order to the CTE's order; `MemoryWithHistory.predecessors` narrows to the four-field projection; `PREDECESSOR_CAP`'s docstring stops carrying two justifications.
- `apps/server/src/mcp/memory-tools.ts` — the `predecessors` map at `:1098` becomes a pass-through of the already-projected shape. No schema, description or response-field change.
- Tests: `db/repositories/memory-repository.perf.test.ts` (statement counts and the plan assertion, using the existing `explainWhileRunning` instrument), `services/save-time-candidates.test.ts` (suppression depth and the five equivalence fixtures), `services/memory.test.ts` (`predecessors` order, `predecessorCount`, `truncated`, the dangling fixture).
- `openspec/specs/{data-access,memory}/spec.md` — published at archive time only (`pnpm run check:spec-provenance` is CI-gated).

**Existing installations: no migration, no schema change, no derived-data invalidation.** `memory_fts`, `memory_vec`, `memory_replaces` and the three entity tables are untouched; no version marker moves, so first boot after upgrade does no rebuild and no re-embed. Deploy is a plain image upgrade against a populated database; the first save afterwards suppresses exactly the dismissals the previous build suppressed. Rollback is a plain image downgrade — nothing is written that an older build cannot read, because nothing new is written at all.

**Invariants.** Append-only untouched: the change removes reads and adds none that write. Scope-at-the-service-layer untouched: ancestry traversal follows `replaces` links, which never cross a scope, and it is `unsafe*`-prefixed exactly because it is deliberately unscoped — mirroring `MemoryService.unsafeGetById`, the method it replaces on this path. Data-access confinement is _strengthened_: two hand-rolled traversals in the service layer collapse into one repository method, and the only SQL involved moves under `db/`. Fresh-context judgment untouched: the same pairs are suppressed and the same pairs surface with the same `judgmentId`s. `topic_key` convergence untouched. Derived-never-stored review state untouched — no column, no counter, no cache.
