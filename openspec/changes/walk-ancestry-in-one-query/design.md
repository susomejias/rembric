## Context

Every measurement below was taken on this host on 2026-07-29 against a migrated temp database, and every one of them is re-runnable. They establish an ORDERING between alternatives and the SHAPE of the growth, not absolute latency on any machine.

Two independent breadth-first walks of the same `replaces` DAG exist:

| walk                                | owner                              | projection | cap counts | statements at the cap                                |
| ----------------------------------- | ---------------------------------- | ---------- | ---------- | ---------------------------------------------------- |
| `collectAncestorIds`                | `services/save-time-candidates.ts` | ids        | ids        | 9 × `select "replaces" … where "id" = ?`             |
| `MemoryService.collectPredecessors` | `services/memory.ts`               | full rows  | **rows**   | 10 × `unsafeGetById` (whole row, `content` included) |

Nine and not ten because `collectAncestorIds` checks the cap after inserting the id and before expanding it, so the tenth ancestor is reached but never probed. The incoming review reported ten; the off-by-one is in the report, not the code.

Measured statement counts, counter installed on a **fresh** connection:

- save-time detection, plain save (`replaces` empty): **2** statements, none from the walk. The walk is a no-op for every save that carries no `topic_key` and no judged `supersedes`.
- save-time detection, save at the cap of a `topic_key` chain: **12** statements — 9 `findReplaces`, 1 `listNotConflictTargetsForSources`, 1 vec probe, 1 FTS query.
- `memory.get` on the head of a 30-save chain: **14** statements, 11 of them full-row selects.

Wall clock for the ten ids, warmed, three trials of 2000 iterations, 40-deep chain: BFS **0.090 / 0.090 / 0.095 ms**, one recursive CTE **0.0145 / 0.0144 / 0.0158 ms**. Ratio **6.0–6.5×**. The review reported 15× (0.1505 / 0.0098); the direction is the same and the gap is host noise plus a different CTE form — the form measured here is the id-only `UNION` one, which is the form that is provably equivalent (D3).

The instrument matters more than the numbers. A counter installed on the connection that seeded the corpus sees only statements prepared since it was installed, because drizzle caches prepared statements; an earlier attempt saw 3 of 19 and would have reported a flattering no-change. Every count above comes from a connection opened after the corpus was built, with the counter wrapping `run`/`get`/`all` on the returned statement rather than counting `prepare` calls.

## Goals / Non-Goals

**Goals:**

- One bounded ancestry traversal, owned by `MemoryRepository`, serving both consumers.
- Identical behaviour: same ids, same order, same cap — asserted, not assumed.
- Suppression reach decoupled from `memory.get`'s payload budget.
- `memory.get` stops reading ten memory bodies to emit ten titles.

**Non-Goals:**

- Any index, schema, trigger or migration change. Nothing is added to `memory_replaces` (D2).
- Any change to what suppression suppresses, or to the depth it reaches today. `DISMISSAL_ANCESTRY_CAP` lands at 10, the value it inherits.
- The forward direction. `findSuccessorId` and `findHead`'s 64-hop loop are a different walk with a different terminal condition (first `active` row, not a bound) and are untouched.
- `dashboard/memories.ts:342`'s one-hop `adminGetByIds(row.replaces)`. It is not a traversal and it is correct as it stands.
- The `memory.get` response shape. `predecessors[]`, `predecessorCount`, `truncated` and `headTruncated` are byte-identical.

## Decisions

**D1 — The CTE walks `memory.replaces` with `json_each`, and the edge table is measurably the wrong choice.** The reviewer flagged this as a caveat to verify; it is confirmed with numbers. `sqlite_master` holds exactly one object for `memory_replaces` — the table itself. Being `WITHOUT ROWID` with `PRIMARY KEY (predecessor_id, successor_id)`, the PK _is_ the b-tree, and there is no index whose left-most column is `successor_id`. So the ancestor direction plans `SEARCH mr USING AUTOMATIC COVERING INDEX (successor_id=?)` — SQLite builds a transient index over the whole table per call:

| recursive term                      | 39 edges | 1 999 edges | 19 999 edges |
| ----------------------------------- | -------: | ----------: | -----------: |
| `memory_replaces` on `successor_id` |   0.0151 |      0.1654 |   **1.6398** |
| `memory.replaces` + `json_each`     |   0.0136 |      0.0147 |   **0.0154** |

The `memory.replaces` form is a primary-key seek per hop (`SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)`) and is flat across a 500× corpus growth. This is the same conclusion the sibling `tune-hot-query-paths` reached about `json_each(JSON.stringify(ids))` (its D4): the idiom is an indexed join, not a scan, and it is the good one.

