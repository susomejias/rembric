## 1. Coordination and preconditions

- [x] 1.1 Confirm `openspec/changes/tune-hot-query-paths/tasks.md` task 4.5 is still unstarted (`- [ ]`). If it has landed, STOP and reconcile per `design.md` D4 before touching either predicate — a maintained counter built over `!= 'archived'` has to be redefined and recomputed, which is a different change.
- [x] 1.2 Re-verify the three predicates on disk before editing, so the premise is not taken on trust: `entities-repository.ts` `scopeActiveMemoryCount` (`~:242`) and `entityLinkCount` (`~:266`) use `sql\`${memory.status} != 'archived'\``, and `findOtherMemoriesForEntity` (`~:298`) uses `eq(memory.status, 'active')`. Record the actual line numbers found; the tree has moved since the proposal was written.
- [x] 1.3 Confirm `findMemoriesByEntity` (`~:164`) is NOT in scope and leave it on `!= 'archived'` (design.md Non-Goals). Note it explicitly in the commit body so the divergence reads as deliberate to the next reader of the file.

## 2. The fix

- [x] 2.1 `scopeActiveMemoryCount`: predicate → `eq(memory.status, 'active')`. Leave the name and docstring unchanged — the point is that they become true, so any reword would be evidence destroyed.
- [x] 2.2 `entityLinkCount`: predicate → `eq(memory.status, 'active')`. Same: docstring already says "active-memory link count".
- [x] 2.3 Confirm the diff is exactly two changed lines under `apps/server/src/`, and that `ENTITY_RARITY_THRESHOLD` is unchanged at `0.15` (design.md D3). `git diff --stat` must show one file.

## 3. Pin the population in tests (design.md D5)

- [x] 3.1 Replace the fixture in `entities-repository.test.ts::"count active links and the scope total, excluding archived rows"` (`~:226`) so it contains `active`, `superseded` AND `archived` rows, all three carrying the same entity value. The current fixture has no superseded row, which is why a test whose own title says "active" could not fail. Assert both counts exactly, and assert in the same test that the active-only and non-archived counts on this fixture are DIFFERENT numbers — a fixture where they coincide is a test that passes under either predicate.
- [x] 3.2 Add a repository test for the newly-BLOCKED direction (design.md D6, second row): an entity linked only to `active` rows in a scope that also holds `superseded` rows, where `Lₐ/A` exceeds `0.15` while `(Lₐ+Lₛ)/(A+S)` does not. Assert the two counts, and state the two ratios in the test name or a one-line comment so the arithmetic is legible without recomputation.
- [x] 3.3 Add a service-level test in `save-time-candidates.test.ts` for the newly-ADMITTED direction: one `active` memory plus a `topic_key` chain of `superseded` memories all carrying the same entity, sized so the non-archived ratio exceeds `0.15` and the active ratio is far below it. Assert the `active` row surfaces with `source: 'entity'` and the right `entityValue`. `ENTITY_RARITY_THRESHOLD` currently has zero covering tests, so this is the first assertion that the gate's decision — not just its inputs — is correct.
- [x] 3.4 Make 3.3's fixture hostile to scan order: `findOtherMemoriesForEntity` is `ORDER BY created_at DESC LIMIT n`, so give the single `active` target the OLDEST `created_at` among the rows carrying that entity and place the superseded chain newer. A fixture with the active row newest would surface it first under any predicate and prove nothing.
- [x] 3.5 Add a service-level test for the blocked direction end-to-end (the mirror of 3.3), so both halves of D6 are pinned at the layer where the decision is taken and a future cached-count or maintained-counter rework (D4) cannot pass by computing the wrong population cheaply.
- [x] 3.6 **Mutation check, both predicates, denominators reported.** Assert the passing count first, then revert each predicate to `!= 'archived'` in turn and record `N failed | M passed (T)` with the failure message. Both 3.2/3.5 (blocked direction) and 3.1/3.3 (admitted direction) must fail under the reverted predicate — if only one direction fails, the other test is not pinning what it claims. Restore and re-record the clean count.
- [x] 3.7 Do NOT add a grep invariant to `test/invariants.test.ts` (design.md D5, option 3 — it would pin SQL text that `tune-hot-query-paths` 4.5 plans to replace). The file must be untouched by this change; verify with `git diff --name-only`.

