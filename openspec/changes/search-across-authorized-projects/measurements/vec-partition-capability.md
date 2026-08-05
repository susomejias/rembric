# Measurement — can sqlite-vec run one kNN across several partitions?

**This is the capability-and-ordering half of the phase-2 question, measured at propose time because it decides the shape of the design.** It is NOT the production-scale half. See §5 for exactly what this does not establish and what task 2 still owes.

**Instrument, named once and not mixed with any other:** I1 ISOLATED STATEMENT — a `better-sqlite3` prepared statement executed against an **in-memory** database holding synthetic unit-norm random `FLOAT[768]` vectors, uniformly distributed across partitions, timed with `process.hrtime.bigint()`, 5 warm-up iterations then 40 timed, reported as p50/p90 in milliseconds. **No figure here is an end-to-end `memory.search` latency**, and none may be quoted as one.

- sqlite-vec: `v0.1.9` (`vec_version()`), `better-sqlite3@12.11.1`, Node 22.23.1.
- Table DDL is the shipped one, verbatim from `apps/server/src/db/migrations/0014_hybrid_search_vec_rebuild.sql:32-38`, with the embedding dimension held at 768.
- Reproduce: `cd apps/server && node ../../openspec/changes/search-across-authorized-projects/measurements/vec-partition-capability.mjs` (and `…-semantics.mjs`, `…-scale.mjs`).

---

## 1. The question

`vectors-repository.ts:118-137` binds the dense branch to exactly one partition:

```
WHERE embedding MATCH ? AND k = ? AND partition_key = ? AND status = ?
```

and its own docstring (`:115-117`) states the reason: the `k =` form exists "so the partition shard is scanned, not the whole corpus". A widened search must read several partitions. The question is whether that can be **one query producing one globally-ordered list**, or must be **N queries merged** — because RRF (`hybrid-search.ts:139`) orders by rank _position_, so N separately-ranked lists would give every project its own rank-1 row.

## 2. Capability — every candidate form is accepted (`vec-partition-capability.mjs`)

Five vectors over three partitions; query vector equals `p1-near` exactly.

| form                                             | result                   |
| ------------------------------------------------ | ------------------------ |
| **control** `partition_key = 'P1'`               | OK — `["a","b"]`         |
| no `partition_key` predicate at all              | OK — `["a","c","b","d"]` |
| `partition_key IN ('P1','P2')`                   | OK — `["a","c","b"]`     |
| `(partition_key = 'P1' OR partition_key = 'P2')` | OK — `["a","c","b"]`     |
| `LIMIT` instead of `k =`, no partition           | OK — `["a","c","b","d"]` |
| `partition_key IN (SELECT … UNION SELECT …)`     | OK — `["a","c","b"]`     |

**The control passes and the arms differ from each other** — 2 rows, 4 rows, 3 rows — so this is not a comparison over an all-empty or all-identical set. Row `e` (partition `P2`, `status = 'superseded'`) appears in **no** arm, so the `status` filter survives every form; row `d` (partition `P3`) appears only in the predicate-free arms, so `IN` really restricts.

**Answer to the load-bearing question: one globally-ordered list is expressible.** Nothing has to be merged in application code.

## 3. Semantics — `k` is per named partition, `ORDER BY distance` merges globally (`vec-partition-semantics.mjs`)

Four vectors, `k = 2`, query = `(1,0)`:

| form                                                | rows returned                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `partition_key = 'P1'`                              | `p1-near 0.000`, `p1-far 1.414`                                            |
| `partition_key IN ('P1','P2')`                      | `p1-near 0.000`, **`p2-mid 0.762`**, `p1-far 1.414`                        |
| `partition_key IN (?, ?)` bound                     | identical to the literal form                                              |
| `partition_key IN (SELECT value FROM json_each(?))` | identical                                                                  |
| `partition_key IN ('P1','NOPE')`                    | `p1-near`, `p1-far` — an unmatched partition contributes nothing, no error |
| `partition_key IN ('P1')`                           | **byte-identical to `= 'P1'`**                                             |
| `partition_key IN ()`                               | **empty result set**                                                       |

Four consequences that shape the implementation, each from a row above rather than from reasoning:

1. **`k` is applied per named partition**, so `IN (n partitions)` returns up to `n × k` rows — confirmed at scale in §4 (64 / 128 / 256 / 512 rows for 1 / 2 / 4 / 8 partitions at `k = 64`).
2. **`ORDER BY distance` then produces one globally distance-ordered list.** `p2-mid` at 0.762 sits _between_ `P1`'s two rows, so rank position in the returned list is a global fact, not a per-partition one. This is what makes RRF fair with no fudge factor.
3. **Bound parameters and the repo's existing `json_each` idiom both work**, so the >32 766-bind ceiling `scope-clause.ts:57-66` already documents has a ready answer: `idJsonSet` is directly reusable.
4. **A one-element widened set is exactly today's query.** `IN ('P1')` ≡ `= 'P1'`, so the implementation needs **one** query shape, not a widened branch beside a narrow one — and a `project:<id>` token's widened search is provably identical to its narrow search rather than merely intended to be.

**One hazard this exposes: `IN ()` returns empty.** A widening that resolved to zero authorized projects would return nothing rather than falling back. By construction the set always contains the connection's own resolved project (the token was authorized for it before the tool ran), so the set is never empty — but "never empty by construction" is exactly the kind of claim that stops being true when someone changes the constructor, so it is spec'd as a requirement and pinned by test rather than left emergent.

## 4. Cost — linear in rows scanned; the predicate-free form is dominated (`vec-partition-scale.mjs`)

8 partitions, equal size, `k = 64` (the shipped `RANK_WINDOW_FLOOR = RANK_CONSTANT + 4`), p50 of 40 fresh random query vectors.

