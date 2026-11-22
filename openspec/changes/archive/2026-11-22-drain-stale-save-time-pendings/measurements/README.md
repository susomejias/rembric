# Measurements — stale pending drain prototype

Every file names its instrument. Rows from different instruments are never tabulated together.

Nothing here touches production code, tests or published specs. The prototype is `drain-prototype.mts`. It runs against throwaway databases in a `mktemp -d` directory outside the workspace. Only three data sources were used: the labelled save-time fixture, the retrieval corpus and the `corpus:build` generator. No production data was read or written.

```sh
pnpm -r --filter "./packages/*" build
export DRAIN_SCRATCH=$(mktemp -d) TMPDIR=$DRAIN_SCRATCH
pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/<script>.mts
```

Scripts are `.mts` because they use top-level await. Under `tsx`, `packages/core/tsconfig.json` maps `@rembric/*` to `src/`. Every module is imported through that one path, so there is a single module instance (`ops.undoOp === core.undoOp` was checked).

## Rule versions and which files used them

| version                                    | what changed                                                                                                                                                                                                                                                                                                                                                                                                                                             | files                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **v1** (first handover)                    | keep if lexical ≥ 0.6, cosine ≥ 0.7, or any **stored** shared entity link; keep on any non-active, missing or unreadable endpoint, a missing vector, or an error                                                                                                                                                                                                                                                                                         | `v1-*.txt`              |
| **v2** (owner decision + reviews B2, B3)   | superseded/archived endpoint → **drained** (`endpoint retired: …`), and an undone retired drain is not drained again; entity channel also re-runs `extractEntities` on both endpoints (a failure keeps); injected `vectorIndexCurrent()` returning false makes the vector channel unknown                                                                                                                                                                | `v2-*.txt`              |
| **v3** (aligned with `design.md`, current) | **undo is final** for every drain: a row is excluded when any reverted `orphan_promote` op names its judgment id; status and lengths are read with SQL `length()` first, and an endpoint over `DRAIN_MAX_PAIR_CHARS = 64 000` keeps the pair as unknown before any channel runs; `DRAIN_BUDGET_MS` is shared by every drain step of one sweep call, each step examines at least one pair, and counters are nested in a `drain` object of the run summary | every unprefixed `.txt` |

- A missing or unreadable endpoint row is kept in every version.
- Each drain is one transaction holding `markOrphanedPending` and `recordOrphanPromote`. It is journaled only when the update changed a row.
- Reasoning strings are `orphaned: stale under current rules: …` and `orphaned: endpoint retired: …`.

## What the prototype uses

