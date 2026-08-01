## 1. Failing tests first

Every test here MUST be observed failing before the guard lands. Add to `apps/server/src/services/relations.test.ts`. The corruption is reproduced by: two saves on one `topic_key` (so V1 becomes `superseded`), an unrelated `active` memory L, a `pending` relation V1 → L, then the verdict.

- [x] 1.1 Failing test — `judge({relation:'supersedes'})` on a pending row whose SOURCE is `superseded`: expect `conflict`, L still `active`, source's `replaces` unchanged, relation still `pending` (spec scenario "Judging supersedes from a retired source"). Record the observed pre-fix target status in the commit body.
- [x] 1.2 Failing test — same verdict where the TARGET is `archived` and the source is `active` (spec scenario "Judging supersedes against a retired target"). This half is currently unread by the code at all, so it needs its own case rather than riding on 1.1.
- [x] 1.3 Failing test — `compare({relation:'supersedes'})` on a fresh pair (no existing row) with a retired source, hitting the insert path at `relations.ts:385`.
- [x] 1.4 Failing test — `compare({relation:'supersedes'})` where a judged row for that pair ALREADY exists, hitting the update-in-place path at `:357`. Distinct from 1.3: one guard must cover both, and asserting that is the point.
- [x] 1.5 Controls that MUST pass before and after: `judge({relation:'not_conflict'})` on a retired-source pair succeeds and transitions to `judged` (spec scenario "Other verdicts stay closable on a retired pair"); `judge({relation:'supersedes'})` with both endpoints `active` still performs the full side effect (target `superseded`, source's `replaces` extended). A control that fails means the harness is wrong, not the code.
- [x] 1.6 Control — `compare({relation:'related'})` on a retired pair still persists its row, so the change is not over-reaching into non-lifecycle verdicts.

## 2. The guard

- [x] 2.1 Extend `findScopeTupleById` (`apps/server/src/db/repositories/memory-repository.ts` ~:407) to project `status` alongside `scope`, `projectId`, `replaces`. Check its other callers first (`grep -rn "findScopeTupleById" apps/server/src`) and confirm a widened projection breaks none.
- [x] 2.2 In `applySupersedesSideEffect` (`apps/server/src/services/relations.ts` ~:552) fetch the target's lifecycle too, and throw `DomainError('conflict', …)` unless BOTH endpoints are `active`. The message MUST name which endpoint and its actual status — the agent needs to know whether to pick a different relation (design D1, D2).
- [x] 2.3 Throw before either write, so the surrounding transaction rolls back and the relation row stays `pending` (design D4). Verify by asserting relation status in 1.1.
- [x] 2.4 Confirm all three call sites are covered by the single guard without touching them: `grep -n "applySupersedesSideEffect" apps/server/src/services/relations.ts` must still show one definition and three calls.
- [x] 2.5 Confirm every test in group 1 is green and every control in 1.5/1.6 is still green.
- [x] 2.6 Mutation-check the guard: weaken it to test only the source, and confirm 1.2 reddens; weaken it to test only the target, and confirm 1.1 reddens. Restore and verify the file is byte-identical.

## 2b. Discovered mid-implementation: the audit relation belongs in the save's transaction

The guard reddened a pre-existing test (`memory.save with topic_key auto-supersedes the prior active row`). Root cause: `memory/spec.md` requires the insert, the supersede and the `agent_topic_key` relation row in ONE transaction, and the relation was being written afterwards by the MCP layer through `compare`. See design D5. A first attempt added a `recordAppliedSupersede` verb; it was discarded for the deeper fix.

- [x] 2b.1 Widen `MemoryService`'s repos `Pick` with `'relations'`; confirm no construction site breaks (all pass a full `createRepositories(...)`).
- [x] 2b.2 Write the `agent_topic_key` row inside `saveWithTopicKey`'s transaction, after the insert so the FK on `source_id` is satisfied. Actor comes from `input.source?.tokenName`, which `memory.save` and `capture_passive` already populate.
- [x] 2b.3 Delete the MCP follow-up `compare` call, its `catch {}`, and the now-unused `tokenName` parameter of `saveMemoryWithCandidates`; update its two other call sites.
- [x] 2b.4 Correct `saveWithTopicKey`'s docstring, which claimed the MCP layer wrote the relation "in the same transaction" — false before this change.
- [x] 2b.5 Tests: the audit row exists with the right source/target/kind/actor; a three-deep chain writes exactly two rows and never trips the guard; an archived-then-resaved topic writes none.

## 2c. Keep `compare` idempotent (design D6)

- [x] 2c.1 Exempt the already-applied case from the guard (`target` is `superseded` AND source's `replaces` names it), so an identical `compare(supersedes)` retry succeeds — `memory.compare` ships `idempotentHint: true` and `mcp-api` classifies it last-call-wins.
- [x] 2c.2 Assert the exemption cannot readmit the defect: with the target still `active`, a retired source is refused as before.

## 2d. Volumetric harness follows the corpus change

- [x] 2d.1 Update the declared relation total to `generated + memories * supersededFraction`, and assert the audit rows are all `marked_by_kind = 'agent_topic_key'` — the seeder itself still judges no `supersedes`.
- [x] 2d.2 Assert the status fractions against the generated population, not the total, since the audit rows are all `judged`.
- [x] 2d.3 Stop the determinism digest ordering by `id`: relations now tie on `created_at`, and an `id` tiebreak let a minted ULID decide the order — the write-path randomness the digest documents itself as excluding. Order by the digested tuple instead.
- [x] 2d.4 Correct the stale comment at `seed-volumetric.ts` claiming `supersedes` is absent to keep the axes independent.

## 3. Verification

- [x] 3.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 3.2 `pnpm test` fully green, with no test skipped or weakened to accommodate the guard. If an existing test goes red, that is a finding to report — it would mean some fixture depends on superseding from a retired row, which is worth knowing before proceeding.
- [x] 3.3 Confirm `apps/server/src/test/invariants.test.ts` is unaffected (no SQL moved out of `db/`, no `admin*` / `unsafe*` call added).
- [x] 3.4 Confirm the append-only invariant tests still pass and that the consolidation sweep is untouched: `pnpm vitest run src/consolidation` green.
- [x] 3.5 Re-run the original #301 reproduction and record in the commit body that the live target now stays `active`.

## 4. Close-out

- [x] 4.1 `/simplify` over the diff, then `/code-review`; resolve findings before archiving.
- [x] 4.2 Archive via the `sdd-archiver` agent; verify the `mcp-api` delta merged additively into `openspec/specs/mcp-api/spec.md` and that neither the `memory.judge` requirement (~:888) nor the tool-classification requirement (~:1376) was overwritten.
- [x] 4.3 `pnpm run check:spec-provenance` clean.
- [ ] 4.4 Commit and push. No embargo on this one — unlike the preceding change, nothing here describes an unreleased security fix.
- [ ] 4.5 Comment on issue #301 with what shipped, and note in #298 that its severity drops now that the wrong answer to a stale prompt can no longer corrupt state.

## 5. Carried over from the preceding change

- [ ] 5.1 Add the characterization test for the #302 defect measured but left untested: `/mcp/<unresolvable-slug>` with a `*` token reads global memories. Assert the CURRENT behaviour with a name and comment stating it documents a known defect and SHOULD fail once #302 is fixed, so the fix cannot land silently. Note in #302 that the test exists and must be inverted there. Keep it in its own commit — it is not part of this change's scope.