**The 50 000-vector column is FOUR independent process runs, not one**, because the first run produced a figure the repeats did not reproduce (see the bimodality note below). Every other magnitude is a single run and is labelled as such.

| arm                        | 4 000 (1 run) | 20 000 (1 run) |                     50 000 (4 runs, p50 each) | rows returned |
| -------------------------- | ------------: | -------------: | --------------------------------------------: | ------------: |
| 1 partition (today)        |       0.66 ms |        1.61 ms |                     4.13 / 4.24 / 4.36 / 4.19 |            64 |
| `IN` (2 partitions)        |       1.39 ms |        3.49 ms |                     8.33 / 8.62 / 9.03 / 8.44 |           128 |
| `IN` (4 partitions)        |       1.96 ms |        7.16 ms |                 17.00 / 16.97 / 17.05 / 17.16 |           256 |
| `IN` (all 8)               |       4.03 ms |       20.62 ms |                 34.21 / 34.37 / 33.90 / 34.93 |           512 |
| **no partition predicate** |       3.82 ms |       13.96 ms | **48.37 / 33.70 / 33.71 / 48.45** — _bimodal_ |            64 |
| 2 separate queries merged  |       0.81 ms |        3.45 ms |                     8.47 / 8.42 / 8.43 / 8.39 |           128 |

Read off it, in order of what each decides:

- **`IN` scans the named shards, not the corpus, and this is the tightest result here.** Across all four 50 000-vector runs the ratios against the single-partition arm are 1.00 / ≈2.03 / ≈4.05 / ≈8.09 for 1 / 2 / 4 / 8 partitions, with every arm varying by under 8% between runs — linear in the rows the named partitions hold. The `k =` form's shard-scan property, which `vectors-repository.ts:116` exists to preserve, **survives `IN`**. This is consistent with the already-recorded law at `data-access/spec.md:487` ("Cost is linear in partition size") rather than contradicting it: widening to N projects costs what one project of the combined size costs.
- **The predicate-free form is DOMINATED, and the first run's stronger claim did not reproduce.** The honest statement is that it is never better than `IN (all 8)` while returning one eighth as many rows: in two of four runs it matched it (33.70, 33.71 against 33.90–34.93) and in two it was **≈1.4× slower** (48.37, 48.45). Every other arm was tight across the same runs, so the bimodality belongs to this arm rather than to the host. Either way "just remove the `partition_key` filter" — the obvious-looking route to one globally-ranked list of exactly `k` — buys nothing and can cost 40%, so the design always names its partitions. **The original single-run reading of this cell (a flat 1.41× penalty) was wrong and is corrected here; repeating it is what found that, and no other arm needed it.**
- **The 20 000-row `IN (all 8)` cell is superlinear (12.8× rather than ≈8×) and is a SINGLE run.** It is the only cell that departs from the linear reading; at 4 000 and 50 000 the same arm lands at 6.1× and ≈8.1×. Given what repetition did to the predicate-free arm, this cell should be treated as unconfirmed until repeated (task 2.5), not as a finding.
- **N separate queries cost the same as `IN`** — 8.47 / 8.42 / 8.43 / 8.39 against 8.33 / 8.62 / 9.03 / 8.44 at 2 partitions on 50 000, i.e. indistinguishable across four runs. **So the choice between them is not a performance choice.** It is decided entirely on ranking semantics: `IN` yields one distance-ordered list, N queries yield N rank-1 rows. That is the whole argument for `IN`, and it would have been invisible from a cost table alone.
- **`EXPLAIN QUERY PLAN` does not discriminate here.** Both forms print the identical `SCAN memory_vec VIRTUAL TABLE INDEX 0:3{___}___]Aa_&Aa_` plus `USE TEMP B-TREE FOR ORDER BY`. The vtable index string is opaque, so **EQP is not the instrument for this question** — only wall-clock is. Recorded so a later audit does not read the identical plans as evidence that the arms are equivalent.
- **Widening has a real per-turn cost.** ≈4.2 ms → ≈34.4 ms at 50 000 vectors over 8 projects is **≈8×** on the dense branch, reproducible across four runs. That is the measured basis for the description-level restraint requirement: the authorization gate does not bound frequency on a single-user instance, and this is what frequency costs.

## 5. What this does NOT establish — and what task 2 still owes

1. **No end-to-end number.** Every figure is an isolated prepared statement. The user-facing quantity is `memory.search` p50 through `searchWithAbstention`, which also pays embedding, the FTS branch, RRF, the relevance gate, relation annotations and entity projection. Per `CLAUDE.md`, these two series must never appear in one table. Task 2 measures the end-to-end one and quotes it as the number a user waits on.
2. **Synthetic vectors, uniform partitions, in-memory database.** A real corpus is skewed — one project usually dominates — and lives on disk with a WAL and a page cache. `apps/server/src/scripts/seed-volumetric.ts` exists for exactly this and is what task 2 uses.
3. **Only the dense branch.** The lexical branch's cost under a multi-project `project_id IN (…)` predicate against `memory_fts` is unmeasured here.
4. **Only 8 partitions.** The `IN`-list length at which SQLite's own bind or expression handling degrades is unmeasured; §3 establishes that `json_each` is available as the escape, not that it is needed.
5. **No quality claim whatsoever.** Nothing here says the widened result set is _better_. That is the harness's job (phase 3), and the harness cannot answer it today — which is why phase 3 precedes phase 4.
6. **Only the 50 000-vector column is repeated.** The 4 000 and 20 000 columns are single runs, and repetition is exactly what corrected the predicate-free cell at 50 000, so no reading of those two columns should be treated as settled. Task 2 repeats every magnitude it re-measures.
