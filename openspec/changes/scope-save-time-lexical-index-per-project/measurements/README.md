# Measurements

Each file names its instrument. Rows from different instruments are never tabulated together.

## Running

Each script takes a corpus cache directory as its only argument and prints the file beside it:

```sh
pnpm -r --filter "./packages/*" build
pnpm --filter @rembric/core exec tsx ../../openspec/changes/scope-save-time-lexical-index-per-project/measurements/<script>.mts <cache-dir> > <script>.txt
```

Use a scratch directory from `mktemp -d` as the cache. The six cached corpora take about 1 GB, and each script deletes its working copies.

## Corpora and prototypes

- **`corpora.mts`:** copied verbatim from change `prune-common-terms-from-save-time-match`. It holds the skewed generator and the skewed realistic control, with six projects. The measured project holds 2%, 20% or 60% of the rows.
- **`prototype.mts`:** the prototype DDL for every option. It is never shipped.
  - Per-project (E2): a view over the project's rows, an external-content FTS5 table over that view, and three `WHEN project_id = …` triggers.
  - E1: a fourth `project_id` column.
  - The views expose raw JSON `tags`, as `memory_fts`'s own `'rebuild'` does: FTS5 cannot rebuild from a view that calls `json_each`.

## `options.txt`: save-time statement, pruning read, fidelity, build time, storage

Shapes:

- **d:** the production call, the status quo after #469.
- **b:** the project table, pruned with the project's statistics. This is options (a) and (b).
- **bG:** the project table, pruned with global statistics.
- **c:** E1.

Probes:

- **verbatim:** 10 recent memories of the project; used for cost and top-20 fidelity.
- **prefix80:** a new row holding 80% of each memory, inserted in a rolled-back transaction. It shows whether the source memory clears the floor.

Design "Options and measurements" tabulates this file.

## `search-options.txt`: interactive search under option (a)

The global `searchBm25Ids` against per-project tables. A widened search unions the per-project top windows, as production partitions by project. A separate instrument, the relevance gate's read, is shown alongside: global against the scope's vocabularies summed.

## `write-cost.txt`: insert, project creation, connection open

At 50 000 rows, with 6, 200 and 1 000 projects. The extra projects are empty, so these figures isolate the trigger fan-out and the schema size.

## `save-latency.txt`: end to end, (d) against (b)

A paired `saveMemoryWithCandidates` wall clock, using #469's design: 200 rounds and a d-against-d noise band. Option (b) is wired by wrapping the repositories, with no production code changed. The per-project triggers are installed in every arm, so (b)'s extra write is excluded here and measured in `write-cost.txt`.

## `evals.txt`: behaviour gates

`pnpm run eval:save-time`, `pnpm eval` and `dump-ids.ts`, run per option in a scratch clone:

- **`eval-prototype/apply.py`** patches the clone. **`eval-prototype/eval-prototype.diff`** is the resulting diff, and **`eval-prototype/prototype-project-fts.mts`** is the DDL module it adds (copied as `packages/db/src/prototype-project-fts.ts`).
- The `PROTO` environment variable selects the option. This seam exists only in the scratch clone, never in production code.
- **Control:** the patched clone with `PROTO` unset reproduces the base byte for byte.
- **Sanity check:** each mode was also checked to create its tables and serve both a save-time candidate and a search from them.