**D2 — Rejected: `CREATE INDEX memory_replaces_successor_idx`.** It would make the edge-table form competitive with a form that is already flat, at the cost of a second index maintained by the three `memory` triggers on every save. `tune-hot-query-paths` D2 states the rule this follows: an index nobody's plan needs is pure write cost. `memory_replaces` remains a forward-direction structure; `persistence`'s requirement for it is unchanged.

**D3 — The recursive term projects the id ALONE, because `UNION` deduplicates on the whole row.** The first form measured carried a `depth` column, which means an id reachable at two depths is emitted twice — so a diamond duplicates ancestors and burns the bound on repeats. The id-only form deduplicates exactly as the BFS `visited` set does. This is not a micro-optimisation, it is the correctness condition, and it is why the equivalence fixtures (D4) include a DAG rather than only a chain.

**D4 — Order equivalence is a verified property, not an assumption.** SQLite drives a recursive `UNION` CTE from a FIFO queue, which is breadth-first with first-occurrence dedupe — the same algorithm the JS loop runs. Verified identical ids AND identical order on five fixtures:

| fixture                                    | result                                               |
| ------------------------------------------ | ---------------------------------------------------- |
| linear chain of 40, start at the head      | `L039…L030`, order identical                         |
| diamond: two start ids, shared grandparent | `D3,D2,D1,D0` both, order identical                  |
| 2-cycle (`C1` ↔ `C2`)                      | `C1,C2` both — terminates on the dedupe, not the cap |
| dangling ancestor id                       | `G1,MISSING1` both — the id is returned by both      |
| 25-wide fan-in, bound truncates mid-level  | `WH` + `W1_0…W1_8` both, order identical             |

**D5 — The bound counts ancestor IDS in both walks, which changes `collectPredecessors` in one pathological case.** Today the id walk bounds ids and the row walk bounds _rows_, continuing past ids whose row is missing. Unifying on ids means that, if an ancestor id within the bound has no `memory` row, `predecessorCount` can be 9 with `truncated` true where today it would be 10. That state should not exist: `findPurgeableDisconnectedArchivedIds` refuses to purge a row that another row's `replaces` references, which is precisely what makes an ancestor id dangling. The alternative — bounding rows in SQL — needs an id limit that is unbounded in the number of dangling ids, i.e. it cannot be expressed as one `LIMIT`. So: one cap, one meaning, the divergence written into the spec and asserted against a dangling fixture rather than discovered later.

**D6 — `memory.get` reads ids then projects through the builder, rather than hydrating rows from raw SQL.** Two statements: `unsafeAncestorIds` (the CTE, ids only) then `unsafeProjectionByIds` (`.select({ id, title, status, createdAt })`, a builder partial select). Returning full rows from the CTE itself would mean hand-mapping `created_at` from an integer and `tags`/`replaces` from JSON text, because `db.all<T>(sql…)` bypasses drizzle's column mapping — the class of bug CLAUDE.md's "never hand-write row/DTO shapes" rule exists to prevent. The two-statement form keeps every mapping in the schema, drops `memory.get` from 14 statements to 6, and stops reading ten `content` bodies (~1.3 KB each in production) to emit ten titles. `unsafeProjectionByIds` has no `ORDER BY`, so the service re-orders to the CTE's order — the same pattern as `dashboard/memories.ts:342`, which sorts `adminGetByIds` output for the same reason.

**D7 — `MemoryWithHistory.predecessors` narrows to `Pick<Memory, 'id' | 'title' | 'status' | 'createdAt'>`.** The only production consumer is `mcp/memory-tools.ts:1098`, which already maps exactly those four fields, and `services/memory.test.ts:682` is the only test that touches the array. So the narrowing is contained, and it makes the `memory` capability's "never its `content`" clause true of the read rather than only of the response.

**D8 — `unsafe*` prefix, not `admin*`.** `data-access` requires every unscoped repository read to carry a prefix, and reserves `admin*` for dashboard-only reads — which this cannot be, since the caller is the save path. `unsafe*` is the prefix for deliberately cross-scope reads consumed by services, and the method it replaces on the `memory.get` path (`unsafeGetById`) already carries it. `findReplaces` and `findSuccessorId` remain unprefixed; renaming the id-keyed link-following family is a separate cleanup and is not folded in here.

**D9 — Two constants, same value.** `DISMISSAL_ANCESTRY_CAP = 10` in `services/save-time-candidates.ts`; `PREDECESSOR_CAP = 10` keeps its home in `services/memory.ts` and loses the second justification from its docstring. Alternatives considered: (a) leave them shared — rejected, it is the coupling this change exists to break; (b) give suppression a deeper bound now, since a dismissal is cheap to honour — rejected, it would be a behaviour change smuggled in under a refactor, with no evidence for the new value. Landing at the inherited value makes the split provably behaviour-neutral, and the next change can move either one on its own evidence.

