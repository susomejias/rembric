# Measurements

Each file names its instrument. Rows from different instruments are never tabulated together.

## Running

Each script takes a corpus cache directory as its only argument and prints its file:

```sh
pnpm -r --filter "./packages/*" build
pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-search-match/measurements/<script>.mts <cache-dir> > <script>.txt
```

Use a scratch directory from `mktemp -d` as the cache. `corpora.mts` is copied verbatim from change `prune-common-terms-from-save-time-match`.

## Files

- **`baseline.txt`:** the base commit. Search statement unpruned and pruned under both fallback bounds, rows matched, top-8 fidelity, the gate's statistics read against a separate per-token read and a combined read (naive and deduplicated), and end-to-end `MemoryService.search`.
- **`retrieval-eval.txt`:** `pnpm eval` and `dump-ids.ts` on the base commit and on this change.
- **`mutation.txt`:** every new condition weakened in turn with `scripts/mutate.mjs`.
- **`search-after.txt`:** end-to-end `MemoryService.search`, the same script run from the base commit's tree and from this change's tree, alternated twice against the same corpus cache.
