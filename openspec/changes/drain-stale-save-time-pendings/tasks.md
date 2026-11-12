## 1. Evidence before implementation

The prototype measurements already in `measurements/` (`drain-prototype.mts` and the scripts beside it) are the starting point for this group. Extend them; never overwrite their recorded outputs.

- [x] 1.1 False-drain measurement on the labelled save-time fixture with the compiled-in embedding model (the production arm). It already exists as `measurements/fixture-drain.mts` → `fixture-drain.txt`:
  - **Backlog:** save the base corpus, then each labelled save, through `runPostSaveSteps` with `lexicalFloor: 0`, which reproduces the old rank-only rule.
  - **Rule:** run the prototype rule, with fresh extraction of both endpoints, and write nothing.
  - **Report:** drained counts per class (near-duplicate, expanded rewrite, contradiction, unrelated), with the instrument named in the header.

  Re-run it on the current rule version and confirm the output.

- [x] 1.2 Gate: every genuine class (near-duplicate, expanded rewrite, contradiction) drains 0. **Stop and report** any other result as a **Needs your decision** result. Never tune the rule to pass.
- [ ] 1.3 **OPERATOR-ONLY.** On a BACKUP COPY of the production database, never the live file, report the share of pending pairs whose endpoints both have stored vectors and entity-scan records. Record aggregate percentages only, in `measurements/backup-shares.md`, with no content, titles, project names or identifiers.
- [x] 1.4 Record the parent's backup-copy figures from design D11 in `measurements/README.md`, aggregate only, labelled as prototype figures measured on a backup copy.
- [x] 1.5 Worst-case content-size measurement. It exists as `measurements/bounds.mts` → `bounds.txt`, which times one pair's evaluation for body sizes up to 1 000 000 characters.
  - Choose `DRAIN_MAX_PAIR_CHARS` as the largest measured size at which the worst shape stays within 5 ms (one tenth of the 50 ms per-call budget target), capped at the extractor's 200 000-character input bound.
  - Record the choice and the row it rests on in `measurements/README.md`.
- [x] 1.6 Commit: `test(core): record the drain rule's false drains and per-pair cost before implementing it`.

## 2. Shared per-pair predicate (behaviour-preserving refactor)

- [x] 2.1 Before editing, run `pnpm run eval:save-time` and keep its output in a `mktemp -d` scratch directory as the baseline.
- [x] 2.2 In `packages/core/src/services/save-time-candidates.ts`, extract the following into exported functions, and make `findSaveTimeCandidates` call them (design D1):
  - the lexical measure;
  - the vector distance-to-similarity mapping;
  - the lexical and vector threshold comparisons.

  Keep the rarity gate inside detection.

- [x] 2.3 Done when:
  - `pnpm vitest run packages/core/src/services/save-time-candidates.test.ts` passes with no test edited;
  - `pnpm run eval:save-time` output is byte-identical to the 2.1 baseline;
  - `pnpm run typecheck` is green.
- [x] 2.4 Commit: `refactor(core): extract the save-time per-pair admission predicate`.

## 3. Scoped repository reads

- [x] 3.1 Add the reads under `packages/db/src/repositories/`:
  - **Examinable selection:** pending rows with both endpoints in the project (`endpointsInScope`), ordered by `(created_at, judgment_id)` after a composite cursor (design D7), with a limit and the undone judgment ids excluded inside the query. Endpoint lifecycle is not filtered, so retired endpoints are drained.
  - **Bounded endpoints:** a pair's two rows in the project, returning each one's status and `length(title) + length(content)`, with the title and content only when that length is within the bound (design D3).
  - **`pairCosineDistance(projectId, sourceId, targetId)`:** a public point read that applies `vec_distance_cosine` to the two stored rows in SQL, and returns `null` when either is missing.
  - **Latest summary:** the latest finished run summary for a scope string.
  - **Reverted drains:** the `created_id` of every reverted `orphan_promote` op, read once per sweep call and passed to the selection (design D7).
- [x] 3.2 Test each read against a two-project fixture, proving it never returns another project's rows. Done when `pnpm test` is green, including the data-access confinement scan in `apps/web/src/test/invariants.test.ts`.

## 4. Pair evaluator with three-valued verdicts

