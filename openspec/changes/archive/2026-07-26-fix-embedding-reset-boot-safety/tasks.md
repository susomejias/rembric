## 1. Reproduce the defect before changing it

- [x] 1.1 Write a failing test that arms `writeFileSync` to throw on its first call, points `ensureVectorModel` at a data dir with a stale marker and a populated `memory_vec`, and asserts the current code both throws AND has already emptied `memory_vec`. This is the whole defect in one assertion; it must fail on `main` before any fix lands.
- [x] 1.2 Note the mechanism constraint in the test file: this repo's test process runs as **root**, and root bypasses file permission bits, so a `chmod 0444` marker stays writable and a permission-based test passes vacuously. Use a partial `vi.mock('node:fs', importOriginal)` with an armed counter, or a data dir path whose parent does not exist (ENOENT) for the pre-wipe case. Do not use `chmod`.
- [x] 1.3 Confirm `apps/server/src/server/bootstrap.ts:167` has no `try/catch` while `:200-206` (the entity counterpart, added by fc6e2ff) does — the asymmetry is the second half of the defect and both halves are in scope.

## 2. Two-phase marker in `apps/server/src/embeddings/state.ts`

- [x] 2.1 Extend `EmbeddingState` with an optional in-progress field and have `readMarker` treat it as a mismatch. Absent means settled (design D5) — an upgraded install must read its existing marker as a match and perform no reset. One line of comment on why this default is the opposite of the `inputVersion` default; nothing more.
- [x] 2.2 Reorder `ensureVectorModel` to: write the in-progress marker → `count()` → `deleteAll()` when non-zero → write the settled marker. The in-progress write must happen on every mismatched boot, including one whose marker already carries the compiled-in identity but is in progress (design D2) — this is what makes an unwritable data dir perform zero wipes instead of one per boot.
- [x] 2.3 Change the return to `{wiped, markerWritten}` and catch marker I/O inside the function rather than throwing it out (design D3), so a committed wipe and an unsettled marker can be logged as two separate facts. Update the module docstring's "wipe the derived vectors, record the new identity" sentence, which now states the order backwards.
- [x] 2.4 Do NOT add `fsyncSync` or a temp-file rename (design D4) and do NOT touch the identity comparison itself — the two axes and their semantics are unchanged.
- [x] 2.5 Keep all SQL where it is: `count()` and `deleteAll()` stay in `db/repositories/vectors-repository.ts`, both single statements, and no transaction is opened by a repository.

## 3. Boot call site in `apps/server/src/server/bootstrap.ts`

- [x] 3.1 Wrap the `ensureVectorModel` call in `try/catch`, mirroring the shape at `:200-206`, with a warning that names the marker path and says the index is left as-is and re-checked next boot.
- [x] 3.2 Log the two outcomes separately: the existing `N stale vector(s) wiped` warning, and a distinct warning when `markerWritten` is false stating that the reset may repeat on the next boot.
- [x] 3.3 Verify by reading the surrounding code that nothing between `ensureVectorModel` and the listener bind depends on the reset having happened — the `EmbeddingWorker` and `MemoryService` are constructed after it and neither reads the marker.

## 4. Evidence gate — unit tests (deterministic, no measurement harness)

- [x] 4.1 Turn 1.1 green in the fixed form: `writeFileSync` fails on the in-progress write → `memory_vec` row count is UNCHANGED, the call does not throw, and the marker on disk is byte-identical to what it was.
- [x] 4.2 The core case: `writeFileSync` succeeds once and fails on the **second** call (the settle), so the wipe commits and the flip does not. Assert (a) the call does not throw and returns `wiped > 0, markerWritten: false` — boot survives; (b) the on-disk marker does NOT assert the compiled-in identity as settled; (c) a second `ensureVectorModel` call with writes restored converges — the marker ends settled and `EmbeddingWorker.processBatch` refills every non-archived row. All three assertions in one test, since the requirement is about the sequence.
- [x] 4.3 Repeat-boot case: with writes failing permanently, call `ensureVectorModel` three times and assert `memory_vec` was never touched — zero wipes, not one per boot. This is the assertion that distinguishes this fix from plain marker-first ordering.
- [x] 4.4 In-progress-marker case: hand-write a marker carrying the compiled-in identity WITH the in-progress field set, and assert the reset runs rather than short-circuits.
- [x] 4.5 Upgrade case: hand-write a marker carrying the compiled-in identity with NO in-progress field, and assert `wiped === 0` and that no write to the marker is attempted (spy on `writeFileSync`, expect zero calls).
- [x] 4.6 Confirm the four pre-existing cases in `apps/server/src/embeddings/state.test.ts` still pass unmodified. If any needed editing, say which and why — a green suite that had to be adjusted is weaker evidence than one that did not.
- [x] 4.7 No measurement harness and no `pnpm run eval` for this change: every claim is a deterministic ordering property of two synchronous calls, fully unit-testable, and neither ranking, fusion, boosts, nor the drain's batch/tick shape is touched. If implementation drifts into the search or drain path, that assumption is void and `pnpm run eval` becomes required.

## 5. Verify

