# Measurements

Every ratio carries its denominator. This code path has already produced two vacuous zeros that
only that discipline caught.

## Why neither available corpus is the instrument (task 2.1)

The gate is `f(Lₐ, A)` over two integers, so a table over a grid is **complete** where a corpus
sample is a sample — and it is the only instrument that can drive the gate in **both** directions.

- **The eval corpus** (`test/retrieval/corpus.ts`) carries 2 entity links in total across its 40
  items. It cannot take a single gate decision, let alone discriminate between two thresholds.
- **The resident dev corpus** took every one of its gate decisions at a single `A`, so it cannot
  observe the small-`A` regime at all — which is the entire regime this change touches.

**Not re-derivable, stated rather than quietly dropped.** The dev-corpus figures below are
propose-time observations (2026-07-29). That corpus no longer exists: `pnpm run dev:docker:up`
runs `seed-dev --reset` on every boot and destroyed it earlier in this session. They are retained
because they justify a _rejection_ (the corpus is not an instrument) and seed a _follow-up_, not
because anything here depends on them:

| figure                                                 | value (propose-time) |
| ------------------------------------------------------ | -------------------- |
| memories: active / superseded / archived               | 1443 / 601 / 11      |
| entity links                                           | 2441                 |
| distinct entities                                      | 32                   |
| entities the gate blocked                              | **0 / 32**           |
| admitted entities carrying `Lₐ ≥ 5` (the D5 seed)      | **31 / 32**          |
| top entity's ratio                                     | 216/1443 = 0.1497    |
| `T` interval over which its 32 decisions are identical | `[0.0194, 0.1303)`   |

That interval is a **seed artifact**, not a calibration: the seed's entity assignment is bimodal
(26 entities at ≤ 0.0194, 6 at 0.1303–0.1490, nothing between), so neither the plateau nor its
interior is evidence about a real population. Tasks 2.4 and 2.5 cannot be re-run; if the corpus is
ever rebuilt and its distribution is no longer bimodal, that weakens design D1's second reason and
must be recorded rather than smoothed over.

## The decision table (tasks 2.2, 2.3)

Exhaustive enumeration of `f(Lₐ, A)` at `T = 0.15`, before and after the floor, over
`Lₐ ∈ 0..10` × `A ∈ {1..40, 100, 500, 1443}` — **473 cells**. The script is apply evidence, not a
shipped harness, so it is not committed; the recipe is:

```js
const blocksBefore = (La, A) => A > 0 && La / A > 0.15;
const blocksAfter = (La, A) => A > 0 && La >= 5 && La / A > 0.15;
```

**64 of 473 cells change decision, and the blast radius is exactly what design D2 claims** —
verified by enumeration, not by argument:

| `Lₐ` | cells whose decision flips | max `A` | contiguous from `A = 1` |
| ---- | -------------------------- | ------- | ----------------------- |
| 1    | 6                          | **6**   | yes                     |
| 2    | 13                         | **13**  | yes                     |
| 3    | 19                         | **19**  | yes                     |
| 4    | 26                         | **26**  | yes                     |

**No cell with `Lₐ ≥ 5` moves at any `A`**, including `A = 1443`. So the floor is a small-scope fix
with no effect at scale, which is what makes it safe to ship without the calibration the threshold
cannot have. Task 2.3's stop condition was not triggered.

The small-`A` dead zone the floor removes, before it: one link blocked in any scope with `A ≤ 6`;
four links blocked up to `A ≤ 26`.

## Saturation — the D5 seed for the follow-up (task 5.2)

One admitted entity may carry `⌊T·A⌋` links. Closed form: **saturation of the per-save budget is
possible once `⌊T·A⌋ ≥ CANDIDATES_PER_SAVE_MAX`, i.e. from `A ≥ CANDIDATES_PER_SAVE_MAX / T = 34`
at the defaults.** At `A = 34` one entity may carry 5 links — the whole budget. At `A = 1443` it may
carry **216**.

This change does **not** restore the composition guarantee, and does not claim to. A per-entity
proportion gate cannot bound a shared fixed-size budget; bounding the entity channel's slot share
belongs at the merge step and needs a different instrument (per-save composition over a real
ingest, not a decision table). Named as a follow-up and seeded with the 31/32 figure above.

## Added pending judgments (task 5.1)

By construction rather than by sampling, since the closed form is exact. The floor can only _add_
a candidate where the gate would have blocked and `Lₐ ≤ 4`, which requires `A ≤ 26`. On such a
scope, if the per-save cap does **not** bind, the added candidate is an added pending judgment,
bounded per save by the pre-existing `CANDIDATES_PER_SAVE_MAX`. If the cap **does** bind, the
expected result is **zero** added pendings — the entity candidate displaces a lexical or dense one
rather than adding to the total. That displacement is the expected result, and must not be read as
"no effect".

