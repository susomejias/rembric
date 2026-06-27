# Tasks — add-batch-judgment-and-candidate-suppression

## 1. Suppress dismissed `not_conflict` at save time

- [ ] 1.1 Add a repository read `listNotConflictTargetsForSources(sourceIds: string[]): string[]` to `apps/server/src/db/repositories/relations-repository.ts` returning distinct `target_id`s where `status='judged'`, `relation='not_conflict'`, and `source_id IN sourceIds`; return `[]` for an empty input.
- [ ] 1.2 In `apps/server/src/services/save-time-candidates.ts`, widen `findSaveTimeCandidates` to accept the `relations` repository, resolve the dismissed set from `saved.replaces` (the new memory's ancestry) via the new read, and merge those ids into the `excludeIds` passed to BOTH `knnByCosine` and `searchBm25Candidates`.
- [ ] 1.3 Thread the `relations` repository into the `findSaveTimeCandidates` call site in `apps/server/src/mcp/memory-tools.ts` (handleSave, ~line 514) without changing the candidates response shape.
- [ ] 1.4 Add coverage in `apps/server/src/services/save-time-candidates.test.ts`: a re-save whose `replaces` ancestor previously judged target X as `not_conflict` SHALL NOT surface X; a pair judged `conflicts_with` SHALL still surface — so that `pnpm vitest run apps/server/src/services/save-time-candidates.test.ts` passes.
- [ ] 1.5 Add a repository test in `apps/server/src/db/repositories/relations-repository.test.ts` for `listNotConflictTargetsForSources` (returns only `not_conflict` judged targets, dedupes, empty-input → []) so that `pnpm vitest run apps/server/src/db/repositories/relations-repository.test.ts` passes.

## 2. Batch `memory.confirm`

- [ ] 2.1 Add `confirmMany(ids: string[], scope: Scope, source?: MemorySource): { confirmed: number }` to `apps/server/src/services/memory.ts` that de-duplicates `ids` and loops the existing `confirm` inside ONE `this.tx.transaction`.
- [ ] 2.2 Extend `memoryConfirmSchema` in `apps/server/src/mcp/memory-tools.ts` to accept EITHER `{ id }` OR `{ ids: string[] }` (single `id` remains optional+valid for backward compat); extend `memoryConfirmOutput` with the batch result fields.
- [ ] 2.3 Branch `handleConfirm` (`apps/server/src/mcp/memory-tools.ts` ~line 677): single `id` keeps `{ ok: true }`; `ids` returns `{ ok: true, confirmed }`. Authorization runs once over the resolved scope before any write.
- [ ] 2.4 Update the `memory.confirm` tool description in `apps/server/src/mcp/server.ts` to advertise the batch form and the `memory.context.needsReview` use case.
- [ ] 2.5 Add coverage in `apps/server/src/mcp/memory-tools.test.ts`: confirming the three `needsReview` ids in one call inserts one confirmation each against each head; a duplicated id records exactly one; a single-id call is unchanged — so that `pnpm vitest run apps/server/src/mcp/memory-tools.test.ts` passes.

## 3. Batch `memory.judge`

- [ ] 3.1 Extend `judgeSchema` in `apps/server/src/mcp/relations-tools.ts` to accept EITHER the existing single `{ judgmentId, relation, reason?, confidence?, evidence? }` OR `{ judgments: Array<{ judgmentId, relation, reason?, confidence?, evidence? }> }` (cap the array at 25 items, reject empty arrays with `invalid_input`).
- [ ] 3.2 Extend `judgeOutput` with the batch shape `{ ok: true, results: Array<{ ok, judgmentId, relation?, status?, judgedAt?, code?, message? }> }`; keep the single-form output unchanged.
- [ ] 3.3 Branch `handleJudge` (`apps/server/src/mcp/relations-tools.ts` ~line 104): single arg keeps existing behaviour; the array form loops `deps.relations.judge` per item with NO outer transaction, catching each item's `DomainError` into `{ ok: false, judgmentId, code, message }` and continuing.
- [ ] 3.4 Update the `memory.judge` tool description in `apps/server/src/mcp/server.ts` to advertise the batch form for closing all of `memory.save.candidates[]` at once.
- [ ] 3.5 Add coverage in `apps/server/src/mcp/relations-tools.test.ts`: a batch of three judgments where the middle id is bogus records ok/error/ok per item and does NOT roll back the good ones; a `supersedes` item in the batch still mutates its target — so that `pnpm vitest run apps/server/src/mcp/relations-tools.test.ts` passes.

## 4. Validation

- [ ] 4.1 Run `pnpm run typecheck` and `pnpm run lint` clean (no new `any` without a justifying comment).
- [ ] 4.2 Run the invariants suite `pnpm vitest run apps/server/src/test/invariants.test.ts` to confirm append-only + data-access confinement still hold (the new SQL lives in `relations-repository.ts`).
- [ ] 4.3 (operator-only) Smoke against `pnpm run dev:docker:up`: save → batch-judge all candidates in one call; re-save the same topic and confirm the dismissed pair does NOT re-surface; `memory.context` → batch-confirm the `needsReview` ids in one call.
- [ ] 4.4 Run `openspec validate --strict add-batch-judgment-and-candidate-suppression` and confirm it exits 0.
