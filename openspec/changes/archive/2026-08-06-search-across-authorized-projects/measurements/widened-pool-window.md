# Measurement — the candidate window is per project, and what that costs

A widened search drew the NARROW candidate window over the union on both ranked
branches, so adding an authorized project subtracted from what the home project
contributed instead of adding to it. This file records the defect, the two fixes,
the alternative that was measured and rejected, and the end-to-end cost of the
pool the fix produces — which is **not** the cost `vec-partition-scale.md` §4
published, and supersedes it for every operator-facing figure.

## 1. The defect, isolated from ranking

Both branches rationed one window across the set:

- `memory-repository.ts::searchBm25Ids` bounded the union with a single `LIMIT`.
- `hybrid-search.ts::denseRetriever` truncated the merged kNN back to
  `rankWindowSize`. The repository was already correct — `k` applies per named
  partition — so only the truncation broke it.

Byte-identical content in both projects and the foreign rows written FIRST are
both load-bearing in the reproduction. With distinguishable text BM25 and the
embedder rank the home rows above the foreign ones and the shared window never
has to choose, so the defect does not appear; two earlier probes missed it for
exactly that reason. Only a tie broken against home by insertion order isolates
the predicate from the ranking. At 90 rows per project and a 64-row window:

|        | narrow pool | widened pool | home contributes |
| ------ | ----------: | -----------: | ---------------: |
| before |          64 |           64 |       64 → **0** |
| after  |          64 |          128 |      64 → **64** |

`widened-search.test.ts::"the candidates handed to fusion grow with the widened
set"` pins both branches. It is mutation-proved: restoring the pre-fix global
bound (`if (projectIdsOf(opts.scope).length === 1)` → `if (true)`), collapsing the
partition (`PARTITION BY project_id` → `PARTITION BY 1`) and restoring the dense
truncation (`denseWindow` → `rankWindowSize`) each redden it.

**Why no existing test or measurement caught it.** The retrieval eval's corpus
holds 70 memories across three projects, so no project reaches the 64-row window
and the union fits inside one — the eval cannot express the defect, and its
metrics are byte-identical before and after the fix. The one test that named the
property called `vectors.knnByQueryVector` directly, which is the layer where the
property already held.

## 2. The narrow path did not move, as a fact rather than an argument

One project needs no partitioning, so `searchBm25Ids` emits the pre-fix statement
unchanged on that branch. Captured from a running server at `afe7d90` and at HEAD
by hooking `prepare()`, the narrow statement is **byte-identical**: 345 bytes,
`sha256 5731552249965c69…` on both sides, with a control confirming the worktree
really is pre-fix (`ROW_NUMBER` occurrences: 0 there, 1 here). Identical text is
identical opcodes, so no plan comparison is needed. The dense branch's bound is
`rankWindowSize × 1` when the set has one member.

## 3. I1 ISOLATED STATEMENT — the three shapes for a per-project window

Arms interleaved per query, 40 timed queries, `rowsTotal` reported so a cheaper
arm cannot be cheaper by returning less. `globalLimit` is the pre-fix shape and
returns a sixth of the rows, so it is a cost floor, not a candidate.

| corpus | width | `globalLimit` | `windowFn` (shipped) | `perProject` | rows (`windowFn` = `perProject`) |
| -----: | ----: | ------------: | -------------------: | -----------: | -------------------------------: |
| 20 000 |     2 |      10.79 ms |             17.84 ms | **15.17 ms** |                            5 120 |
| 20 000 |     4 |      12.55 ms |         **22.09 ms** |     27.26 ms |                           10 240 |
| 20 000 |     7 |      12.49 ms |         **22.58 ms** |     38.89 ms |                           15 360 |
| 50 000 |     7 |      43.31 ms |         **71.41 ms** |    175.90 ms |                           15 360 |

**The alternative was measured, not assumed.** `perProject` — one bounded-sorter
statement per project, merged by BM25 rank in JS — is the shape the dense branch
already uses, so it was the obvious candidate. It wins the one narrowest cell
(width 2 at 20 000, by 15%) and loses everywhere else, because each project pays
its own full FTS `MATCH` scan: it scales linearly with width (22.1 → 38.9 ms)
where the window function is flat (22.1 → 22.6 ms), and at 50 000 × 7 it is
**2.5× worse**. The window function ships.

## 4. I2 SHIPPED END-TO-END — what the widening now costs

`MemoryService.searchWithAbstention` on the real repositories through the real
widened `SearchScope`: the call a user waits on. Six independent process runs per
cell, each the p50/p90 of 40 timed queries, arms interleaved inside the process
with the starting arm rotated. Same skewed corpora, same harness
(`scale-e2e.mjs`) and same reduction as §4 of `vec-partition-scale.md`.

