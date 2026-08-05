# Phase 3 — the over-widening arm goes RED

Lives in `evidence/` rather than `measurements/` only because `measurements/` was
being written concurrently by phase 2 and the two must not collide.

## What this establishes

Before this phase, a mutation that destroys scope isolation left `pnpm run eval`
**green with MRR@8 rising**. After it, the same mutation fails the run and names
the metric. Both directions were executed, on this branch, at the commits stated.

`retrieval-evaluation/spec.md`'s requirement is discharged by demonstration, not
by construction: the metric existing is not the evidence, the red is.

## Reproduction

The eval is a `tsx` script, not a vitest spec, so `scripts/mutate.mjs` cannot
drive it (`runSpec` hardcodes `pnpm vitest run`). The loop below is the same
backup / mutate / run / restore / byte-verify shape, applied by hand. Every run
restored the mutated file and re-read it to confirm the restore.

```
# baseline
pnpm run eval

# mutation A — dissolve the lexical scope predicate (the arm `retire-the-global-scope` 16.15 measured)
#   apps/server/src/db/repositories/scope-clause.ts::scopeWhere
#   sql`${p}scope = 'project' AND ${p}project_id = ${projectId}`  ->  sql`${p}scope = 'project'`

# mutation B — A, plus the dense branch's partition predicate
#   apps/server/src/db/repositories/vectors-repository.ts::knnByQueryVector
#   `AND partition_key = ${opts.partitionKey}`  ->  (deleted)

# mutation C — the widening returns home-project rows only
#   apps/server/src/test/retrieval/retrievers/hybrid.ts
#   `if (scope.projectIds.length === 1) return searchOne(...)`  ->  `return searchOne(...)`
```

## Before — the harness scored the loss of isolation as an improvement

At `dd5435f` (phase 1 landed, phase 3 not started), corpus 44 memories, 24 queries.

| run        | P@8   | R@8   | MRR@8     | verdict   |
| ---------- | ----- | ----- | --------- | --------- |
| unmutated  | 0.156 | 1.000 | 0.828     | **GREEN** |
| mutation A | 0.156 | 1.000 | **0.891** | **GREEN** |

The proposal quotes 0.828 → 0.859 from the archived measurement; re-measured at
this branch's HEAD, after phase 1 moved the ex-global fixtures onto `shared`, the
rise is larger, 0.828 → **0.891**. Not one gated metric moved the right way.

## After — phase 3's corpus, query set and gates

Corpus 70 memories, 28 queries (20 gold-bearing, 8 abstention). Unmutated:

| retriever      | k   | P@k    | R@k    | MRR    | foreignScopeRate | rows scored |
| -------------- | --- | ------ | ------ | ------ | ---------------- | ----------- |
| hybrid         | 5   | 0.3100 | 0.9563 | 0.8542 | **0.0000**       | 105         |
| hybrid         | 8   | 0.2125 | 0.9750 | 0.8542 | **0.0000**       | 147         |
| grep           | 5   | 0.2700 | 0.7562 | 0.7500 | **0.0000**       | 130         |
| grep           | 8   | 0.2062 | 0.9000 | 0.7643 | **0.0000**       | 208         |
| memory-md-dump | 5   | 0.0900 | 0.3750 | 0.2158 | **0.0000**       | 130         |
| memory-md-dump | 8   | 0.0750 | 0.5250 | 0.2364 | **0.0000**       | 208         |

`foreignScopeRate` reads exactly 0 over a **non-zero** denominator on every arm,
which is asserted by the harness itself (`checkSanity` fails a run that scored
the cap over 0 rows) — a cap of 0 is otherwise satisfied by an empty result set.

### Mutation A — dissolve the lexical scope predicate

```
rembric retrieval eval FAILED:
  - hybrid@5 foreignScopeRate regressed: 0.080 > committed cap 0.000
  - hybrid@8 foreignScopeRate regressed: 0.126 > committed cap 0.000
hybrid  P@8=0.212 R@8=0.975 MRR@8=0.858 foreignScope=0.126 (over 167 rows)
```

