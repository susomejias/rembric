## 1. FTS5 trigger fix (#254)

- [x] 1.1 Add migration `0020_fix_fts_delete_triggers.sql`: `DROP TRIGGER`/`CREATE TRIGGER` for `memory_ad` (pass real tags in the delete command), `memory_au` (narrow to `AFTER UPDATE OF content, tags, title`; pass real tags in its delete branch), `prompts_ad` (pass real tags), `prompts_au` (stay unscoped `AFTER UPDATE`; pass real tags in its delete branch only).
- [x] 1.2 In the same migration, run `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` and `INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild')` to heal pre-existing dangling postings on upgrade.
- [x] 1.3 Add a regression test (throwaway on-disk DB via the real migrations) asserting: a physical purge of a tagged, disconnected archived memory leaves zero FTS matches for its tag terms; a subsequent insert reusing that rowid does not inherit a phantom match; a `last_seen_at`-only touch does not change the FTS postings for that row; a `prompts.purgeDeleted` purge leaves zero FTS matches for its tag terms; a `deleted_at`-only prompt update still leaves the row discoverable via `prompts_fts`.
- [x] 1.4 Update `apps/server/src/db/migrations.test.ts`'s hard-coded migration filename list to include `0020_fix_fts_delete_triggers.sql`.

## 2. `memory_vec.status` freshness fix (#257)

- [x] 2.1 Rewrite `VectorsRepository.insertEmbedding` (`db/repositories/vectors-repository.ts`) to derive `status`/`type` via `INSERT ... SELECT ... FROM memory WHERE id = ?`, dropping the `status`/`type` parameters.
- [x] 2.2 Update `embedNow` and `processBatch`'s per-row loop in `services/embedding-worker.ts` to drop `status`/`type` from the `insertEmbedding` call and from `embedNow`'s own signature.
- [x] 2.3 Update the `embedNow` type signature in `mcp/memory-tools.ts` (`MemoryToolDeps.embedNow`) and its call site (drop `m.status`, `m.type`); update the type signature in `mcp/server.ts`.
- [x] 2.4 Update the wiring lambda in `server/bootstrap.ts` (drop `status`, `type` params and passthrough args).
- [x] 2.5 Update call sites in `services/embedding-worker.test.ts` and `db/repositories/vectors-repository.test.ts` to drop the now-removed arguments.
- [x] 2.6 Add a regression test proving the race fix: insert a memory, change its `status` directly at the repository level (simulating a concurrent supersede), then call `insertEmbedding`/`embedNow` — assert the resulting `memory_vec.status` reflects the _current_ status, not whatever was true earlier.
- [x] 2.7 Add a status-filter guard in `MemoryService.search` (`services/memory.ts`, the `unsafeGetByIds` hydration) dropping any hydrated row whose live `status` doesn't match the requested filter; add a test constructing a mismatched dense-branch id (bypassing the normal insert path) and asserting `search` excludes it.

## 3. Embedding worker polling efficiency (#267, behavior-preserving — no spec delta)

- [x] 3.1 Add a `possiblyPending` boolean to `EmbeddingWorker` (default `true`); `processBatch(opts?: {force?: boolean})` skips the `findMissingEmbeddings` query when `!opts.force && !possiblyPending`; set `false` after a scan finds zero pending; set `true` in `embedNow`'s catch block.
- [x] 3.2 Update `server/bootstrap.ts`: keep the existing 30s timer calling `processBatch()`; add an hourly timer calling `processBatch({force: true})` as a crash-recovery/future-insert-path safety net.
- [x] 3.3 Add a test asserting `processBatch()` does not call the repository's `findMissingEmbeddings` on a second call when the first call found zero pending rows, and that it does call it again after `embedNow` records a failure, and after a forced call.
- [x] 3.4 Confirm all 5 existing `embedding-worker.test.ts` assertions still pass unmodified.

## 4. Validation

- [x] 4.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 4.2 `pnpm test` full suite green (this touches shared trigger/embedding infrastructure — not just the new tests).
- [x] 4.3 `openspec validate search-index-integrity --strict` passes.
- [x] 4.4 Update issues #254, #257, #267 with the outcome after merge.
