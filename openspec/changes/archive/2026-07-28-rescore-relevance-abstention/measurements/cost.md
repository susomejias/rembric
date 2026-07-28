# Enabled-path cost (tasks 5.1–5.3)

## 5.1 Query plan

`MemoryRepository.textByIds` resolves one primary-key seek per requested id:

```
SCAN je VIRTUAL TABLE INDEX 1: | SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)
```

The FIRST formulation of this read did NOT. Written the obvious way —
`FROM memory m WHERE m.id IN (SELECT value FROM json_each(?)) AND <scope>` — SQLite
has no cardinality estimate for `json_each`, so it drove from
`memory_scope_seen_idx` and bloom-filtered its way through every row in the scope:

```
SEARCH m USING INDEX memory_scope_seen_idx (scope=? AND project_id=?) | LIST SUBQUERY 1
  | SCAN json_each VIRTUAL TABLE INDEX 1: | CREATE BLOOM FILTER
```

That is a cost proportional to the corpus, on the search hot path, for a read whose
whole point is to be proportional to the gate window. The shipped form pins the id
list as the outer loop with `CROSS JOIN` (a join-order hint, not a semantic change).
Guarded permanently by `memory-repository.perf.test.ts` →
"resolves each id by primary key, and never drives from a scope index", which also
asserts the plan holds for a project scope and under `include_global`. Reverting to
the `IN` form fails **three** of its assertions (both plan assertions plus the
growth measurement below).

One caveat this section originally omitted: `db/client.ts` runs `ANALYZE` on every
writable boot, and **with statistics present all three formulations plan the same PK
seek**. The pathological plan above is therefore the _unanalyzed_ plan — reachable by
a database that was empty at boot and grew inside one process lifetime, which is
exactly the shape of a fresh install's first session. The `CROSS JOIN` is still the
right form (fastest pre-`ANALYZE`, identical post-`ANALYZE`), but the plan assertions
guard a narrower window than "every read".

The companion timing assertion was rewritten because it did not discriminate: the
rejected plan still runs in ~0.16 ms at 2 000 rows, so any absolute budget loose
enough not to flake also passes the plan being rejected. It now quadruples the table
and asserts the per-call cost does not grow with it — measured at **3.54×** on the
`IN` form against a 2.5× bound, so the revert fails.

## 5.2 Wall clock, enabled vs disabled

`scratch-gate-cost.ts` (not committed — a one-off harness, see `README.md`): a
project-scoped corpus of N rows sharing the query's vocabulary, no embedder wired so
the lexical branch and the gate read are what is being timed. 10 warm-up calls, then
100 iterations at 1k rows and 30 at 20k/50k. Enabled = `(floor 0.3, ratio 0.4)`.

The gate levels the WHOLE fused pool (see `design.md` D4/D6 — a `limit + offset`
prefix made the gate's own verdict depend on the page requested), so the read is
larger than a page: **64 rows at `limit = 8`** and **230 at `limit = 200`** on this
fixture, against a fused pool bounded by twice the rank window.

Two consecutive runs:

| rows   | limit | pool | disabled (ms)   | enabled (ms)    | added (ms)          |
| ------ | ----- | ---- | --------------- | --------------- | ------------------- |
| 1 000  | 8     | 64   | 1.025 / 1.028   | 1.171 / 1.180   | **+0.146 / +0.152** |
| 1 000  | 200   | 230  | 1.442 / 1.457   | 1.972 / 2.082   | **+0.530 / +0.625** |
| 20 000 | 8     | 64   | 12.853 / 13.145 | 13.341 / 13.435 | **+0.487 / +0.290** |
| 20 000 | 200   | 230  | 13.795 / 13.941 | 14.257 / 14.750 | **+0.462 / +0.808** |
| 50 000 | 8     | 64   | 33.286 / 33.397 | 33.588 / 33.051 | **+0.303 / −0.346** |
| 50 000 | 200   | 230  | 33.640 / 34.014 | 34.168 / 34.403 | **+0.528 / +0.389** |

Absolute added milliseconds per search, not a percentage, as required.

At the default `limit = 8` the added cost is inside run-to-run noise at 50k rows —
the sign flips between runs — and reads as ~0.15–0.5 ms at smaller corpora. At
`limit = 200` it is a consistent **+0.4 to +0.8 ms**, independent of corpus size:
the read tracks the pool, as the plan says it must.

## 5.3 Budget

Stated budget, held: **≤ 1 ms added per search at `limit = 8`, ≤ 3 ms at `limit = 200`,
measured at 50 000 rows.** Measured at 50k: **−0.35 to +0.30 ms** and
**+0.39 to +0.53 ms**. Inside the budget in both regimes, with the wider
pool-wide read rather than the page-sized prefix it replaced.

The gates therefore do **not** stay `null` on cost grounds. `tasks.md` §4.4 records
the reason they stay `null`, and it is a calibration reason, not a cost one.

`tune-hot-query-paths` is still in flight. This measurement is deliberately scoped to
the _delta_ between the disabled and enabled paths on the same fixture in the same
process, so it stays valid whatever that change does to the absolute numbers. The
absolute figures above (≈33 ms at 50k rows for a default page) are the un-tuned
baseline and are that change's business, not this one's.