- [x] 5.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` all clean. Record the file/test counts.
- [x] 5.2 Confirm `apps/server/src/test/invariants.test.ts` still passes untouched — in particular the data-access-confinement gate, since this change moves no SQL and must not need an allow-list entry.

## 6. Real Docker smoke against pre-existing seeded data (operator-run on the host)

- [x] 6.1 `pnpm run dev:docker:up` (wipes and reseeds). Record the seeded memory count and the `memory_vec` row count once the first drain tick has run. Remember `data-dev` must be owned by `10001:10001` or the stack dies with `SQLITE_CANTOPEN`.
  - Result: 35 non-archived memories; `memory_vec` = 857 at boot, 882 after the first drain tick. 847 of those rows are orphans left by earlier `seed-dev --reset` runs, which wipe `memory` but not `memory_vec`; only 35 have a live `memory` row.
- [x] 6.2 Stop the container. On the host, overwrite `data-dev/embedding-state.json` with a deliberately stale identity (`{"modelId":"stale-model","inputVersion":"stale"}`), then `chown 0:0` and `chmod 0444` it. The container process runs as uid 10001, so unlike the host test environment this produces a genuine `EACCES` on `writeFileSync` while leaving the database fully writable — the exact production shape of the bug.
- [x] 6.3 Start the container and assert: the healthcheck goes green (the listener bound), the log carries the marker warning naming the path, the `memory_vec` row count is UNCHANGED from 6.1, and an MCP `memory.search` with a text query still returns results. On `main` this step must instead show the container failing to start with an empty `memory_vec` — capture both, since the before/after is the evidence.
  - With the fix: healthcheck Healthy, `/healthz` 200, `[warn] could not persist /data/embedding-state.json; …`, `memory_vec` = 882 (zero rows lost), marker byte-identical (the pending write failed before any wipe), and `memory.search` over `/mcp/demo` returned 3 hits. On `main` (same poisoned marker): `rembric: EACCES: permission denied, open '/data/embedding-state.json'`, no `listening on` line, `/healthz` connection-refused, container `unhealthy`, `memory_vec` = 0.
- [x] 6.4 Restore the marker (`chown 10001:10001`, `chmod 0644`) and restart. Assert: the log reports N stale vectors wiped, the marker on disk ends settled on the real compiled-in `modelId` and `inputVersion`, and the drain refills `memory_vec` to the 6.1 count. Confirm the marker file's owner/mode are back to what `dev:docker:up` leaves so the next bring-up is not poisoned.
  - Log: `[warn] embedding model changed → 25 stale vector(s) wiped`; marker ends `{modelId: onnx-community/gte-multilingual-base, inputVersion: v2-title-content, pending: false}`; drain refilled `memory_vec` to 35. The refill target is 35, not the 882 of 6.1: the 847 orphaned vec rows have no `memory` row to re-embed from, so 35 IS the fully-converged derived state.
- [x] 6.5 Also verify the plain upgrade path on this same populated data dir: with the marker settled and correct, one further restart must wipe nothing and rewrite nothing (grep the log for the absence of both warnings). This is the case every real installation will actually take.
  - Confirmed twice: the very first boot (6.1) read the pre-existing marker — written by a build predating this change, no `pending` field — as settled, and the final boot repeated it. Both left the marker byte-identical with an unchanged mtime, and logged neither warning.
- [x] 6.6 Note in the task record that the "wipe commits, settle fails" interleaving is NOT reproducible in Docker — both writes target the same file, so no static permission state can fail only the second — and is therefore covered by 4.2 alone. State this explicitly rather than leaving the smoke looking incomplete.
  - Confirmed not reproducible in Docker: the pending write and the settle write target the same path, so no static owner/mode can fail the second while permitting the first. That interleaving rests on 4.2 alone.

## 7. Docs and cross-references

- [x] 7.1 Re-read `openspec/specs/persistence/spec.md:747` and the restore procedure in `docs/backup.md` against the new marker shape. Expect no change needed: an in-progress marker behaves like a missing one, and the documented hazard is a SURVIVING MATCHING marker. Confirm rather than assume, and say so.
  - Confirmed by re-reading both: no change needed. `persistence` spec line 747 and `docs/backup.md` §Restoring a snapshot both hinge on a SURVIVING MATCHING marker being the trap and a MISSING one being safe. A `pending: true` marker no longer matches, so it lands on the safe side; the instruction to delete both markers stays correct and sufficient.
- [x] 7.2 Leave a pointer between the two recipe-marker modules so a reader of either finds the other's mechanism: `embeddings/state.ts` uses two-phase, `services/entity-state.ts` uses marker-first plus an atomic wipe. One line each, stating the fact — not a banner, not a restatement of the code.

## Deferred (verified, deliberately NOT in this change)

- **The entity-side inverse hazard.** `ensureEntityExtractor` writes `entity-state.json` and then calls `resetEntityIndex` in a transaction. A `truncateAll` that fails entirely rolls back, leaving `memory_entity_scan` populated under a marker asserting the new `EXTRACTOR_VERSION`; the next boot returns `{reset: false}` and the entity index stays on the old recipe silently and permanently. Real, same class as this defect, but silent-wrong rather than boot-blocking, and the rebuild it costs is under 2 ms per memory. Deferred on scope, not spec cost: two-phase preserves marker-before-wipe, so `memory-entities/spec.md:241` needs no edit (see design D6). `tighten-entity-extraction-precision` already owns `entity-state.ts` and fixes this. Own change, own before/after.
- **Surfacing the unsettled-marker warning on the dashboard.** Open question in `design.md`; default taken is log-only, matching every other boot-time degradation in this server.