- [x] 4.1 RED first. Add tests in `packages/core/src/services/save-time-candidates.test.ts` for `evaluatePair`, and observe them fail before 4.2:
  - an admitted lexical pair, an admitted vector pair, and an entity pair that shares an entity the rarity gate would block, each returning `admitted` on its channel;
  - a pair whose target ranks beyond `CANDIDATE_POOL_SIZE` but clears the floor, returning lexical `admitted`;
  - a missing embedding on either endpoint, returning vector `unknown`;
  - `vectorIndexCurrent` returning false, returning vector `unknown`, even when the stored vectors fall below the threshold;
  - a target with a scan record but no links, whose text holds an identifier the source shares, returning entity `admitted` through fresh extraction;
  - an extraction that throws for either endpoint, returning entity `unknown`;
  - an endpoint longer than `DRAIN_MAX_PAIR_CHARS`, returning `unknown` without its content being loaded;
  - an unreadable row, or a read that throws, returning `unknown`.
- [x] 4.2 Implement `evaluatePair` per design D1–D3 and D5. It calls only the 2.2 functions, the 3.1 reads, the stored links and `extractEntities` on both endpoints, in the D3 order.
- [x] 4.3 Add the agreement test: over the save-time fixture, every candidate `findSaveTimeCandidates` returns at an unbounded `perSaveMax` is `admitted` by `evaluatePair` on some channel.

## 5. The drain step

- [x] 5.1 RED first. Add `packages/core/src/consolidation/drain.test.ts` with one test per spec scenario, and observe each fail before 5.3.
  - **Drain and keep:**
    - a pair no channel admits is drained and journaled, with the rules-drain reasoning prefix, and its `judged_at` equals its op's `applied_at`;
    - a genuine pair is NOT drained, one test per channel: a lexical pair, a vector pair, and an entity pair that the rarity gate would block;
    - a pair beyond today's pool and cap is kept;
    - age does not decide a drain.
  - **Writes:**
    - the memory rows and the non-pending relation rows hash identically before and after a run that drained;
    - a forced journal-insert failure leaves the relation `pending` with no op (atomicity);
    - a failed write on the third pair leaves the first two `orphaned` with their ops, the third `pending` with no op, and the run continuing with the fourth (no transaction spans several pairs).
  - **Fail-safe:**
    - a missing embedding keeps the pair;
    - a stale vector index (`vectorIndexCurrent` false) keeps the pair;
    - an extraction failure keeps the pair;
    - an oversized pair keeps the pair;
    - a re-check that throws keeps the pair, and the rest of the run continues.
  - **Retired endpoints:**
    - a superseded source and an archived target are drained with the retired-endpoint reasoning, journaled, restored by undo, and not drained again after that undo;
    - an endpoint row that cannot be read keeps the pair.
  - **Scope:**
    - a project-B near-duplicate does not keep a project-A pair;
    - in one forced `runAll` over A then B, with an injected clock that exhausts the shared budget during A, B still examines at least one pair and drains its relation.
  - **Bounds and cursor:**
    - kept rows at the head do not starve later rows, and the cursor wraps;
    - an injected clock that starts at the drain step ends a run after two pairs, and the next run resumes at the third;
    - a clock already past the budget still examines exactly one pair;
    - decay and deadline time does not consume the drain's budget;
    - a 5 000-row drainable backlog: one run examines at most `DRAIN_ROW_CAP` and leaves the rest `pending`, and successive runs resume from the cursor until all 5 000 are examined.
  - **Undo and the deadline:**
    - an undone drain is never drained again by the drain;
    - an undone drain that crosses the deadline is orphaned by the deadline step, with its reasoning.
  - **Summary and journal:**
    - a back-to-back run with no writes, where everything fits in one run's bounds, drains nothing;
    - deadline, rules-drain and retired-endpoint ops carry three different reasoning prefixes;
    - the summary keeps top-level `archives` and `orphaned` and nests the cursor and the counts, including `drainedRetired`, under `drain`;
    - `memory.doctor` `consolidation.lastRunOps` holds exactly `archives` and `orphaned` after a run that drained.
  - **No inference:**
    - the drain runs with the embedding model not loaded: no `loadEmbedder` call (spied, or mocked to throw), the pair with stored vectors is decided from them, and the pair without one stays `pending`;
    - after the vector index is wiped, as `ensureVectorModel` does on a model-identity change, every active-endpoint pair that the lexical and entity checks do not admit stays `pending` and is counted as kept unknown.
- [x] 5.2 Add the structural pins for design D10, with a control for each:
  - a type test (`expectTypeOf`) fixing the exact key set of `ConsolidationRunnerOptions`: today's eight keys plus `vectorIndexCurrent` and `drainClock`. Adding an embedder dependency must fail the build.
  - a scan of the drain's transitive relative imports, from `runner.ts` and `save-time-candidates.ts`, asserting that none reaches `embeddings/`. Its control proves the same scan detects the import in `packages/core/src/services/embedding-worker.ts`.
