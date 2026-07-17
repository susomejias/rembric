## Why

Three correctness/efficiency bugs live in the same subsystem — the FTS5/vec0 sync layer that keeps `memory_fts`, `prompts_fts`, and `memory_vec` consistent with their source tables. The FTS delete triggers leak dangling postings after a physical purge and rewrite the index on every read-touch; `memory_vec.status` can go stale under a save/supersede race, letting the dense search branch violate the already-documented "status applies to both branches" guarantee; and the embedding worker scans the whole `memory` table every 30s even when there is nothing to embed. All three are implementation-only fixes with no client-facing behavior change — none add a mutation verb, none touch append-only/scope/topic_key.

## What Changes

- **FTS5 trigger fix (#254).** Migration `0020`: `memory_ad`/`memory_au`'s delete branch and `prompts_ad`/`prompts_au`'s delete branch now pass the row's real flattened tags instead of `''` to the FTS5 `'delete'` command (closes a dangling-posting leak after a physical purge, verified to let a rowid-reused row inherit a phantom tag match). `memory_au` is additionally narrowed from unscoped `AFTER UPDATE` to `AFTER UPDATE OF content, tags, title` (those columns are immutable for `memory`, so this eliminates a full FTS rewrite on every `touchLastSeen` read and status flip). `prompts_au` stays unscoped — the persistence spec requires it to re-index on `deleted_at`/`replaces` flips. The migration also runs `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` and the `prompts_fts` equivalent to heal any already-deployed database with pre-existing dangling postings.
- **`memory_vec.status` freshness fix (#257).** `VectorsRepository.insertEmbedding` now derives `status`/`type` from a live `SELECT` against `memory` in the same `INSERT` statement instead of trusting caller-supplied values captured before an `await` — closes the race where a save/supersede lands mid-embed. The now-dead `status`/`type` parameters are removed from `insertEmbedding` and `embedNow` (propagated through their full call graph). `MemoryService.search` additionally drops any hydrated row whose live status doesn't match the requested filter, as a belt-and-suspenders guard.
- **Embedding worker polling efficiency (#267).** `EmbeddingWorker` gains a `possiblyPending` flag that lets `processBatch` skip the full-table backlog scan once a scan has confirmed the queue is empty, until something signals otherwise (an inline `embedNow` failure, or a periodic forced re-check). `bootstrap.ts` keeps the existing 30s cheap-when-drained tick and adds an hourly forced re-scan as a safety net. **Behavior-preserving** (same eventual processing guarantee) — no spec delta.

No breaking changes. No invariant changes (append-only, scope-at-service, `topic_key`, judgment freshness all untouched).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `persistence`: ADD a requirement documenting the `memory_fts` trigger contract (`memory_ai`/`memory_ad`/`memory_au`), mirroring the existing `prompts_fts` requirement's detail and explaining why `memory_au`'s scoping differs from `prompts_au`'s.
- `memory`: MODIFY the "Embeddings MUST be computed in-process by a model loaded at boot" requirement's description of how `memory_vec.status`/`type` are populated (from "supplied at insert time" to "derived from the memory row's current values at insert time") — this requirement, not a `persistence` one, is where that phrase lives.

## Impact

- `apps/server/src/db/migrations/0020_fix_fts_delete_triggers.sql` — new migration (trigger drop/recreate + FTS rebuild, no table rebuild).
- `apps/server/src/db/repositories/vectors-repository.ts` — `insertEmbedding` signature + SQL body.
- `apps/server/src/db/repositories/vectors-repository.test.ts` — call site update.
- `apps/server/src/services/embedding-worker.ts` — `embedNow`/`processBatch` signatures, `possiblyPending` state.
- `apps/server/src/services/embedding-worker.test.ts` — call site update + new polling-skip tests.
- `apps/server/src/services/memory.ts` — `search` hydration status guard.
- `apps/server/src/mcp/memory-tools.ts`, `apps/server/src/mcp/server.ts` — `embedNow` type signatures.
- `apps/server/src/server/bootstrap.ts` — wiring lambda + new fallback timer.
- Issues: #254, #257, #267.