#### Home `vol-0`

| corpus | arm              | projects | p50 per repeat (ms)                                 | median p50 | median p90 |  ×narrow |
| -----: | ---------------- | -------: | --------------------------------------------------- | ---------: | ---------: | -------: |
|  1 000 | `shipped-narrow` |        1 | 6.99 / 7.03 / 6.90 / 6.89 / 7.04 / 6.83             |       6.95 |       7.66 |     1.00 |
|        | `shipped-2`      |        2 | 12.04 / 12.18 / 11.83 / 11.66 / 12.23 / 11.82       |      11.93 |      13.89 | **1.72** |
|        | `shipped-4`      |        4 | 18.52 / 18.87 / 18.94 / 18.18 / 18.58 / 18.32       |      18.55 |      20.41 | **2.67** |
|        | `shipped-all`    |        7 | 20.61 / 20.65 / 20.72 / 20.27 / 20.89 / 20.90       |      20.69 |      23.63 | **2.98** |
| 20 000 | `shipped-narrow` |        1 | 24.58 / 24.57 / 24.47 / 24.48 / 24.46 / 24.82       |      24.52 |      26.27 |     1.00 |
|        | `shipped-2`      |        2 | 40.38 / 39.88 / 40.47 / 40.13 / 40.06 / 40.95       |      40.26 |      44.04 | **1.64** |
|        | `shipped-4`      |        4 | 57.68 / 57.70 / 57.62 / 56.68 / 58.68 / 57.93       |      57.69 |      63.56 | **2.35** |
|        | `shipped-all`    |        7 | 70.80 / 71.43 / 71.07 / 69.80 / 70.39 / 70.71       |      70.76 |      80.01 | **2.89** |
| 50 000 | `shipped-narrow` |        1 | 60.59 / 61.00 / 60.13 / 60.83 / 60.34 / 60.17       |      60.47 |      64.26 |     1.00 |
|        | `shipped-2`      |        2 | 92.61 / 93.35 / 92.61 / 93.20 / 93.42 / 92.96       |      93.08 |     100.65 | **1.54** |
|        | `shipped-4`      |        4 | 118.52 / 118.76 / 119.93 / 119.52 / 118.46 / 118.55 |     118.65 |     128.23 | **1.96** |
|        | `shipped-all`    |        7 | 134.96 / 135.03 / 134.56 / 136.84 / 133.54 / 134.77 |     134.86 |     147.05 | **2.23** |

#### Home `vol-shared`

| corpus | arm              | projects | p50 per repeat (ms)                                 | median p50 | median p90 |   ×narrow |
| -----: | ---------------- | -------: | --------------------------------------------------- | ---------: | ---------: | --------: |
|  1 000 | `shipped-narrow` |        1 | 1.73 / 1.70 / 1.67 / 1.73 / 1.66 / 1.69             |       1.70 |       2.08 |      1.00 |
|        | `shipped-2`      |        2 | 7.84 / 7.91 / 7.86 / 7.76 / 7.67 / 7.83             |       7.83 |       8.58 |  **4.62** |
|        | `shipped-4`      |        4 | 17.15 / 17.01 / 17.08 / 17.24 / 16.48 / 16.69       |      17.04 |      18.47 | **10.05** |
|        | `shipped-all`    |        7 | 20.24 / 20.46 / 20.83 / 20.75 / 20.18 / 20.28       |      20.37 |      22.96 | **12.02** |
| 20 000 | `shipped-narrow` |        1 | 13.80 / 13.85 / 13.97 / 13.74 / 13.83 / 13.87       |      13.84 |      15.21 |      1.00 |
|        | `shipped-2`      |        2 | 35.61 / 35.66 / 35.96 / 35.61 / 35.73 / 35.95       |      35.69 |      38.25 |  **2.58** |
|        | `shipped-4`      |        4 | 56.69 / 57.02 / 57.05 / 56.76 / 56.35 / 56.51       |      56.73 |      61.10 |  **4.10** |
|        | `shipped-all`    |        7 | 70.07 / 70.75 / 71.24 / 71.29 / 70.28 / 70.57       |      70.66 |      74.53 |  **5.10** |
| 50 000 | `shipped-narrow` |        1 | 33.23 / 32.88 / 32.72 / 32.84 / 32.82 / 32.86       |      32.85 |      34.87 |      1.00 |
|        | `shipped-2`      |        2 | 81.82 / 80.72 / 80.33 / 81.27 / 80.96 / 81.43       |      81.12 |      87.54 |  **2.47** |
|        | `shipped-4`      |        4 | 117.37 / 116.17 / 116.41 / 116.89 / 115.98 / 116.74 |     116.57 |     123.59 |  **3.55** |
|        | `shipped-all`    |        7 | 135.84 / 134.16 / 135.41 / 134.78 / 135.35 / 135.18 |     135.27 |     146.65 |  **4.12** |

