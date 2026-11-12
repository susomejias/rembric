# Measurements — orphan pending judgments at retirement

Every file names its instrument, and rows from different instruments are never tabulated together. Every script runs against throwaway databases in a `mktemp -d` directory outside the workspace. The only data source is the `corpus:build` generator (`apps/web/src/scripts/seed-volumetric.ts`), built with `skew`, so project `vol-0` holds 60% of the memories. No production data was read or written.

```sh
export RETIRE_SCRATCH=$(mktemp -d) TMPDIR=$RETIRE_SCRATCH
pnpm --filter @rembric/core exec tsx ../../openspec/changes/orphan-pendings-on-retirement/measurements/<script>.mts
```

Under `tsx`, `packages/core/tsconfig.json` maps `@rembric/*` to `src/`, so the scripts and the corpus generator share one module instance.

| file                                                      | instrument                                                                                  | when                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `retirement-cost.mts` → `retirement-cost-before.txt`      | wall clock of one public entry-point call per retirement path, warm, median and p95         | base commit `4fef7a77`, before any code change (task 1.1) |
| `retired-verdicts.mts` → `retired-verdicts-synthetic.txt` | read-only count of verdicts recorded after an endpoint retired, with a scratch-copy control | before any code change (task 1.2)                         |

## Retired-endpoint verdicts (task 1.2, design D10)

On the synthetic corpus the control passes: one late `not_conflict` verdict added to a scratch copy raises the late count by exactly one. The count itself is meaningless there, because the generator judges random pairs after every memory exists, whatever its status. The production figure is the operator's task 8.4: run the script with `DB_DIR` pointing at a directory that holds a backup copy of `data.db`. The script opens that database read-only and prints aggregates only.

## The helper's read (task 2.2, design D2)

`query-plan.mts` → `query-plan.txt`. Instrument: `EXPLAIN QUERY PLAN` of the statement Drizzle builds for `listPendingTouchingAny`, plus the wall clock of one warm one-id call (median of 2 000).

At 1 000, 20 000 and 50 000 memories, SQLite runs a `MULTI-INDEX OR`: `memory_relations_source_status_idx (source_id=? AND status=?)` for one side and `memory_relations_target_status_idx (target_id=? AND status=?)` for the other. Only the rows found are sorted. The one-id read takes 0.03 ms at every size.
