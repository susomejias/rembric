# add-batch-judgment-and-candidate-suppression

## Why

The synchronous-judgment loop is asymmetric: a single `memory.save` fans OUT
many candidates at once (`findSaveTimeCandidates` returns up to
`CANDIDATES_PER_SAVE_MAX = 5`, each inserted as a pending `memory_relations`
row in `apps/server/src/mcp/memory-tools.ts:514-530`), but the agent can only
close them one judgment per `memory.judge` round-trip (`judgeSchema` takes a
single `judgmentId`, `apps/server/src/mcp/relations-tools.ts:40-46`). The same
fan-out/fan-in mismatch hits review: `memory.context.needsReview` hands back up
to 3 ids the agent should re-affirm (`NEEDS_REVIEW_MAX = 3`,
`apps/server/src/mcp/memory-tools.ts:704`), but `memory.confirm` takes one `id`
(`memoryConfirmSchema`, `apps/server/src/mcp/memory-tools.ts:92-94`). N
round-trips per save is friction agents skip, so pending relations age into
`pendingJudgments[]` and orphan. Worse, the detector never consults prior
verdicts: `findSaveTimeCandidates` excludes only `saved.replaces`
(`apps/server/src/services/save-time-candidates.ts:65,88`), so every re-save of
an evolving topic re-surfaces the identical pair the agent ALREADY dismissed as
`not_conflict` — the single most repetitive friction in the loop. Closing all
three asymmetries makes judging cheap enough that agents actually do it.

## What Changes

- **`memory.judge` gains a batch form.** The schema SHALL accept EITHER the
  existing single `{ judgmentId, relation, reason?, confidence?, evidence? }`
  OR a new `judgments: Array<{ judgmentId, relation, reason?, confidence?,
evidence? }>`. Each item runs in its OWN `RelationsService.judge`
  transaction (which already opens one per call,
  `apps/server/src/services/relations.ts:122`); there is NO outer transaction,
  so one bad `judgmentId` does NOT sink the batch. The response reports
  per-item `{ ok: true, ... }` or `{ ok: false, judgmentId, code, message }`.
  The single-form response shape is unchanged (backward-compatible).
- **`memory.confirm` gains a batch form.** The schema SHALL accept EITHER the
  existing single `{ id }` OR a new `ids: string[]`. The handler loops the
  existing append-only `MemoryService.confirm` over the ids inside ONE
  `db.transaction()` (the service already owns `this.tx`,
  `apps/server/src/services/memory.ts:160,395`), so re-affirming the three
  `needsReview` ids is one round-trip. The single-id response is unchanged.
- **Save-time candidate detection suppresses already-dismissed pairs.**
  `findSaveTimeCandidates` SHALL additionally exclude every target id already
  judged `not_conflict` against the new memory's `replaces` ancestry (NOT the
  always-fresh new id — `memory_relations` has no topic column, so dedup walks
  the `replaces` chain). The exclusion piggybacks on the `excludeIds`
  parameter both candidate queries already accept (`searchBm25Candidates`,
  `apps/server/src/db/repositories/memory-repository.ts:137,149`;
  `knnByCosine`, `apps/server/src/db/repositories/vectors-repository.ts:19,65`).
- No new MCP tool is registered; no plugin manifest changes; no DB migration.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mcp-api`: `memory.judge` and `memory.confirm` accept a backward-compatible batch form.
- `memory`: save-time candidate detection excludes pairs already dismissed as `not_conflict` along the new memory's `replaces` ancestry.

## Impact

- `apps/server/src/mcp/relations-tools.ts` — `judgeSchema` gains the array
  variant; `handleJudge` branches single vs batch and reports per-item results.
- `apps/server/src/mcp/relations-tools.ts` — `judgeOutput` gains the batch
  result shape (`results: Array<{...}>`).
- `apps/server/src/mcp/memory-tools.ts` — `memoryConfirmSchema` gains `ids?`;
  `handleConfirm` branches single vs batch; `memoryConfirmOutput` gains the
  batch counts shape.
- `apps/server/src/services/memory.ts` — new `confirmMany(ids, scope, source?)`
  wrapping the existing `confirm` in one `this.tx.transaction`.
- `apps/server/src/services/save-time-candidates.ts` — `findSaveTimeCandidates`
  computes the dismissed-`not_conflict` exclusion set and merges it into the
  `excludeIds` passed to both candidate queries.
- `apps/server/src/db/repositories/relations-repository.ts` — new read
  returning target ids judged `not_conflict` for a given set of source ids
  (the `replaces` ancestry).
- `apps/server/src/db/repositories/relations-repository.test.ts`,
  `apps/server/src/services/save-time-candidates.test.ts`,
  `apps/server/src/mcp/relations-tools.test.ts`,
  `apps/server/src/mcp/memory-tools.test.ts` — coverage for the three behaviours.
- `apps/server/src/mcp/server.ts` — `memory.judge` / `memory.confirm` tool
  descriptions updated to advertise the batch form.
- `openspec/specs/mcp-api/spec.md`, `openspec/specs/memory/spec.md` — synced at archive.