## 4. Measure the behavioural delta (both directions, every ratio with its denominator)

- [x] 4.1 **Record that the eval corpus is not an instrument, with the numbers that say why**, before measuring anything on it: 40 items, 2 entity links total, 2 distinct entities each linked to exactly 1 memory (the just-saved row, which is excluded), 0 superseded rows carrying any entity link. A prior pass measured "0 of 0" here and it was vacuous. Confirm these five figures still hold on the current corpus rather than copying them.
- [x] 4.2 Build the instrument corpus: the real `test/retrieval/corpus.ts` plus entity-bearing `topic_key` items forming at least two chains long enough that a chain entity's non-archived ratio exceeds `0.15` while its active ratio stays below it. Real embedder, real save path (`ingestCorpus`), same as the prior pass which moved entity-channel rows 5 → 3 with superseded 2 → 0. Report the corpus's `A`, `S`, archived count, total entity links, and distinct entities.
- [x] 4.3 Measure and report, before and after the fix, **each with its denominator**:
  - gate evaluations taken (the denominator for everything below), and of those: admitted / blocked
  - entities newly ADMITTED by the fix, out of previously-blocked
  - entities newly BLOCKED by the fix, out of previously-admitted
  - entity-channel candidate rows returned during ingest, out of total candidates surfaced
  - candidates surfaced per save by `source` (`vec` / `fts` / `entity`), out of `all.length` before the cap
    A bare ratio without its denominator is not an acceptable line in this table; two vacuous zeros were caught by that discipline on this code path already.
- [x] 4.4 Report the **displacement** figure explicitly (design.md D7): saves where the cap bound both before and after, and for those, the change in per-`source` composition at unchanged total. If the total candidate count per save does not move, that is the expected result and must be stated as such rather than read as "no effect".
- [x] 4.5 Report the smallest `A` (active count) at which a gate decision was taken on the instrument corpus. This is the input Open Question 2 needs, and it is free to collect here.
- [x] 4.6 State the net direction found. If newly-blocked dominates newly-admitted, say so plainly and record it in the change's report — that outcome makes D3's deferred recalibration required rather than optional, and does not invalidate the fix.

## 5. Spec

- [ ] 5.1 Land the `memory-entities` delta: the modified "Entity overlap MUST be a save-time conflict-detection channel" requirement, with the population stated on both sides of the proportion, the "would flood the per-save candidate budget" rationale corrected to slot composition, and the three added scenarios (active-population gating, long topic chain, archived counted on neither side).
- [x] 5.2 Confirm no `memory` delta is needed by re-reading `memory/spec.md:1119` and `:505` (design.md D8). If `:1119` no longer reads "a scope's active memories", that assumption is void and a `memory` delta becomes required.
- [x] 5.3 Grep `openspec/specs/` for `rarity`, `common entit`, `scope's active`, `scopeMemoryCount` and confirm no other requirement now contradicts the added clause. Contradictions on this capability appear between requirements, not within one.

## 6. Verification

- [x] 6.1 `pnpm run typecheck` — clean.
- [x] 6.2 `pnpm run lint` — clean.
- [x] 6.3 `pnpm test` — record `passed | skipped | failed` and file count against the baseline measured immediately before the change, and state the deterministic delta this change contributes (the tests added in section 3). A concurrent agent in this tree has previously made the raw total non-comparable; measure the baseline, do not assume it.
- [x] 6.4 `pnpm run eval` — the committed baseline MUST be **unmoved** (`hybrid P@8 / R@8 / MRR@8` identical). This path is not exercised by the `hybrid` retriever, which enters via `searchWithAbstention`, so a moved retrieval number means something unexpected happened and is a stop condition, not a new baseline.
- [x] 6.5 `pnpm run check:spec-provenance` — `ok`.
- [x] 6.6 `git diff --name-only` confirms nothing outside `apps/server/src/db/repositories/entities-repository{,.test}.ts`, `apps/server/src/services/save-time-candidates.test.ts`, `openspec/specs/memory-entities/spec.md` and this change folder. In particular `apps/plugin/` must be empty in that diff.