**RED.** Worth stating plainly, because it is the finding rather than a footnote:
**MRR@8 still rises** under the mutation, 0.854 → 0.858, and P@8 and R@8 do not
move at all. The gate works _despite_ the quality metrics, not through them. Had
this phase shipped only the larger gold sets and the cross-project distractors,
the arm would still be green.

### Mutation B — A plus the dense branch's partition predicate

```
rembric retrieval eval FAILED:
  - hybrid@5 foreignScopeRate regressed: 0.150 > committed cap 0.000
  - hybrid@8 foreignScopeRate regressed: 0.179 > committed cap 0.000
hybrid  P@8=0.212 R@8=0.975 MRR@8=0.917 foreignScope=0.179 (over 168 rows)
```

**RED**, and the total loss of isolation reads as MRR@8 0.854 → **0.917** — the
largest quality "improvement" of any arm measured here.

### Mutation C — the widening returns home-project rows only

```
rembric retrieval eval FAILED:
  - hybrid recall@8 (0.875) does not beat grep (0.900) — the corpus does not discriminate
  - hybrid@5 recallAtK regressed: 0.856 < committed floor 0.906
  - hybrid@8 recallAtK regressed: 0.875 < committed floor 0.925
hybrid  P@8=0.200 R@8=0.875 MRR@8=0.817 foreignScope=0.000 (over 147 rows)
```

**RED.** This is the demonstration design OQ6 requires: widened queries are
excluded from `foreignScopeRate`'s denominator, so their being "gated by a
different instrument" had to be shown rather than asserted. R@8 falls 0.975 →
0.875 — exactly 2/20, the two widened queries going from recall 1.0 to 0.0 —
because their gold lives in a project the home scope cannot reach.

### Restore

Every mutation restored its file and re-read it byte-for-byte. The unmutated run
after all three: **GREEN**, at the figures in the table above.

## The cross-project distractors are strong, measured rather than asserted

`queries.test.ts::'the cross-project distractors are strong enough to displace
gold'` scores both large-gold queries with the scope predicate lifted (the
widened arm reads every project) and asserts that the `shared` restatements land
inside the page **and** push gold out of it, beside a non-vacuity control that
the narrow page answers the query. A distractor no retriever would return proves
nothing about isolation, which is why the assertion is a displacement and not a
mention.

## Baselines: what moved, and why

Re-derived once, after the fixtures settled. Run first **without**
`--lower-floors`, which printed ten held bounds:

```
hybrid@5 recallAtK floor held at 0.919; a rewrite would have dropped it to 0.906
hybrid@8 recallAtK floor held at 0.950; a rewrite would have dropped it to 0.925
grep@5 recallAtK floor held at 0.794; a rewrite would have dropped it to 0.706
grep@8 recallAtK floor held at 0.887; a rewrite would have dropped it to 0.850
memory-md-dump@5 precisionAtK floor held at 0.062; ... to 0.040
memory-md-dump@5 recallAtK floor held at 0.419; ... to 0.325
memory-md-dump@5 mrr floor held at 0.220; ... to 0.166
memory-md-dump@8 precisionAtK floor held at 0.044; ... to 0.025
memory-md-dump@8 recallAtK floor held at 0.606; ... to 0.475
memory-md-dump@8 mrr floor held at 0.245; ... to 0.186
```

Five of those were live failures against the committed baselines (`grep@5`
recall, `memory-md-dump@5` recall and mrr, `memory-md-dump@8` recall and mrr).

**Cause, measured rather than argued.** The same scoring code was run against the
COMMITTED fixtures first and reproduced the pre-change numbers exactly — hybrid
P@8 0.156 / R@8 1.000 / MRR@8 0.828, grep 0.148 / 0.938 / 0.724, memory-md-dump
0.094 / 0.656 / 0.295 — so no bound moved because of the new metric. Then the
per-query k=8 scores of the 24 pre-existing queries were diffed across the
fixture change:

