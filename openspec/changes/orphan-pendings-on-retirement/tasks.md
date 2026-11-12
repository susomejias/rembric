## 1. Evidence before code

- [x] 1.1 Run `measurements/retirement-cost.mts` with `LABEL=before` on the base commit (`4fef7a77`) at 1 000, 20 000 and 50 000 memories, and commit its output as `measurements/retirement-cost-before.txt`
- [x] 1.2 Write `measurements/retired-verdicts.mts`, a read-only count of verdicts recorded on a pair after one of its endpoints retired, with a control that inserts one known case into a scratch copy and sees the count rise by exactly one; run it on the 50 000-memory synthetic corpus and commit its output (design D10)

## 2. Repository read

- [x] 2.1 Add `RelationsRepository.listPendingTouchingAny(memoryIds)` returning the pending rows whose source or target is one of the ids, in `(created_at, judgment_id)` order, with a co-located test proving both sides are returned, non-pending rows are excluded and an empty input reads nothing (design D2)
- [x] 2.2 Record the statement's `EXPLAIN QUERY PLAN` in `measurements/README.md`, showing `memory_relations_source_status_idx` and `memory_relations_target_status_idx`

## 3. Orphan at retirement (stored-data unit)

- [x] 3.1 Write `packages/core/src/consolidation/retirement.test.ts` and observe it RED: one test per retirement path of design D5 (the pending row is `orphaned` and journaled in the expected run, with one timestamp), one rollback test per path (a failing `orphan_promote` insert leaves the memory's status, the relation and the journal untouched), the other-endpoint-retired case, the no-run case and the four distinct reasoning prefixes
- [x] 3.2 Implement `orphanPendingOnRetirement` and `RETIREMENT_ORPHAN_REASON` in `operations.ts` and call the helper from every path of design D5, so `pnpm vitest run packages/core/src/consolidation/retirement.test.ts` is GREEN
- [x] 3.3 Update the `memory.merge` warning `pending_judgments` and the `memory.merge` tool description (design D8)
- [x] 3.4 Adapt the existing tests whose setups retired an endpoint through a service and expected the pair to stay pending, so they build a row that predates this change through a repository-level flip, and list them in the commit message

## 4. Undo symmetry (stored-data unit)

- [x] 4.1 Add the undo tests to `retirement.test.ts` and observe them RED: undoing an archive, a decay and a merge restores the orphaned judgments; a later verdict is kept; a judgment whose other endpoint is still retired stays orphaned and is reported; a run undo with a taken topic slot leaves the judgment orphaned; a run undo reverts every op exactly once; a `topic_key` revision's orphaning is undone on its own (design D6)
- [x] 4.2 Implement the linked restoration in `undoOp`, extract the `orphan_promote` undo branch, make `undoRun` leave linked ops to their retirement, and add `alsoReverted` and `keptOrphaned` to `UndoResult` (and `keptOrphaned` to `UndoRunResult`), so the undo tests are GREEN, the existing `operations.test.ts` and `orphan-promotion.test.ts` pass unedited, and the one dashboard test that pins the whole `UndoResult` gains the two empty fields
- [x] 4.3 Add the kept-orphaned note to `apps/web/src/app/dashboard/consolidation/undo-messages.ts` with a test in `apps/web/src/test/dashboard/consolidation.test.tsx`, beside the kept-verdict note's

## 5. Enforcement

- [x] 5.1 Add the retirement-path scan to `apps/web/src/test/invariants.test.ts`: the inventory of flip methods, the call-site scan with the TypeScript compiler API, the six-call-site anchor and the two controls (design D7)

## 6. Docs

- [x] 6.1 Update `docs/relations.md`, `docs/troubleshooting.md` and the consolidation section and invariants list of `README.md` where they describe the pending lifecycle

## 7. Evidence after code

- [x] 7.1 Run a mutation check for each path's helper call and for the undo restoration, and record it in `measurements/mutation.txt`; every mutation must turn a named test red
- [x] 7.2 Run `measurements/retirement-cost.mts` with `LABEL=after` on the same corpora, commit `measurements/retirement-cost-after.txt`, and state the added cost per path in `measurements/README.md`
- [x] 7.3 Write and run `measurements/drain-after-retirement.mts`: after retirements made through every path, the drain's retired-endpoint branch drains 0 pairs, while a control that retires the same memories by repository-level flips drains them

## 8. Verification

- [x] 8.1 Run `pnpm run typecheck`, `pnpm run lint` and the touched tests for every commit
- [x] 8.2 Run `pnpm --filter @rembric/web build`, then the full `pnpm test`
- [x] 8.3 Run `openspec validate orphan-pendings-on-retirement --strict`, `pnpm run check:delta-freshness` and `pnpm run check:spec-crossrefs`
- [ ] 8.4 **OPERATOR-ONLY:** run `measurements/retired-verdicts.mts` against a backup copy of the production database (never the live file) and record the aggregate counts in `measurements/README.md` (design Open Question 1)

## 9. Archive-time coordination

- [ ] 9.1 **ARCHIVE-TIME:** archive this change after `add-save-time-lexical-floor` and `drain-stale-save-time-pendings`
- [ ] 9.2 **ARCHIVE-TIME:** archive `add-memory-merge` before this change (design D11)
- [ ] 9.3 **ARCHIVE-TIME:** once `add-memory-merge` is published, add to this change a MODIFIED delta of "The MCP server MUST expose `memory.merge` with a preview-then-confirm contract" that replaces "Pending judgments touching an original are left as they are", then re-run task 8.3
