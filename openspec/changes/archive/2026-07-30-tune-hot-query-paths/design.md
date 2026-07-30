## Context

Every query method in the thirteen repositories plus `db/diagnostics.ts` was audited with `EXPLAIN QUERY PLAN` and timed at 1k / 20k / 50k, on a corpus with realistic ~1.3KB bodies, 768-dim embeddings for every row, ~1.35 confirmations per memory, 6 scopes, and ~18 entities per memory (571MB file at 50k). Session-scoped findings were re-measured on a second corpus with 50 000 sessions, because `sessions` grows with agent activity rather than corpus size and the two do not track each other.

`EXPLAIN QUERY PLAN` was the primary detector rather than wall-clock, deliberately: a `SCAN` is invisible at the 400 rows a real installation has today and fatal at 50k. Several findings here measure fine at present size and are included because their plan shows unbounded growth.

## Decisions

**D1 — Rank by `call frequency × measured cost`, and say plainly where cost does not matter.** The dashboard is one human clicking occasionally; a 100ms page render is not a problem and optimising it is not free. Dashboard items are included here only where the plan shows growth that will not stay acceptable (`adminListEntities` aggregating an entire join, `adminListWithContent` scanning all relations) or where the fix is trivially cheap. The per-turn items — `searchMemoryIds`, `linkMemory`, `findActiveForTransport`, the entity branch — are where the value is.

**D2 — Prefer an index over a rewrite, and prove the planner uses it.** Established by the sibling change: a `LEFT JOIN` rewrite everyone assumed was the obvious fix for the needs-review subqueries is a _pessimisation_ at 50k. Every rewrite proposed here was measured against the status quo and each one wins; the ones that lost are recorded below rather than dropped. And an index nobody's plan selects is pure write cost, so each proposed index was created and the plan re-captured.

**D3 — Replacing a prefix-redundant index is free.** `memory(scope, project_id, status, created_at)` strictly contains `memory_scope_project_status_idx`, so adding one and dropping the other is index-count neutral; measured write delta −0.0006ms/save. Same shape for `memory(status, created_at)` making `memory_status_last_seen_idx` droppable (verified nothing regresses — `findDecayCandidateIds` uses the scope index). This is the cheapest category of fix available and should be done first.

**D4 — `json_each(JSON.stringify(ids))` is the _good_ idiom. Migrate toward it, not away.** Its plan is `SEARCH … USING COVERING INDEX (id=?)` + `LIST SUBQUERY / SCAN json_each` — an indexed join, never a scan — and it is linear at ~0.68µs/id with no knee:

| ids                              | 10   | 400  | 1000 | 5000 | 20000       |
| -------------------------------- | ---- | ---- | ---- | ---- | ----------- |
| `json_each`                      | 0.17 | 0.16 | 0.38 | 2.78 | **13.6ms**  |
| `inArray` (literal placeholders) | 0.20 | 1.63 | 3.62 | 28.9 | **148.5ms** |

11× worse per id, and it throws above 32 766 — which is exactly the `purgeByIds` failure. Worth migrating `reviewTimestampsByIds`, `confirmationCountsByIds`, `rankingMetadataByIds` and `unsafeGetByIds` as a follow-on.

**D5 — Statistics are a correctness-of-plan issue, not a tuning knob.** Two independently-seeded 50k corpora planned the same `adminList` query differently, measuring 0.28ms against 49.8ms. And `linkMemory` degrades 61× with `sqlite_stat1` absent — the permanent state after any hard kill, since `PRAGMA optimize` only runs at open (a no-op on a populated file whose stats are already stale) and at close (never reached). Adding the indexes in D3 removes the coin-flip for those specific queries, but `ANALYZE` at boot is the general fix and costs 6–7ms. **Do this even if nothing else here ships.**

**D6 — `linkMemory`'s rewrite is about removing stats-dependence, not shaving milliseconds.** With stats present the OR chain is a `MULTI-INDEX OR` at 0.058ms and looks fine. Without them it is the degenerate `(scope=? AND project_id=?)` scope scan at 3.538ms. The row-value `(kind, value) IN (VALUES …)` form plans as a full 4-column seek **unconditionally** — 0.024ms with stats, 0.028ms without. Choosing it buys predictability on the save path, which matters more than the 2.4× best case. Note also that SQLite is only 0.069ms of the method's 0.368ms; the rest is Drizzle AST construction for 18 OR branches, so the rewrite pays twice.

