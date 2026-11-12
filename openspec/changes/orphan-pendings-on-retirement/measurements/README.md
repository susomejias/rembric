# Measurements — orphan pending judgments at retirement

Every file names its instrument, and rows from different instruments are never tabulated together. Every script runs against throwaway databases in a `mktemp -d` directory outside the workspace. The only data source is the `corpus:build` generator (`apps/web/src/scripts/seed-volumetric.ts`), built with `skew`, so project `vol-0` holds 60% of the memories. No production data was read or written.

```sh
export RETIRE_SCRATCH=$(mktemp -d) TMPDIR=$RETIRE_SCRATCH
pnpm --filter @rembric/core exec tsx ../../openspec/changes/orphan-pendings-on-retirement/measurements/<script>.mts
```

Under `tsx`, `packages/core/tsconfig.json` maps `@rembric/*` to `src/`, so the scripts and the corpus generator share one module instance.

| file                                                        | instrument                                                                                              | when                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `retirement-cost.mts` → `retirement-cost-before.txt`        | wall clock of one public entry-point call per retirement path, warm, median and p95                     | the sources of base commit `4fef7a77`: first before any code change (task 1.1), then again with the one-decay-per-run script (task 7.2) |
| `retired-verdicts.mts` → `retired-verdicts-synthetic.txt`   | read-only count of verdicts recorded after an endpoint retired, with a scratch-copy control             | before any code change (task 1.2)                                                                                                       |
| `query-plan.mts` → `query-plan.txt`                         | `EXPLAIN QUERY PLAN` and warm wall clock of the helper's one read                                       | after the read landed (task 2.2)                                                                                                        |
| `mutation.txt`                                              | `scripts/mutate.mjs`, one case per weakened condition                                                   | after the code (task 7.1)                                                                                                               |
| `retirement-cost.mts` → `retirement-cost-after.txt`         | the same instrument as `retirement-cost-before.txt`                                                     | after the code (task 7.2)                                                                                                               |
| `drain-after-retirement.mts` → `drain-after-retirement.txt` | count of retired-endpoint pending rows and of retired-endpoint drains, helper copy against control copy | after the code (task 7.3)                                                                                                               |

## Retired-endpoint verdicts (task 1.2, design D10)

On the synthetic corpus the control passes: one late `not_conflict` verdict added to a scratch copy raises the late count by exactly one. The count itself is meaningless there, because the generator judges random pairs after every memory exists, whatever its status. The production figure is the operator's task 8.4: run the script with `DB_DIR` pointing at a directory that holds a backup copy of `data.db`. The script opens that database read-only and prints aggregates only.

## The helper's read (task 2.2, design D2)

`query-plan.mts` → `query-plan.txt`. Instrument: `EXPLAIN QUERY PLAN` of the statement Drizzle builds for `listPendingTouchingAny`, plus the wall clock of one warm one-id call (median of 2 000).

At 1 000, 20 000 and 50 000 memories, SQLite runs a `MULTI-INDEX OR`: `memory_relations_source_status_idx (source_id=? AND status=?)` for one side and `memory_relations_target_status_idx (target_id=? AND status=?)` for the other. Only the rows found are sorted. The one-id read takes 0.03 ms at every size.

## Mutation check (task 7.1)

`mutation.txt`. 26 runs:

- each of the six path calls deleted, run against the core tests and against the invariant scan, plus the MCP tool test and the dashboard action test for `memory.archive`;
- in the undo: the restoration, its endpoint check, its reuse of the later-verdict guard, both halves of the link (prefix and retired memories), `undoRun`'s skip and its `reverted` list;
- in the helper: the single timestamp and the retirement op's run;
- the target side of the read, and the dashboard note.

Every run turned at least one named test red.

Two mutations survived an earlier test set, and the log records each run:

- **Dropping the explicit timestamp** survived whenever the wall clock did not tick mid-call (one of three runs). The ticking-clock test from `878c2b37` catches it on every run.
- **Dropping the prefix check from the undo link** survived the first test set. `878c2b37` caught it. After `16042e95` added the retired-memory condition to the link, it survived again, because no test put a non-retirement op that touches a retired memory in the same run. The historical-run test from `b9604674` catches it.

## Cost per retirement path (task 7.2)

Instrument: wall clock of one call to the path's public entry point, warm, median and p95 of 40 calls on distinct memories (31 at 1 000 memories, where the project holds fewer). `before` ran on the base sources of commit `4fef7a77`, and `after` on the change, with the same script and the same cached corpora. Each decay gets its own run, as the sweep's do.

The first `after` run shared one run across every decay. That exposed a linking defect: undoing one decay restored or reported another decay's judgments. Commit `16042e95` fixed it, and both series were then re-run with one decay per run, so the two files in this directory come from the same script.

Added median, in ms, `after − before`, at 1 000 / 20 000 / 50 000 memories:

| path                               | k = 0 (only the read)    | k = 3 pending on each retired memory |
| ---------------------------------- | ------------------------ | ------------------------------------ |
| `topic_key` revision               | +0.065 / +0.050 / +0.030 | +0.249 / +0.297 / +0.296             |
| `supersedes` verdict               | +0.026 / +0.025 / +0.037 | +0.266 / +0.289 / +0.283             |
| `memory.archive`                   | +0.012 / +0.025 / +0.037 | +0.250 / +0.242 / +0.242             |
| `memory.merge` commit of 2         | +0.052 / +0.071 / +0.062 | +0.496 / +0.463 / +0.500             |
| decay of 1                         | +0.030 / +0.033 / +0.035 | +0.243 / +0.255 / +0.241             |
| undo of `memory.archive`           | +0.024 / +0.023 / +0.026 | +0.379 / +0.383 / +0.382             |
| undo of decay                      | +0.027 / +0.018 / +0.027 | +0.379 / +0.387 / +0.381             |
| undo of merge (successor archived) | +0.073 / +0.053 / +0.056 | +1.036 / +0.995 / +1.010             |

- With nothing to orphan, a retirement pays only the indexed read: 0.01–0.07 ms.
- Each orphaned row adds about 0.08 ms: one update, one journal insert and, for the first row, the maintenance run. The cost does not grow with the corpus, because every read and write is keyed by the retired memory.
- A merge undo pays twice: it orphans the successor's 3 rows and restores the originals' 6.
- With k = 3, the `after` p95 reaches 5.8–7.3 ms on the `topic_key`, `supersedes`, merge and merge-undo rows at 20 000 and 50 000 memories, against 0.3–1.4 ms before. Their medians stay under 1.3 ms. The cause was not investigated: the series is 40 calls, so its p95 is the second-slowest call.
- The `pending left` column is 0 on every `after` row: no pending row touches a retired memory after any measured call. On the `before` rows it counts the attached rows plus the corpus' own.

## The drain after retirement (task 7.3)

`drain-after-retirement.txt`, on the 20 000-memory corpus. Two copies start identical, and the drain first runs to exhaustion on both (1 791 older retired-endpoint rows drained in 10 calls each). Each copy then retires the same memories with 3 fresh pending judgments each, in 20 rounds of the seven paths (140 retirement calls).

| copy                                                                     | retired-endpoint pending after the retirements | retired-endpoint drains after |
| ------------------------------------------------------------------------ | ---------------------------------------------: | ----------------------------: |
| helper: the public retirement paths                                      |                                              0 |                             0 |
| control: the same memories, flipped at the repository without the helper |                                            498 |                           498 |

The runner had no vector index, no decay and no deadline, so the retired-endpoint drain was the only thing that could orphan a row. The drain still runs and still closes rows that predate the change, but after retirements made through the helper its retired-endpoint branch finds nothing.