- [x] 5.3 Implement the step in `packages/core/src/consolidation/runner.ts` as step 3 of `runScope`, per design D3, D4, D6, D7, D9 and D10:
  - **Writes:**
    - each pair's orphan and journal op are written in their own transaction;
    - one timestamp is passed to `RelationsService.orphan` and `recordOrphanPromote` through their new optional parameters;
    - no transaction spans several pairs, the run or the backlog.
  - **Bounds:**
    - `DRAIN_ROW_CAP` applies per scope;
    - `DRAIN_BUDGET_MS` is shared by all drain steps of one sweep call, starting at the first drain step;
    - every drain step examines at least one pair;
    - `DRAIN_MAX_PAIR_CHARS` takes its value from 1.5.
  - **Vectors:**
    - the step reads stored vectors only;
    - `vectorIndexCurrent` is called once per drain step;
    - the runner gains no embedder dependency.
  - **Summary:**
    - the cursor and the counts go into the nested `drain` object written by `finishRun`;
    - a failure of the step is logged and the run still finishes.

  Wire `vectorIndexCurrent: () => vectorIdentityMatches(dataDir)` in `apps/web/src/lib/services.ts`. Do not change the deadline step.

- [x] 5.4 Re-run the fixture and corpus validations through the shipped step (`measurements/validate-shipped.mts`, which drives `ConsolidationRunner.runScope` and reads its reasons from `evaluatePair`) and confirm the per-class counts equal the 1.2 output.
- [x] 5.5 Done when `drain.test.ts`, `orphan-promotion.test.ts`, `runner.test.ts` and `operations.test.ts` pass. Commit: `feat(core): drain stale save-time pending judgments in the consolidation sweep`.

## 6. Undo guard and dashboard

- [x] 6.1 RED first. In `packages/core/src/consolidation/operations.test.ts`, add three tests:
  - undo restores a drained relation to `pending`, with the cleared fields the spec names;
  - a drained relation between two active memories, later judged `supersedes` through `RelationsService.compare` on the same source and target:
    - after undo, it stays `judged` `supersedes`;
    - the target stays `superseded`;
    - the source's `replaces` still holds the target;
    - the relation is reported as not restored, and the op is marked reverted.
  - an `orphan_promote` op whose relation has a null `judged_at` leaves it untouched, reports it, and marks the op reverted.
- [x] 6.2 Implement the guard in the `orphan_promote` undo branch: reset only when `judged_at` is non-null and `judged_at <= applied_at`. Add the new `UndoResult` field (design D8). The existing fixture "orphan_promote undo skips a target whose topic slot is occupied but still resets the relation" passes unedited.
- [x] 6.3 Dashboard, per the `dashboard` delta:
  - the run-detail summary shows "· N drained", where N is `drainedRules + drainedRetired`, when the nested `drain` object is present;
  - both consolidation pages show a partial-undo message for kept verdicts.

  Use the existing `ConfirmSubmit` flow, with no new control. Add one test per new `dashboard` scenario. Commit: `fix(core): keep a later verdict when undoing an orphaning`.

## 7. Mutation check

- [x] 7.1 Weaken each piece separately with `node scripts/mutate.mjs` and confirm the tests naming it turn red.
  - **Rule:**
    - drain on lexical alone, ignoring the vector and entity verdicts;
    - apply the rarity gate to the entity check;
    - drop the fresh extraction of the target, so the scan-without-links test goes red.
  - **Fail-safe:**
    - treat `unknown` as `not_admitted`;
    - ignore `vectorIndexCurrent`;
    - remove the size bound.
  - **Endpoints and scope:**
    - treat a retired endpoint as admitted (keep it);
    - treat an unreadable endpoint row as drainable;
    - drop the project filter.
  - **Writes:**
    - remove the transaction around orphan and journal;
    - wrap the whole run in one transaction, so the mid-run failure test goes red;
    - stamp `judged_at` and `applied_at` separately.
  - **Bounds and cursor:**
    - stop persisting the cursor;
    - drop the reverted-op exclusion;
    - remove the row cap, so the 5 000-row backlog test goes red;
    - restart the budget clock per scope, or start it at run start, so the shared-budget and time-before-drain tests go red;
    - remove the at-least-one-pair rule, so the slow-host test goes red.
  - **Undo and output:**
    - remove the undo guard;
    - flatten the drain counters to top-level keys, so the `memory.doctor` test goes red.
  - **No inference:**
    - embed a missing vector through an injected embedder instead of returning `unknown`, so the model-not-loaded test and the type test go red.