| retriever      | pre-existing queries whose score moved |
| -------------- | -------------------------------------- |
| memory-md-dump | **0 of 24**                            |
| grep           | 3 of 24                                |
| hybrid         | 4 of 24                                |

- **`memory-md-dump` is a pure denominator effect.** Not one pre-existing query
  moved; its aggregate fell only because four queries were added that a
  recency-ordered dump structurally cannot answer (a checklist question, and gold
  in another project). The new corpus rows are older than every pre-existing one
  precisely so this attribution is available rather than argued.
- **`grep` is denominator plus corpus growth.** Three pre-existing queries moved,
  the largest being `q-nimbus-retry-strategy` R 1 → 0: naive token-count scoring
  ranks the new nimbus runbook rows above the gold. That is the honest control
  degrading as the corpus grows, which is what a control is for. `grep` still
  loses to `hybrid` on recall@8 (0.900 vs 0.975), by a wider margin than before
  (0.075 vs 0.062).
- **`hybrid` moved 4 of 24, net upward.** Two MRR improvements
  (`q-atlas-auth-provider` and `q-isolation-commit-convention`, both 0.5 → 1.0),
  one rank shuffle, and one real loss: `q-nimbus-dup-processing-reason` R 1 → 0.5.
  Its second gold row, `nimbus-mq-decision`, now falls below the relative-level
  gate's cut. Document frequencies are server-wide (`term-statistics-repository`
  is deliberately unscoped), so growing the corpus 44 → 70 rows lowered the IDF
  of its terms relative to the page leader. One reword of the colliding runbook
  vocabulary was tried and did not recover it, which is consistent with an
  index-wide IDF shift rather than a single displacing row.

**Verdict: a query-set change, named, not a retrieval regression.** The ten bounds
were then lowered with `--lower-floors`, every one of them printed as `LOWERED`.
Several other bounds moved UP in the same write (hybrid P@8 0.106 → 0.162, MRR
0.733 → 0.804; the `overAbstentionRate` cap tightened 0.0625 → 0.05 on all three
retrievers), because the ratchet re-derives every bound from the new measurement.

**The one loosening worth calling out on its own** is `hybrid@8 recallAtK`
0.950 → 0.925, since hybrid is the production path. Its sensitivity is unchanged
— the floor is still `measured − 0.05` — and the metric now has somewhere to
fall that it did not have before: with a `|gold| = 8` query in the set, R@8 is no
longer pinned at 1.0 by construction.

## What this does NOT establish

- **It does not establish that the shipped widening will rank as well as the
  harness's stand-in.** Phase 3 has no production widening to drive, so the
  widened arm runs one search per project and fuses per-project ranks — a shape
  the design rejects for production precisely because it hands every project a
  rank-1 row. Its per-query MRR is therefore pessimistic (gold at rank 2 and rank
  4 on the two widened queries), which is the safe direction for a floor: a
  globally distance-ordered implementation should clear it, and one that does not
  reddens it. That is the gate doing its job, not a defect in it.
- **It does not gate the token cost of widening.** `avgTokensReturned` carries no
  ceiling and is not promoted to one here. A widening that returns the same eight
  rows from the wrong projects moves no token count; a widening that doubles the
  tokens returned from authorized projects breaches no cap.
- **It does not gate abstention quality on a widened query.** `ABSTENTION_FLOOR`
  is still `null` and `abstentionFalsePositiveRate` is capped at 1.
- **`foreignScopeRate` is zero-tolerance by design and therefore brittle by
  design.** Any future retriever that legitimately returns a row outside the
  query's project on a non-widened query fails the run. That is the intent: the
  bound is an isolation gate, not a tuning bound, and `retrieval-evaluation`
  commits it at 0 with no headroom for exactly that reason.