**D10 — This belongs in its own change, not in `tune-hot-query-paths`.** They are adjacent — that change's task 4.5 is `scopeActiveMemoryCount` on this same save path, and its D5 (boot `ANALYZE`) has already landed — but folding this in would be wrong on three counts. That change is a survey of 13 repositories whose deliverable is indexes and query rewrites under the explicit banner "No behaviour change is intended anywhere", and its own Risks section says to resist folding in adjacent-but-different work. This change is not an index or a plan fix: it moves ownership of a traversal, narrows a service type, and splits a constant, and it modifies the `memory` capability, which `tune-hot-query-paths` does not touch (its deltas are `data-access` and `persistence`). And it is mid-flight with sections 1–3 applied; appending an item would blur the provenance of an audit whose value is that every claim in it was measured under one methodology. What IS shared is the instrument: whoever runs 4.5 should use the fresh-connection counter this change pins in the `data-access` spec, and 4.5 is a good candidate to sequence immediately after, since both bound statement count on the same path.

## Risks / Trade-offs

- [Risk] **A "faster" rewrite that quietly changes which dismissals are honoured.** Suppression is invisible in the response — a lost dismissal shows up as a candidate re-surfacing weeks later, which no test would attribute to this change. → Mitigation: the five D4 fixtures assert ids and order, not just membership, and they run against the shipped BFS as an oracle kept in the test rather than a hand-written expectation.
- [Risk] **The `LIMIT` is load-bearing and easy to move.** Without it the CTE walks the whole chain: 0.796 ms/call on a 1 000-deep chain against 0.0149 ms with it. A later edit that moves the bound into JS (`.slice(0, cap)`) would preserve the result and silently restore O(chain) cost. → Mitigation: spec'd in `data-access` as a `LIMIT` on the statement, plus a flatness assertion comparing a 40-deep and a 1 000-deep chain.
- [Risk] **`json_each` over `memory.replaces` depends on `replaces` holding parseable JSON, and it fails differently from the loop it replaces.** Verified: `json_each(NULL)` returns zero rows, but `json_each('not json')` raises `malformed JSON` — where `findReplaces` returned the value and the loop simply continued. So a corrupt cell that is invisible today would abort a `memory.save`. The column is `text NOT NULL DEFAULT '[]'` (migration `0000`, schema `memory.ts:67`) and `persistence` requires it to be a JSON array, so no code path can write a non-array. → Mitigation: fixtures for `[]` and for a start id whose row is missing; the NULL and malformed cases are named in tasks so the failure mode is a recorded decision (fail loudly on a corrupt cell) rather than a discovery.
- [Trade-off] **`predecessorCount` can now be less than the bound while `truncated` is true** (D5). → Accepted because the state requires a dangling ancestor id, which the purge predicate is designed to prevent, and because the alternative cannot be expressed as a single bounded statement. Written into the `memory` capability with a scenario, so it is a contract rather than a surprise.
- [Trade-off] **Narrowing `predecessors` to a four-field projection removes optionality** — a future response wanting `type` or `topicKey` on a predecessor must widen the projection. → Accepted: the capability forbids returning `content`, the current response uses exactly these four, and widening a `Pick` is a one-line change with the compiler naming every site.
- [Trade-off] **6× on a path that costs 0.09 ms is not a latency emergency.** → Accepted because the argument is statement count on a single synchronous connection, not milliseconds: nine round trips on every topic-key save are nine points at which `/healthz`, the dashboard and every other MCP client wait. The altitude fix — one traversal instead of two, owned by the layer that owns the graph — would be worth doing at parity.

## Open questions

**Q1 — Should `findReplaces` and `findSuccessorId` be renamed into the `unsafe*` family?** `data-access` says there is "no third, unprefixed category" and that every unscoped read must carry a prefix, yet both of these are unscoped, id-keyed and reachable from agent-facing paths. They cannot leak cross-scope rows in any meaningful sense — a `replaces` link never crosses a scope — which is presumably why they were left alone. Default if nobody objects: leave them, and note the tension here rather than renaming a family in a change about traversal cost.

**Q2 — Does the shipped `PREDECESSOR_CAP = 10` still fit `memory.get`'s token budget now that predecessors are read as a four-field projection?** Not answered here, and deliberately: the answer is a payload-budget measurement, and the whole point of D9 is that it can now be answered without touching suppression.