**Found by review, measured, and NOT contemplated by the proposal: the displacement can be total.**
The floor is justified per entity — one sub-floor entity cannot occupy the budget — but the budget
is shared and entity candidates lead unconditionally, so several separately-exempt entities from one
save can take every slot. Measured at the shipped defaults on a six-memory scope, with five distinct
one-link entities (each `1/6 = 0.167 > 0.15`, so every one blocked before the floor and exempt
after):

|                           | `detected` | sources returned | FTS hit on a byte-identical duplicate |
| ------------------------- | ---------- | ---------------- | ------------------------------------- |
| floor absent (pre-change) | 1          | `['fts']`        | **surfaced**                          |
| floor present (shipped)   | 6          | `['entity'] × 5` | **displaced**                         |

This is the same proportion-versus-shared-budget mechanism defect the composition follow-up owns
(D5), reached through many sparse entities rather than one ubiquitous one — so this change extends
that defect into the small-`A` regime rather than being confined to it. The delta specs no longer
claim otherwise, a test pins the behaviour so it is contracted rather than incidental, and bounding
the entity channel's slot share stays with the follow-up, which is where the merge-step change
belongs.

## Threshold coupling in the existing suite (task 4.7)

Ratios each fixture relies on. Marked whether the number is **asserted** in the test or only stated
in a comment, because the distinction is the difference between a pin and a note:

| fixture                                              | direction | ratio                  | asserted?                |
| ---------------------------------------------------- | --------- | ---------------------- | ------------------------ |
| a young scope is not gated into silence              | admits    | 1/2 = 0.500            | yes, both counts         |
| the floor is not a small-scope bypass                | blocks    | 5/8 = 0.625            | yes, both counts         |
| several separately-exempt entities fill the budget   | admits    | 1/6 = 0.167 per entity | via the returned sources |
| an entity concentrated on the active population      | blocks    | active 5/20 = 0.250    | yes, both counts         |
| ” (its non-archived half)                            | —         | 6/34 = 0.176           | comment only             |
| a long superseded topic chain does not switch it off | admits    | active 1/11 = 0.09     | comment only             |
| ” (its non-archived half)                            | —         | 6/16 = 0.375           | comment only             |
| the count MAY exceed `CANDIDATE_POOL_SIZE`           | admits    | 10/130 = 0.0769        | comment only             |

**CORRECTED after review — the earlier version of this section recorded a figure this change had
itself falsified, in the direction that flattered it.** It claimed "the tightest admitted fixture is
`3/23 = 0.130`, so the suite would break if `ENTITY_RARITY_THRESHOLD` were lowered below `0.13`".
That fixture has `Lₐ = 3`, which is BELOW the new floor, so the gate no longer consults `T` for it
at all. The audit had been run against the pre-change code.

Measured by sweeping the constant and running the suite:

| `T`                               | result                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| 0.26, 0.25                        | 1 failed — the rescaled population test (`5/20 = 0.25`, and `>` is strict)  |
| 0.15 (shipped), 0.10, 0.08, 0.077 | 33 passed                                                                   |
| 0.07, 0.05                        | 1 failed — _the count MAY exceed `CANDIDATE_POOL_SIZE`_ (`10/130 = 0.0769`) |

So the suite pins `T` to roughly **`[0.077, 0.25)`**, and this change **halved the lower half of that
pin** — from ≈`0.13` to ≈`0.077` — by putting three fixtures below the floor where `T` is never
consulted. Recorded rather than left as a silent weakening: anyone lowering the threshold now has
less protection from this suite than the pre-change numbers implied.

## Mutation checks, both directions, with counts (task 4.5)

Baseline `32 passed (32)` over `save-time-candidates.test.ts`.

| mutation                                               | result               | failing test                                                                                    |
| ------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| (a) remove the floor condition                         | 1 failed / 31 passed | a young scope is not gated into silence                                                         |
| (b) `>=` → `>` (floor lets `Lₐ = 5` through)           | 3 failed / 29 passed | the AT-the-floor boundary, plus both `Lₐ = 5` fixtures                                          |
| (c) revert `scopeActiveMemoryCount` to `!= 'archived'` | 1 failed / 31 passed | **the rescaled population test — still fails, so the rescale did not unpin the population fix** |
| (d) revert `entityLinkCount` to `!= 'archived'`        | 1 failed / 31 passed | a long superseded topic chain does not switch the channel off                                   |

(c) is the one that matters: task 4.1 forbids weakening that test, and it is the only assertion
that fails when `scopeActiveMemoryCount` alone is reverted.