- **Writes:** `RelationsRepository.markOrphanedPending`, `recordOrphanPromote` (`operations.ts`), `ConsolidationRepository.insertRun`/`finishRun`. Undo is the dashboard's service path: `core.undoOp` and `core.undoRun`.
- **Existing reads:** `EntitiesRepository.findEntitiesForMemories`, `core.extractEntities`, `tokenContainment`/`tokenSet`, `LEXICAL_CANDIDATE_FLOOR`, `VEC_THRESHOLD`.
- **STAND-IN READS:** there is no repository method for these yet. Each is read-only, built with the Drizzle `sql` builder and labelled in the code.
  - Scoped pending selection after a cursor, in `judgment_id` order, plus a `(created_at, judgment_id)` variant (see validation 8).
  - Pairwise `vec_distance_cosine` of the two stored vectors (the save path's function).
  - Endpoint status and `length()` with content only under the bound.
  - Reverted `orphan_promote` ops for a batch's judgment ids.
- **Raw SQL** appears only in labelled `VERIFICATION READ`s (counts, digests, the independent recomputation) and in `EXPLAIN QUERY PLAN`.
- **Cursor:** carried in memory between simulated runs. It is also written to the existing `consolidation_runs.summary`, for example `{"archives":0,"orphaned":0,"drain":{"cursor":…,"examined":4,"drainedRules":4,"drainedRetired":0,"keptAdmitted":0,"keptUnknown":0}}` (from `mechanics.txt`, validation 5c). Recommendation, not a fact: reading it back needs a new scoped "latest finished run" read, because `adminLatestRun` is unscoped and dashboard-only.

## Results (v3 unless stated)

| #   | validation                          | result    | key numbers                                                                                                                                                                                                    | file                      |
| --- | ----------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | fixture correctness, production arm | PASS      | 225 pending → 207 drained, 18 kept (lexical 8, vector 10); **0 false drains** (17/17 labelled pairs kept); unrelated-source pairs drained 50/50; kept set = exactly the 18 pairs the shipped 0.60 floor writes | `fixture-drain.txt`       |
| 1   | fixture, lexical-only arm           | PASS      | 0 drained, 225 kept (213 by the vector-unknown fail-safe)                                                                                                                                                      | `fixture-drain.txt`       |
| 1   | no model inference                  | PASS      | fresh process with the model runtime import blocked: 225/225 identical decisions, spy embedder 0 calls, `memory_vec` 51 → 51; control `loadEmbedder()` refused                                                 | `fixture-no-embedder.txt` |
| 2   | retrieval corpus                    | PASS      | controls 289 and 54 reproduced; 241 drained (235 stale, 6 retired), 54 kept, all by vector; overlap with the 54 written at 0.60 is 54/54, 0 extra                                                              | `corpus-drain.txt`        |
| 3   | consistency                         | PASS      | 0 mismatches over 225 + 225 + 295 pairs; max cosine delta 9.5e-7; no pair within 1e-4 of 0.7; control flags exactly 2 flipped decisions                                                                        | fixture + corpus files    |
| 4   | no starvation, idempotence          | PASS      | without a cursor, 10 runs drain 0 (starvation reproduced); with it, 5 runs = ceil(100/20) drain 70/70; second pass drains 0 and the digests are unchanged                                                      | `mechanics.txt`           |
| 5   | fail-safe and retired               | PASS      | the vector-missing, row-unreadable, read-throws and extraction-throws pairs are all kept and each control drains; a superseded or archived endpoint is drained as retired                                      | `mechanics.txt`           |
| 5b  | `vectorIndexCurrent()` false        | PASS      | 5/5 noise pairs kept; control (true) drains 5/5                                                                                                                                                                | `mechanics.txt`           |
| 5c  | shared budget, ≥ 1 pair per step    | PASS      | injected clock: scope A examines 4, scope B exactly 1; control B alone examines 5                                                                                                                              | `mechanics.txt`           |
| 6   | atomicity, concurrency              | PASS      | journal failure rolls back (row pending, 0 ops); a row judged before the write gets no drain and no op; both controls drain                                                                                    | `mechanics.txt`           |
| 7   | undo                                | PASS      | 207 ops reverted (`undoOp` + `undoRun`), 207/207 rows clean pending, set identical; next pass excludes 207/207 (v2 re-drained all 207)                                                                         | `fixture-drain.txt`       |
| 7b  | undo is final                       | PASS      | undone stale drains excluded 5/5, and a new noise pair still drains                                                                                                                                            | `mechanics.txt`           |
| 8   | cost and batching                   | see below |                                                                                                                                                                                                                | `drain-cost.txt`          |

Notes on the correctness rows:

- The fixture has no retired endpoints and no oversized bodies, so v1, v2 and v3 give the same 225 decisions there.
- On the corpus, the 6 retired drains (superseded `atlas-auth-v1` and `nimbus-retry-v1` sources) were fail-safe keeps in v1.
- Expanded rewrites and the identifier-free contradictions survive only through the vector channel (cosine 0.751–0.892). With no vectors, they survive only through the fail-safe.
- Validation 3 recomputes every rule from raw reads: an independent tokenizer, a float64 cosine over the decoded vectors, raw entity-link joins and a fresh extraction. It then checks the relation row, the journal and the decision log.

## 8. Cost (`drain-cost.txt`)

- **Instruments:** one per table, and they are never mixed.
  - wall clock of one drain run (`performance.now`, warm after an untimed dry re-check of every pending pair; "cold 1st" is a fresh connection);
  - wall clock of one selection read;
  - wall clock of one sweep call;
  - per-step wall clock.
- **Model inference is excluded because the drain never performs it.** Validation 1 proves this, and no embedder is loaded in the cost process.
- **Corpus:** `buildCorpus` with `--relations R`, measured on scope `vol-shared`.
  - R = 14 400 gives 625 pending in the measured scope (3 633 in all).
  - R = 120 000 gives 4 959 pending (30 017 in all, plus 84 219–94 019 judged rows).
- **This measures cost, not correctness.** The vectors are pseudo-random and the vocabulary is tiny. Synthetic bodies average 1 300 bytes with 18 entities each, which makes the stored-entity read and the re-extraction heavier than on short memories.

Drain run, `created_at` order, 50 000 memories (milliseconds):

| backlog | B = 50 max | B = 200 median / max | B = 500 max | B = 1000 max | ms per pair | cold first run, B = 200 |
| ------- | ---------- | -------------------- | ----------- | ------------ | ----------- | ----------------------- |
| 625     | 18.1       | 51.3 / 53.6          | 131.0       | 161.5        | 0.25–0.26   | 55.8                    |
| 4 959   | 25.7       | 62.6 / 73.8          | 191.2       | 307.7        | 0.30–0.36   | 66.8                    |

**Per-pair steps** at 50 000 memories:

| step                         | ms    |
| ---------------------------- | ----- |
| bounded row read             | 0.014 |
| lexical                      | 0.051 |
| cosine read                  | 0.031 |
| stored entities              | 0.056 |
| re-extraction                | 0.084 |
| orphan + journal transaction | 0.145 |

**Selection order — efficiency finding.** The owner's `judgment_id` order, at the 4 959 backlog, chooses `memory_relations_status_created_idx (status=?)` and then sorts every pending row. A selection costs 13.2–17.6 ms per run at 50 000 memories, and is not bounded by the time budget because it runs before the first pair. The `(created_at, judgment_id)` variant uses the same index with a range (`status=? AND created_at>?`) and sorts only ties, at 0.35–4.8 ms.

Evidence that the variant is safe:

- Both orders return identical batches over 40 wrapping cursor steps (control PASS).
- Every B and both orders drain the identical row set.
- `(created_at, judgment_id)` order equals `judgment_id` order for all 14 602 relations checked, because `createPending` mints the ULID from the same timestamp.

Selection order also changes the end-to-end numbers:

- cold first run at 50 000 memories, B = 50 / 200: 174.0 / 164.8 ms with `judgment_id`, 17.7 / 66.8 ms with `created_at`;
- runs to finish one budgeted pass over 4 959 rows: 77 against 38.

**Batching (coordinator check 2).** 4 959-row backlog, 50 ms budget, `created_at` order:

| memories | B = 1000: runs | worst single run |
| -------- | -------------- | ---------------- |
| 1 000    | 26             | 55.2 ms          |
| 20 000   | 28             | 56.6 ms          |
| 50 000   | 38             | 54.5 ms          |

- Every run stopped on the budget, and every row was examined once before the cursor wrapped.
- The drained set is identical to the unbudgeted pass (PASS at every size).
- With `judgment_id` order and B = 200 at 1 000 memories, 3 runs stopped on the cap and 26 on the budget, so both stop reasons occur.
- The worst single run across every budgeted series is **56.6 ms**: the budget plus at most one pair and the run's bookkeeping.

**Sweep call (review M2).** Instrument: wall clock of one sweep call; B = 150 per scope, 50 000 memories, 4 959 backlog per scope, median / max in milliseconds.

| order         | budget model                               | 2 scopes    | 6 scopes      |
| ------------- | ------------------------------------------ | ----------- | ------------- |
| `created_at`  | 50 ms per scope                            | 88.6 / 97.0 | 258.0 / 264.6 |
| `created_at`  | **one 50 ms budget per call** (`runSweep`) | 50.1 / 50.8 | 54.9 / 61.8   |
| `judgment_id` | one 50 ms budget per call                  | 86.4 / 89.1 | 222.1 / 229.7 |

- With `judgment_id` order the shared budget cannot hold: each scope pays its ~15 ms selection before its guaranteed pair.
- With `created_at` order, six scopes still overrun by up to 12 ms, from the per-step fixed costs and the one guaranteed pair.

**Recommendation.**

- `DRAIN_ROW_CAP = 150`, `DRAIN_BUDGET_MS = 50` shared per sweep call, `created_at` selection.
  - B = 200 exceeds 50 ms at 50 000 memories (max 73.8 ms).
  - B = 150 ran at a median of 44 ms per scope step in the per-scope sweep series (88.6 ms per 2 scopes).
- To meet "p95 ≤ 50 ms per call" with six scopes, lower the budget to about 40 ms. That measured headroom is 12 ms; it is a proposal, not run.
- **Days to drain 589 rows** in one scope at B = 150:
  - ceil(589 / 150) = **4 runs**: 4 days at one session-start run per day, or 4 dashboard "run now" clicks.
  - At 50 000 memories under a shared two-scope budget, about 83 pairs per scope per call, so about **8 runs**.
  - Worst case, one pair per call: 589 runs.
  - At the instance's ~3 400 memories (between the 1 000 and 20 000 corpora), per-scope steps reached the cap of 150 at both sizes, so 4 runs. Under a shared two-scope budget at 20 000 memories a call examined 198 pairs, and the 589 rows sit in one scope, so still about 4–6 runs.

## Review M1 — very large bodies (`bounds.txt`)

- **Instrument:** wall clock of one `recheckPair` (warm, median of 5), size bound off.
- **Text:** synthetic words, plus an identifier-dense style.

| chars per endpoint | large→large ms |
| ------------------ | -------------- |
| 32 000             | 2.26–2.69      |
| 50 000             | 3.71–3.88      |
| **64 000**         | **4.47–4.88**  |
| 80 000             | 5.69–5.71      |
| 200 000            | 14.3–14.6      |
| 1 000 000          | 44.4–51.7      |

- Tokenisation grows without bound. Extraction plateaus at ~3.9 ms per endpoint (`MAX_INPUT_CHARS = 200 000`).
- **`DRAIN_MAX_PAIR_CHARS = 64 000`** is the largest measured size at or under 5 ms per pair, and it sits under the 200 000 cap.
- With the bound on, a 1 MB pair costs 0.51 ms (status and length only) and is kept as `fail-safe:content-too-large`. **Control:** a 1.3 KB noise pair still drains.
- The reverted-op lookup for a 1 000-id batch scans `consolidation_ops`, which has no index on `created_id`: 0.19 ms at 1 000 ops, 0.54 ms at 10 000 and 3.74 ms at 100 000.

## The shipped drain against the prototype (`validate-shipped.mts`)

The same fixture and corpus validations, re-run through the shipped step: `ConsolidationRunner.runScope`, with decay and deadline orphaning neutralized so only the drain writes, `vectorIndexCurrent` true, and the shipped bounds and wall clock. Per-pair reasons come from `evaluatePair` and `drainDisposition`, the functions the step calls, and every pair's relation status and journal prefix are checked against them. The prototype's independent recomputation (`verifyDrain`) re-derives every decision from raw reads.

| validation                         | prototype v3                                          | shipped step                                           | file                              |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| fixture, production arm            | 225 → 207 drained, 18 kept (lexical 8, vector 10)     | 225 → 207 drained, 18 kept (lexical 8, vector 10)      | `fixture-drain-shipped.txt`       |
| fixture false drains               | 0 (17/17 labelled pairs kept)                         | 0 (17/17 labelled pairs kept)                          | `fixture-drain-shipped.txt`       |
| fixture, per-class table           | see `fixture-drain.txt`                               | identical, row for row                                 | `fixture-drain-shipped.txt`       |
| fixture superset at the 0.60 floor | 18 written, 18 kept, 0 extra                          | 18 written, 18 kept, 0 extra                           | `fixture-drain-shipped.txt`       |
| independent recomputation          | 0 mismatches                                          | 0 mismatches over 225 + 295 pairs                      | both shipped files                |
| undo                               | 207 reverted, 207/207 clean, next pass excludes 207   | 207 reverted, 207/207 clean, next run examines only 18 | `fixture-drain-shipped.txt`       |
| fixture, lexical-only arm          | 0 drained, 225 kept (213 vector unknown)              | 0 drained, 225 kept (213 vector unknown)               | `fixture-drain-shipped.txt`       |
| no model inference                 | 225/225 identical, `memory_vec` 51 → 51, load refused | 225/225 identical, `memory_vec` 51 → 51, load refused  | `fixture-no-embedder-shipped.txt` |
| retrieval corpus                   | 241 drained (235 rules, 6 retired), 54 kept by vector | 241 drained (235 rules, 6 retired), 54 kept by vector  | `corpus-drain-shipped.txt`        |
| corpus superset at the 0.60 floor  | 54/54, 0 extra                                        | 54/54, 0 extra                                         | `corpus-drain-shipped.txt`        |

The shipped entity channel unions each endpoint's stored links with its fresh extraction (design D2), where the prototype compared stored with stored and fresh with fresh. The union can only add keeps; on both data sets it changed no decision.

## Cost of the shipped step (`drain-cost-shipped.mts`)

`drain-cost-shipped.txt` holds the plain-clock run of the shipped constants; `drain-cost-shipped-budget-scan.txt` holds the scan that chose the budget. Same corpora as the prototype (`corpus:build`, 1 000 / 20 000 / 50 000 memories, ~600 and ~5 000 pending per loaded project), with memory timestamps moved to today on a private copy so decay archives nothing, and relation timestamps left aged so the deadline step orphans its 50 rows per scope per run.

- **Instrument A (drain step):** wall clock from the step's first repository read to the run's `finishRun`. "Drain per call" sums it over one sweep call; this is the figure the p95 ≤ 50 ms budget binds.
- **Instrument B (whole callback):** wall clock of one `sweepFor` or `runAll`, including decay, deadline orphaning and the session purge. It is never tabulated with Instrument A.
- **Sample:** 3 fresh copy-on-write clones × 10 consecutive calls per row; the first call of each clone is cold.

**Instrument A, drain per call, p95 / max in ms, `DRAIN_ROW_CAP = 150`, `DRAIN_BUDGET_MS = 30`:**

| memories, backlog | sweepFor (2 scopes) | runAll, 2 loaded | runAll, 7 (6 loaded) | runAll, 10  | runAll, 50  |
| ----------------- | ------------------- | ---------------- | -------------------- | ----------- | ----------- |
| 1 000, ~600       | 30.4 / 30.7         | 31.2 / 31.8      | 35.5 / 35.9          | 36.2 / 36.5 | 36.5 / 37.0 |
| 1 000, ~5 000     | 32.6 / 32.7         | 35.2 / 35.3      | 38.2 / 38.6          | 37.5 / 39.4 | 42.3 / 42.4 |
| 20 000, ~600      | 32.6 / 33.2         | 31.1 / 31.5      | 34.9 / 38.8          | 37.2 / 37.6 | 45.0 / 45.4 |
| 20 000, ~5 000    | 33.2 / 33.8         | 31.4 / 32.7      | 36.9 / 37.8          | 38.4 / 38.4 | 41.5 / 42.1 |
| 50 000, ~600      | 30.4 / 31.2         | 31.5 / 31.6      | 37.7 / 40.7          | 36.4 / 36.4 | 40.2 / 40.2 |
| 50 000, ~5 000    | 35.2 / 37.0         | 34.4 / 36.4      | 38.8 / 39.5          | 39.7 / 39.9 | 43.2 / 45.9 |

Every row meets p95 ≤ 50 ms; the worst single call is 45.9 ms. At 50 000 memories a call examines 67–77 pairs (p50). In the ~600 rows of `sweepFor`, the p50 of pairs examined is 0–8 because ten consecutive calls exhaust a 625-row backlog: the p95 is the loaded calls'.

**Instrument B** is reported per row in the file. It is dominated by work outside the drain: at 50 000 memories a 50-project `runAll` takes 1.4–1.7 s. The deadline step's read costs 29.4 ms for the empty default project and 0.32 ms for a loaded one, because it walks every project's aged pending rows; that predates this change and is recorded as an advisory, not changed here.

**Two findings from the first shipped runs, fixed before the numbers above:**

1. **The selection's indexed range was pathological for a project with few rows of its own.** For the empty default project, which every session start sweeps, it read all 30 017 pending rows: 27.8–29.5 ms per selection at 50 000 memories, against 0.04 ms with the shipped probe through the project's own memories (`selection read` lines). For a loaded project the probe costs 0.9–1.4 ms against 0.5 ms for the range alone.
2. **The budget clock ran through later scopes' decay and deadline steps,** so a session start's second scope could find its budget spent before its drain began. The budget now counts only time inside drain steps (design D7), and a step that begins with the budget spent selects one row.

**Choosing the budget.** With both fixes, the scan emulated budgets of 40, 35 and 30 ms at 50 000 memories. For a 7-project `runAll` (six loaded scopes) p95 was 48.8–49.3 / 42.4–42.5 / 36.3–36.8 ms; for a 50-project `runAll` it was 56.5–56.6 / 46.3–51.8 / 39.3–47.8 ms. 30 ms is the largest value meeting the target in both. The gap above the budget is the per-scope fixed cost after the budget is spent: in the plain-clock run of 50-project calls, the drain step's p50 is 0.1 ms and its p95 0.6–1.1 ms (`per drain step` lines).

**The reverted-op lookup** reads once per sweep call: 0.08–0.14 ms at 1 000 ops, 0.53–0.62 ms at 10 000 and 5.5–5.8 ms at 100 000, with every tenth op reverted. Excluding 10 000 reverted ids inside the selection costs 6.4–6.6 ms per selection against about 1 ms with none. Both run inside the drain's budget, so they shrink its throughput rather than extend the call; no index is needed at these sizes.

**Expected drain time for the 589-row backlog:** `ceil(589 / 150) = 4` runs when the budget does not cut a run short, 589 runs at worst. Measured calls examined 100–110 pairs at 1 000 memories and 67–77 at 50 000, so a 589-row backlog in one scope takes about 6–9 runs at those sizes: 6–9 days of session starts, or that many dashboard "run now" clicks.

## Prototype figures measured on a backup copy (design D11)

These figures come from the parent's prototype run on a BACKUP COPY of a real installation's database, never the live file. Only aggregate figures are recorded: no content, titles, project names or identifiers. They are prototype figures; the committed measurements in this directory are the evidence for the constants.

- 20% of pending rows were drained by the rules, and 28% had a retired endpoint.
- 0 of the drained pairs shared an entity when re-extracted independently.
- An independent re-verification of the verdicts found 0 mismatches.
- Undoing the drain restored the relations table byte for byte.
- A second pass drained 0.
- The cost was about 0.13 ms per pair, and a 400-pair run took about 49 ms on that host.

## Findings and proposed changes (not applied silently)

1. **Use `(created_at, judgment_id)` order for the selection.** It is the same order with no migration, and it is what makes the shared budget hold (validation 8).
2. **Filter excluded rows in the selection, or keep selecting until B examinable rows are found.**
   - The prototype excludes after selecting, so excluded rows occupy batch slots.
   - A batch made only of excluded rows examines no pair; the cursor still advances.
   - The prototype first stopped its pass loop on such a batch. That was fixed before the v3 runs.
3. **Entity index reset** (probe A, `mechanics.txt`; v1 result in `v1-mechanics.txt`).
   - Under v1, after `EntityBackfillWorker.resetIndex()`, a genuine entity-only pair was really drained.
   - B3's re-extraction (v2 and v3) keeps it inside the reset window. The v1 scan-guard amendment is no longer needed.
4. **The deadline step still re-orphans an undone row.** `runScope` re-orphaned a restored deadline orphan on its next run (`mechanics.txt`). Undo-final protects only against the drain.
5. **One unexplained outlier.** In `v2-drain-cost.txt` at 20 000 memories / 4 959 backlog, `judgment_id`, B = 1000, the median run took 969 ms. It did not recur in v3 (265.6 ms), and it is not used for any recommendation.
