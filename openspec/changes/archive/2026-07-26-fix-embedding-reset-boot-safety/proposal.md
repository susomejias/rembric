## Why

`ensureVectorModel` (`apps/server/src/embeddings/state.ts:59-73`) wipes `memory_vec` and only THEN writes `embedding-state.json`, and `bootstrap.ts:167` calls it unwrapped. On a full or read-only data dir the `writeFileSync` throws after `deleteAll()` has already committed: the boot aborts before the HTTP listener binds and before the embedding drain's first tick, so the vector index is destroyed AND nothing is left running to rebuild it. Every restart re-enters the same path and re-aborts. Recovery needs free disk, not a restart.

This is commit fc6e2ff's incident verbatim — "the write threw after the wipe, so the server refused to boot AND destroyed the index on every retry" — still live in 0.24.13, on the more expensive of the two derived indexes. fc6e2ff fixed the entity side (`ensureEntityExtractor`: marker first, call site wrapped) and left the embedding side untouched. The asymmetry is the whole defect: the entity counterpart at `bootstrap.ts:200-206` sits inside a `try/catch`, the embedding one at line 167 does not.

Cost asymmetry, measured: entity re-extraction is pattern matching at under 2 ms per memory (`memory-entities` spec, "Extraction cost"); re-embedding is model inference at 14–15 ms per memory, drained 25 rows per 30 s tick (`EmbeddingWorker.batchSize` = 25, `embedTimer` = 30_000 in `bootstrap.ts`). A 500-memory install therefore needs ~10 minutes of wall-clock to recover dense recall, a 10k install ~3.3 hours — and under the current bug it gets zero of that, because the process never reaches the tick. The disk-full mode is not hypothetical here: it already cost this project the 56 GB image-retention incident (issue #282, change `self-update-image-retention`).

The `memory` spec (`openspec/specs/memory/spec.md:152-166`) governs this marker and is silent on both the ordering and the failure mode, so the code cannot be said to violate a requirement today. That silence is what let the entity fix land without its sibling. The delta pins the guarantee so the next reader of either file finds it stated.

## What Changes

- **Two-phase marker instead of a single write.** `ensureVectorModel` writes `{modelId, inputVersion, pending: true}` BEFORE touching `memory_vec`, then flips it to `pending: false` after the wipe commits. `readMarker` treats `pending: true` as a mismatch, so an interrupted reset is retried on the next boot. Chosen over the entity side's single-phase marker-first ordering (`services/entity-state.ts`, spec'd at `memory-entities/spec.md:241`), which prevents the boot-block but still permits the inverse hazard: marker asserting the new recipe over an index the wipe never actually cleared, which nothing ever notices. The entity side mitigates that with an atomic wipe; two-phase removes the state instead of mitigating it, and costs one extra `writeFileSync` on the reset path only.
- **The pending write gates the wipe on every boot, not just the first.** The re-attempt is what bounds the pathological case: if the data dir is still unwritable, the pending write throws before `deleteAll()` runs, so a persistently-unwritable data dir performs zero wipes rather than one per boot. A transiently-unwritable one costs at most one extra full re-embed.
- **The call site is wrapped, matching `bootstrap.ts:200-206`.** Marker trouble degrades to "leave the index as-is, re-check next boot" rather than "no boot". This explicitly does NOT relax the model-load fail-fast rule (`memory` spec line 123): a model that cannot load still aborts the boot with a non-zero exit. Only identity-marker maintenance becomes non-fatal.
- **`ensureVectorModel` reports marker outcome rather than throwing it away.** Return becomes `{wiped, markerWritten}` so bootstrap can log both facts — a wipe that happened and a marker that did not persist are separate operator-actionable events, and today the second one is indistinguishable from a crash. The outer `try/catch` stays for the DB half (`count`/`deleteAll` can still throw).
- **No DB-resident marker.** There is no kv/settings/meta table in `apps/server/src/db/schema/` (16 tables, all domain aggregates); adding one to hold two strings would put the recipe identity inside the very artifact whose restore-from-snapshot hazard `persistence` spec line 747 documents. Rejected as disproportionate.
- **No migration, no schema change, no new MCP tool.** The marker gains an optional field; a marker written by an older build (no `pending`) reads as `pending: false` and stays a valid match, so an upgraded install performs no reset it would not have performed before.
- **NOT in this change:** the same latent hazard on the entity side (a fully-failed `truncateAll` leaves `memory_entity_scan` populated under a marker asserting the new `EXTRACTOR_VERSION`, so the index stays on the old recipe silently and forever). Verified real, cheaper to suffer, and it needs its own before/after against `memory-entities/spec.md:241`. Recorded in `tasks.md` under Deferred so it is not lost.

## Capabilities

### New Capabilities

(none — this change repairs existing behaviour)

### Modified Capabilities

- `memory`: the "Stale vectors MUST be re-embedded after a model change" requirement gains an ordering and crash-safety guarantee — the wipe and the marker advance may never be observed in the order that leaves the index empty under a marker asserting the new recipe, and marker maintenance may not abort the boot.
- `persistence`: the "Model identity mismatch triggers a backfill" scenario currently says the recorded identity is "updated on completion", which is neither what ships nor what this change makes ship. Corrected to say the identity is recorded when the wipe commits, and that a matching marker means "no pre-change vectors remain", not "the backfill is finished".

## Impact

Server:

- `apps/server/src/embeddings/state.ts` — `EmbeddingState` gains optional `pending`; `readMarker` treats `pending: true` as a mismatch; `ensureVectorModel` becomes write-pending → wipe → flip, and returns `{wiped, markerWritten}`.
- `apps/server/src/server/bootstrap.ts:167` — call wrapped in `try/catch` mirroring lines 200-206; log lines for the wipe and for a marker that failed to persist.
- `apps/server/src/embeddings/state.test.ts` — existing four cases keep passing unchanged (the marker they assert still matches on both axes); new cases for the interrupted-reset paths.
- New test file for the fs-failure cases (`node:fs` partial mock; a `chmod`-based test is useless in this repo's root-running test environment — see `tasks.md`).

No migration. No schema change. No new MCP tool. No dashboard change. No plugin change.

Invariants: append-only is untouched — `memory_vec` is derived data and remains regenerable from `memory` alone, which is precisely why wiping it is legitimate and why losing the wipe is recoverable. All SQL stays in `db/repositories/vectors-repository.ts` (`count`, `deleteAll`, both single statements, no transaction opened by a repository). Scope is not involved: the reset is a whole-index operation at boot, before any request context exists.