## 7. Docker smoke against pre-existing seeded data (standing requirement — production behaviour changes)

- [ ] 7.1 **Operator-supervised.** Do NOT run `dev:docker:up` against `data-dev`: it wipes and reseeds, and another agent's corpus may be resident. Run against a **copy** of a pre-existing seeded database on a spare port with the seed step skipped, exactly as the 2026-07-29 pass did. Confirm no `data-dev` mount before starting.
- [ ] 7.2 Record the pre-existing corpus shape before probing: `active` / `superseded` / `archived` counts, migrations already applied, and at least one entity whose links are concentrated on `superseded` rows (that is the entity the probe needs). If no such entity exists in the copy, create one through the real `memory.save` + `topic_key` path rather than by direct SQL.
- [ ] 7.3 **Upgrade check**: server boots on the pre-existing DB, migrations apply with no failure, `/healthz` 200, memory count unchanged. There is no migration in this change, so an unchanged migration count is the expected observation and confirms it.
- [ ] 7.4 **Non-vacuous both-directions probe** over `/mcp/<slug>`: save a memory naming the superseded-heavy entity and confirm the `active` target now surfaces with `source: 'entity'`; revert the two predicates live and confirm it disappears; restore and confirm it returns. A smoke that only observes the fixed state has not observed the defect.
- [ ] 7.5 Tear down: container removed, data copy deleted, `data-dev` never mounted. State it in the report.

## 8. Deferred and rejected — recorded so nothing is silently lost

- [ ] 8.1 **Deferred: recalibrate `ENTITY_RARITY_THRESHOLD`** (design.md D3). Open a follow-up change seeded with section 4's distribution, including 4.5's smallest-`A` figure and 4.6's net direction. Note in it that `0.15` never had a calibration, so the follow-up is the first one.
- [ ] 8.2 **Deferred: a small-scope floor** ("no gating below `N` active memories", Open Question 2). Belongs with 8.1 because it is the same calibration; the corrected population reaches the small-`A` regime sooner, so the follow-up must decide it rather than inherit it.
- [ ] 8.3 **Deferred, to `tune-hot-query-paths` 4.5**: `scopeActiveMemoryCount`'s per-save partition count. Carry design.md D4's constraint into that work — a maintained counter over `active` MUST decrement on `active → superseded`, not only on `active → archived`, or it drifts upward by one per `topic_key` re-save. The per-request cache option carries no such hazard.
- [x] 8.4 **Rejected, do not re-propose**: widening the candidate set to `!= 'archived'` instead of narrowing the counts (D2); a grep invariant pinning the predicates (D5); a `memory` spec delta (D8); an absolute link-count threshold; shipping the corrected gate disabled behind a `null`. Each has its reason recorded in `design.md`.
- [x] 8.5 **Left open, default recorded**: no short-circuit for an entity whose only active link is the just-saved row (Open Question 1) — the arithmetic already admits it and it costs one query that returns nothing.

## Apply notes (2026-07-29)

Numbers for §3.6 and §4 are in `measurements.md`.

- **4.2 substituted, deliberately.** Instead of extending the eval corpus, the delta was
  measured over the resident 2055-row dev database (1443 active / 601 superseded, 2441 entity
  links) — a larger and more realistic instrument. Its limitation is recorded: entity links
  are distributed uniformly across statuses, so it exercises the arithmetic at scale but not
  the topic-chain concentration. That case is pinned exactly by the two service tests.
- **5.1 lands at archive time** (published spec text may only arrive by archiving).
- **7.1–7.5 not run.** Operator-supervised, and `dev:docker:up` would wipe the `data-dev`
  corpus the operator asked to keep. §4 was taken from a copy of that database, so 7.2's
  corpus shape is covered; 7.4's live both-directions MCP probe is not.
- **8.1–8.3 not filed as follow-up changes.** The evidence each one needs is in
  `measurements.md` (distribution, smallest `A` = 1443, net direction), so nothing is lost,
  but no `openspec/changes/` folder was opened for them.