## Open questions

**Q1 — Does `memory_entities.link_count` earn a trigger?** It is the only structural change proposed and the only one that can go wrong silently — a denormalised counter that drifts is worse than a slow query. It buys 3400× on the entities dashboard, which by D1 is the tier where cost matters least. Options: ship the triggers with a reconciliation check in `memory.doctor`; or accept the slow page and only fix `adminCountEntities` (4000× for free, since the join is pure waste there); or narrow to a `(kind, value)` index and drop the link-count ordering. **Leaning toward the middle option** — take the free count win, defer the counter until an operator actually complains.

**Q2 — How much of the `sessions` work is warranted?** Every session finding is inconsequential at 2k–5k sessions (0.1–3ms) and material at 50k (14–19ms). Nobody has 50k sessions today. The partial indexes are cheap and measured not to regress writes (`touchActivity` 0.0245 → 0.0180ms, insert 0.103 → 0.090ms — both _improve_), so the cost of doing it now is near zero; the question is whether it is worth the migration surface. `findActiveForTransport` is the exception and should ship regardless: it runs on **every MCP call**.

**Q3 — Is the approximate entity backlog acceptable?** `adminBacklogCount`'s 12× win comes from subtracting two index-only counts, which over-counts archived-but-scanned rows. It feeds a dashboard label and a `memory.doctor` warning thresholded at 100. An approximate count is probably fine for both, but it interacts with the archived-indexing question already open in `reconcile-specs-with-shipped-behaviour` — resolve that first.

**Q4 — Do we accept the dense-branch floor?** `knnByQueryVector` is 42ms at 50k and there is no index fix: sqlite-vec brute-forces the partition, scope/status/type _are_ pushed into the vec0 index before distance, and `k` is not the lever (k=64 → 34.6ms, k=400 → 40.5ms). Cost is linear in partition size (14.8k → 37k vectors = 2.5× rows, 2.56× time). This is the per-turn latency floor for `memory.search` and it should be recorded as such in the spec, so it is not rediscovered as a defect. Reducing it means partitioning differently or a different vector index — a much larger change.

## Resolved (operator decision, 2026-07-25)

**Q1 → middle way.** Take `adminCountEntities`' free win (the join and GROUP BY are pure waste when `singleReferenceOnly` is false — 4000×, verified identical) and **defer the denormalised `link_count` and its triggers** until an operator actually complains about the page. A counter that drifts is worse than a slow query, and this is the tier where cost matters least.

**Q2 → `findActiveForTransport` only.** It runs on every MCP call, so its expression index ships now. The remaining `sessions` indexes are deferred: every one of them is inconsequential below ~5k sessions, and nobody is near 50k. Task 5.4 (`abandonInactiveSince`) shares the expression and was gated on shipping alongside it — re-measure before including it, since the planner reverted to the status index at 50k.

**Q3 → take the arithmetic, and it is now exact.** `reconcile-specs-with-shipped-behaviour` Q2 resolved to indexing archived memories, which removes `findMissingScans`' archived filter — so `count(memory) - count(scan)` no longer over-counts and the 12× win carries no accuracy caveat. Sequence after that change lands.

**Q4 → accept the floor and record it.** ~42ms at 50k for `knnByQueryVector`, `k` is not the lever (k=64 → 34.6ms, k=400 → 40.5ms), cost linear in partition size. Writing it into the spec is the deliverable, so it is not rediscovered as a defect. Lowering it means partitioning differently or another vector index — a much larger change than this one.

## Risks

- **Behaviour change disguised as an optimisation.** Every rewrite here must be proven result-identical, not just faster. Two are already verified byte-identical (`searchBm25Ids`'s rank ordering, the `backlogCount` arithmetic); the rest need the same treatment. A pure index addition that changes a result set means the query was relying on scan order, which is a latent defect either way.
- **Dropping an index is harder to reverse than not adding one.** The five "unusable" indexes were verified absent from 120 captured plans, but a plan is evidence about the queries that exist today. Drop them in a separate commit from the additions so a bisect can separate the two.
- **Over-scoping.** This change is large by count and small by risk: most items are one line of DDL. Resist folding in the `json_each` migration (D4) or the `reviewTimestampsByIds` follow-on — they are correct but they are not this change.
- **The numbers are from one machine.** They establish the _ordering_ of alternatives and the _shape_ of the growth, which is what the decisions rest on — not absolute latency on any host. State them that way in the spec.
