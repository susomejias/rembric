# Measurements

Artifacts backing this change's numbers. Commands are run from `apps/server`. The
last row is the exception and is called out as one: §5.2's wall-clock harness was a
one-off and is not committed, so those figures are re-measurable only by rewriting it.

| File                     | Produced by                                                                                             | Task    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------- |
| `eval-before.json`       | `pnpm run eval`                                                                                         | 0.2     |
| `defect-reproduction.md` | `pnpm vitest run src/services/hybrid-search.test.ts -t 'RRF scores cannot carry a relevance threshold'` | 0.3     |
| `sweep.txt`              | `pnpm run eval --sweep-abstention`                                                                      | 4.1     |
| `eval-after.json`        | `pnpm run eval`                                                                                         | 4.6     |
| `cost.md` §5.1           | `pnpm vitest run src/db/repositories/memory-repository.perf.test.ts -t 'textByIds'`                     | 5.1     |
| `cost.md` §5.2–5.3       | **not reproducible from the tree** — uncommitted `scratch-gate-cost.ts`, described in place             | 5.2–5.3 |