- [x] 7.2 Commit the commands and their outcomes as `openspec/changes/drain-stale-save-time-pendings/measurements/mutation.txt`.

## 8. Documentation

- [x] 8.1 Search `docs/` and `README.md` for descriptions of the consolidation sweep's steps, and add the drain step: its rule, the retired-endpoint drain, the fail-safe, and undo. Done when every sweep description that `grep -rln "consolidation" docs README.md` finds names the drain step.

## 9. Measured cost per drain step and per sweep call

- [x] 9.1 Point the existing prototype instrument `measurements/drain-cost.mts` at the shipped drain step, and keep its prototype outputs as they are:
  - **Corpora:** built with `pnpm run corpus:build` at 1 000, 20 000 and 50 000 memories.
  - **Backlogs:** about 600 and about 5 000 pending rows, created by saving probe texts through `runPostSaveSteps` with `lexicalFloor: 0`.
  - **Instrument A:** wall clock of one drain step, measured with `performance.now()`.
  - **Instrument B:** wall clock of one whole sweep call, including decay and deadline. Measure a session-start `sweepFor` (two scopes) and a forced `runAll` over 2, 10 and 50 projects.
  - Report p50 and p95 over repeated runs on fresh copies. Report the two instruments separately, and never tabulate them together.
- [x] 9.2 Budget: p95 drain time per sweep call ≤ 50 ms at every size. Choose `DRAIN_ROW_CAP` and `DRAIN_BUDGET_MS` from Instrument A. If the budget is missed, lower the cap; that mitigation is pre-authorised. Report Instrument B as its own figure. Record the expected drain time for a 589-row backlog: `ceil(589 / DRAIN_ROW_CAP)` runs, and 589 runs in the worst case.
- [x] 9.3 Commit the output as `measurements/drain-cost-shipped.txt`, with both instruments named in its header, and extend `measurements/README.md`.

## 10. Dry-run count

- [ ] 10.1 Write `measurements/dry-run-count.mts`.
  - **Input:** the path of a database COPY. It refuses the path the server is configured to use.
  - **Setup:** it opens the copy through the repository's database client, so sqlite-vec is loaded, and applies migrations to that copy.
  - **Evaluation:** it runs the drain's selection and `evaluatePair` over every examinable pending pair, without writing.
  - **Output, per project:**
    - total pending;
    - examined;
    - would drain by the rules;
    - would drain because an endpoint is retired;
    - kept as admitted, by channel;
    - kept as unknown, by reason.
- [ ] 10.2 Run it on a `corpus:build` copy carrying the 9.1 backlog. Confirm that the `memory` and `memory_relations` table hashes, taken after migration, are unchanged by the evaluation.
- [ ] 10.3 **OPERATOR-ONLY.** The owner runs `dry-run-count.mts` against a BACKUP COPY of their production database, never against the live file and never while a server holds it open. Only aggregate counts are recorded in `measurements/dry-run.md`, with no ids, titles, content or project names.

## 11. Verification and delivery

- [ ] 11.1 Run `pnpm run typecheck`, `pnpm run lint` and `pnpm test`, and record any failure that also fails on the base commit.
- [ ] 11.2 Run the OpenSpec checks, all green:
  - `openspec validate drain-stale-save-time-pendings --strict`;
  - `node scripts/check-delta-freshness.mjs`;
  - `node scripts/check-spec-crossrefs.mjs`.
- [ ] 11.3 Local smoke, following the `rembric-smoke-tests` skill:
  1. Seed a throwaway data directory while no server runs. It needs noise pending rows (9.1 method) and one pending pair whose source is then superseded by a `topic_key` revision.
  2. Start `pnpm run dev` on it and trigger "run now" on `/dashboard/consolidation`.
  3. Confirm the drained count, the rules-drain ops, and the retired-endpoint op with its own prefix. Confirm that `memory.doctor` `lastRunOps` still holds only `archives` and `orphaned`.
  4. Undo one op from the dashboard, and confirm that row is `pending` again.
  5. Trigger another run, and confirm that the undone row stays `pending`.

  Record the result in `measurements/smoke.md`, with no content.

- [ ] 11.4 Risk is high (Task Size item 1, stored data). Request an independent verification over the whole change before delivery.
- [ ] 11.5 Push and open the pull request, in English. This step is the user's decision.
