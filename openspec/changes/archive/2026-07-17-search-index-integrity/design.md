## Context

All three items live in the FTS5/vec0 sync layer (`apps/server/src/db/migrations/`, `db/repositories/vectors-repository.ts`, `services/embedding-worker.ts`). Every claim below was verified empirically against the real trigger DDL and repository code with better-sqlite3 (not just read from the source), following the same discipline as the just-merged `optimize-db-read-path` change.

## Goals / Non-Goals

**Goals:**

- Close the dangling-FTS-posting leak on physical purge for both `memory` and `prompts`, and heal already-deployed databases.
- Stop `memory_au` from rewriting the FTS index on every read-touch, without weakening `prompts_au` (which the spec requires to stay unscoped).
- Make `memory_vec.status` provably fresh at insert time, closing a save/supersede race.
- Stop the embedding worker's 30s tick from scanning the whole `memory` table once the backlog is confirmed empty.

**Non-Goals:**

- Not touching `prompts_au`'s firing scope (spec-mandated unscoped).
- Not adding a `memory_replaces` edge table (issue #268 — separate, OpenSpec-gated).
- Not changing `memory.search`'s external contract — the status-filter guard is defensive, not a new capability.

## Decisions

### D1. Fix the delete-branch tags value, and narrow `memory_au` (only) — verified against the spec, not assumed

Read `openspec/specs/persistence/spec.md`'s `prompts_fts` requirement closely before deciding scope, because it explicitly names the mechanism:

> `prompts_au` (`AFTER UPDATE`): ... **This trigger is required because `deleted_at` and `replaces` flips are UPDATEs on the `prompts` row even though `content` itself never changes.**

That sentence rules out narrowing `prompts_au` — its whole purpose is to catch non-content columns changing. `memory` has no analogous "soft state lives on the row" pattern: lifecycle is `status` flips (never touches `content`/`tags`/`title`) plus `replaces` links (a separate column, also never re-indexed). So `memory_au` can safely narrow to `AFTER UPDATE OF content, tags, title` — verified this eliminates firing on a `last_seen_at`-only touch while still firing if those columns ever did change (hypothetical; no current code path does).

The delete-branch tags-value bug (`''` instead of the real flattened tags) is symmetric across all four triggers (`memory_ad`, `memory_au`'s delete half, `prompts_ad`, `prompts_au`'s delete half) and gets fixed in all four, regardless of the OF-scoping decision — it's a separate, independent bug.

**Verification — the "corruption on every touch" claim does NOT reproduce; the real bug is DELETE-only:**

```
5× UPDATE (last_seen_at touch) on a tagged row → integrity-check passes, 1 match. NOT corrupted.
DELETE the row → tag term still MATCHes (expected 0, got 1). Confirmed dangling posting.
INSERT a new unrelated row (SQLite reuses the freed rowid) → matches the OLD row's tag term. Confirmed phantom hit.
```

This matches (and refines) the finding from the prior `optimize-db-read-path` exploration, which had already refuted the broader "corrupts on every read" claim from an earlier scan.

**Verification — the fix removes both problems without regressing the "still re-indexes on a real change" guarantee, or breaking `prompts_au`'s spec-required behavior:**

```
Fixed memory_au (OF content,tags,title): last_seen_at touch → trigger does not fire, postings unchanged (still 1 match). PASS.
Fixed memory_ad: DELETE → 0 matches for the purged tag (was 1). PASS.
Fixed memory_ad + reinsert: rowid reuse → 0 matches for the old tag (no phantom). PASS.
Fixed memory_au: an actual tags UPDATE → old tag gone, new tag findable. Still correct. PASS.
Fixed prompts_ad: DELETE → 0 matches for the purged tag. PASS.
Fixed prompts_au (still unscoped): a deleted_at-only UPDATE → row remains discoverable (still 1 match). PASS — the spec-required includeDeleted:true behavior survives.
```

**Migration safety — DROP TRIGGER + CREATE TRIGGER inside a transaction, verified twice:**
First attempt produced a false "database disk image is malformed" / `SQLITE_CORRUPT_VTAB` — traced to a bug in the _verification probe_, not the trigger swap: the probe never created a `memory_ai` trigger, so the row being deleted had never been indexed in `memory_fts` in the first place, and issuing a `'delete'` command for a row that was never inserted is what SQLite rejected. Redone with the full trigger set present (matching production), the swap is clean: no table rebuild needed, no FK issues, the new trigger logic is active immediately, and `PRAGMA foreign_key_check` and `INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')` both pass.

**Healing already-deployed databases:** simulated a database that already has a dangling posting (insert+delete with the _old_ buggy trigger, then insert an unrelated row), then ran `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`. The dangling posting disappears, the current row's FTS entry is untouched, and `integrity-check` passes. The migration runs this rebuild (for both `memory_fts` and `prompts_fts`) unconditionally after swapping the triggers, so every upgrade path — clean or already-corrupted — ends in a consistent index.

### D2. `insertEmbedding` derives status/type from a live read, not caller-supplied params

Root cause: `embedNow`/`processBatch` capture `status`/`type` _before_ `await embedder.embed(...)`; if the row's status changes during that await (a concurrent `topic_key` supersede, or a consolidation archive), the insert that follows writes the _stale_ value. Fix: move the read inside the same `INSERT` statement —

```sql
INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
SELECT ?, ?, m.status, m.type, ?
FROM memory m WHERE m.id = ?
```

This closes the race atomically (better-sqlite3 is a single synchronous connection — no other statement can interleave inside one `db.run()` call). `type` is immutable per-memory (verified: no UPDATE-of-`type` code path exists anywhere), so deriving it changes nothing behaviorally; only `status` benefits from the freshness fix.

**Removing the now-dead parameters, not leaving them unused.** Once `insertEmbedding` derives status/type itself, passing them in is dead code. Traced the _complete_ call graph by exhaustive grep (no `embedNow`/`insertEmbedding` reference exists outside this list):

| #   | File                                         | What changes                                                                            |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `db/repositories/vectors-repository.ts`      | `insertEmbedding` signature + SQL body                                                  |
| 2   | `db/repositories/vectors-repository.test.ts` | call site drops `status`, `type` args                                                   |
| 3   | `services/embedding-worker.ts`               | `embedNow` signature; `processBatch`'s per-row `insertEmbedding` call                   |
| 4   | `services/embedding-worker.test.ts`          | `embedNow` call site drops `row.status`, `row.type`                                     |
| 5   | `mcp/memory-tools.ts`                        | `MemoryToolDeps.embedNow` type signature; call site drops `m.status`, `m.type`          |
| 6   | `mcp/server.ts`                              | `embedNow` type signature (passthrough at the wiring line needs no change — same shape) |
| 7   | `server/bootstrap.ts`                        | the `embedNow: (…) => embeddingWorker.embedNow(…)` lambda drops the two params          |

**Belt-and-suspenders in `MemoryService.search`.** Even with D2's fix, any _future_ code path with the same bug class (captures status, awaits, inserts) could leak a wrong-status id into the dense branch's result list. `unsafeGetByIds` hydration already fetches the row's live, authoritative status — the guard is a one-line filter dropping any hydrated row whose live status doesn't match the requested filter before returning. Zero cost in the common case (ids already match), a correctness backstop in the race case.

### D3. `possiblyPending` flag gates the embedding worker's poll — verified against every existing test

Traced: the _only_ inserter into `memory` is `MemoryService.saveWithTopicKey` (via `memory.save`), and the _only_ caller of `embedNow` is the MCP save handler, called inline right after that same transaction commits. So in steady state, `findMissingEmbeddings` is provably empty except: an `embedNow` inference failure (rare), the crash-recovery window (row inserted, process died before `embedNow` ran), or a hypothetical future insert path that forgets to call `embedNow`.

State machine:

```
        ┌────────────────────┐  embedNow's own catch{} fires
        │  possiblyPending    │◄────────────────────────────────┐
        │      = true         │                                  │
        │  (initial default)  │──── scan finds 0 pending ───────►│ possiblyPending = false
        └────────────────────┘                                   (skip DB query on next tick)
                 ▲                                                        │
                 │ hourly forced re-check (processBatch({force:true}))    │
                 └────────────────────────────────────────────────────────┘
```

`processBatch(opts?: {force?: boolean})` skips the `findMissingEmbeddings` query entirely when `!opts.force && !possiblyPending`. Traced call-by-call against all 5 existing `embedding-worker.test.ts` assertions: none call `processBatch` more than twice in a row without an intervening state change the flag already accounts for (a fresh worker instance always starts `possiblyPending=true`, so the first call always scans — matching the existing "first pass immediately to backfill" boot behavior). No existing test needed modification.

`bootstrap.ts` keeps the existing 30s timer (now cheap once drained) and adds a second, slow (hourly) timer calling `processBatch({force: true})` — a safety net so a future insert path that forgets to signal `possiblyPending` is still caught within an hour instead of never.

## Risks / Trade-offs

- **[A future `memory` insert path bypasses `embedNow` without updating `possiblyPending`]** → the hourly forced re-scan is the backstop; the backlog would be caught within an hour rather than staying invisible forever.
- **[The new `memory_fts` migration runs `'rebuild'` on every upgrade, even clean databases]** → `rebuild` cost scales with `memory` row count; it runs once, at migration time, not per-request. Acceptable one-time cost, and necessary to heal any pre-existing corruption unconditionally (a clean database rebuilds to the same state, so there's no correctness reason to special-case it).
- **[Removing `status`/`type` params from `embedNow`/`insertEmbedding` is a wider mechanical diff than the bug fix itself]** → justified: leaving dead parameters accepted-but-ignored is worse (confusing, invites a future caller to assume they're honored). The full blast radius was traced and is closed (7 call sites, no others).

## Migration Plan

1. `0020_fix_fts_delete_triggers.sql`: `DROP TRIGGER` + `CREATE TRIGGER` for `memory_ad`, `memory_au`, `prompts_ad`, `prompts_au`; then `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` and the `prompts_fts` equivalent.
2. `vectors-repository.ts`: rewrite `insertEmbedding`; update its 7 call-graph sites.
3. `services/memory.ts`: add the search hydration status guard.
4. `embedding-worker.ts` + `bootstrap.ts`: add `possiblyPending` + the hourly fallback timer.
5. Rollback: all four triggers can be dropped/recreated back to the prior DDL (reversible); the `insertEmbedding`/`embedNow` signature change and the polling flag are code-only (revert via git). No data migration, so rollback carries no data-loss risk.

## Open Questions

None outstanding — all three items were verified empirically before writing this design.