#### Non-vacuity, over every run in the matrix

- 144 arm-runs, 46056 rows returned in total, minimum 7 rows on any single query, 0 queries returning zero rows.
- `foreignScopeRows` on every `shipped-narrow` run: 0.

### The committed 1.3–2.6× does not survive this fix

`vec-partition-scale.md` §4 measured instrument **I3 SHADOW**, whose overlay
bounded the union with a single `LIMIT` — the defect itself. It therefore priced
a pool that does not grow with the set, and its figure cannot be carried forward:

|                      | ordinary home (`vol-0`) | thin home (`vol-shared`) |
| -------------------- | ----------------------- | ------------------------ |
| I3 SHADOW, published | 1.32–1.35×              | 2.39–5.00×               |
| I2 SHIPPED, this fix | **1.96–2.98×**          | **4.12–12.02×**          |

Read off it, in order of what each decides:

- **The operator-facing number is 2.2–3.0×, not 1.3×**, for the ordinary case of
  widening from the project you work in. `docs/agents.md`, `docs/updates.md` and
  design D15 quoted the shadow figure and are corrected to this one.
- **The ratio falls as the corpus grows** (2.98 → 2.89 → 2.23 on `vol-0`), because
  the pool is bounded by `window × N` while the narrow arm's fixed costs grow with
  the corpus. It is a bounded multiple, not a growing one.
- **From a thin project the worst case is 12×** at 1 000 memories, where the
  narrow arm is 1.70 ms and the widened one 20.37 ms. The ratio is large because
  the denominator is small; the absolute figure stays under 21 ms and, at 50 000,
  135 ms against 33 ms.
- **`shipped-4` and `shipped-all` are close** (118.65 vs 134.86 ms at 50 000) —
  the corpus is skewed, so the three smallest projects add few rows. Width is not
  the driver; rows are.
- **No arm returned fewer rows or a foreign row it should not have.** Over 144
  arm-runs: 46 056 rows, minimum 7 on any single query, zero empty queries, and
  `foreignScopeRows = 0` on every narrow arm.

## 5. Real-stack A/B, same container, same live rows

`dev:docker:up` with the source bind-mounted, so the two arms are the same running
server reading the same data — only the two source files change between them.
Corpus written through the real `memory.save` MCP tool: 90 byte-identical rows into
`api-gateway` FIRST, then 90 into `demo` (which already held 35, so 125 total).
`memory.search({ query, limit: 50 })` from a connection resolved to `demo`.

| arm                 | narrow page | widened page, by project       |
| ------------------- | ----------: | ------------------------------ |
| pre-fix (`afe7d90`) |     50 home | **25 home + 25 `api-gateway`** |
| post-fix            |     50 home | **50 home + 0 foreign**        |

- **Home lost half the page to a foreign project on a pure tie**, which is the
  defect end to end through the shipped MCP tool, not a unit-test artefact.
- **`gateShortened` was `undefined` on BOTH arms**, and both pages came back full
  at 50 rows. That is the direct evidence that the flag the operator docs pointed
  at cannot detect this mechanism.
- Post-fix the page is all home because the rows tie exactly and the specified
  home tiebreak resolves them — not because the widening stopped reaching
  `api-gateway`: `searchedProjects` names 20 projects on both arms.

## 5. What this does NOT establish

- The corpus vectors are deterministic pseudo-random unit vectors, not
  embeddings, and the query embedder is of the same family (inherited from
  `seed-volumetric.ts`). No retrieval-quality, ranking or abstention claim may be
  drawn from this harness — only wall-clock, row counts and project of origin.
- The window-policy comparison in `vec-partition-scale.md` §7 (undivided against
  `window / N`) was measured on the shadow overlay and has NOT been re-run against
  the shipped path. Task 2.8's decision is unaffected — it turns on which project
  gets which share, not on the total — but its latency figure is a shadow figure.
- One cell contradicts the trend and is not smoothed away: `perProject` beats the
  window function at width 2 on 20 000 rows. A two-project widening is the common
  case, so the crossover is worth revisiting if the width distribution in the
  field turns out to sit there.
