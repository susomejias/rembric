## 1. Failing tests first

Every test in this group MUST be observed red before the predicate lands, and the observed pre-fix value MUST be recorded in the commit body. The reproduction is the one measured in `proposal.md`: save A with a `topic_key`, attach five aged pendings to A, save B with the same `topic_key` (so B supersedes A), attach one newer aged pending to B.

- [x] 1.1 Repository-level regression in the existing `apps/server/src/db/repositories/relations-repository.test.ts`: after the revision, `listPendingInScope` SHALL return only B's pair and `countPendingInScope` SHALL return 1. Assert BOTH methods in the same test body — this is the exact test issue #298 asks for, and asserting one without the other is how a list/total disagreement ships.
- [x] 1.2 Repository-level case for the retired TARGET: source `active`, target archived via the existing archive path. The target's lifecycle is a separate conjunct and needs its own red test, otherwise task 4.2's mutation cannot distinguish the two halves.
- [x] 1.3 MCP-level regression in `apps/server/src/mcp/context-pending-judgments.test.ts`: with the same fixture, `memory.context` (no `judgments` argument) SHALL return a `pendingJudgments` array of length 1 whose single entry's `sourceId` is B, and `pendingJudgmentsTotal` SHALL be 1. Record the pre-fix observation — the measured baseline is 5 dead entries on the page, 0 live, total 6.
- [x] 1.4 MCP-level case that an explicit `judgments: 50` does not readmit the withheld pairs (spec scenario "An explicit `judgments` size does not readmit retired pairs"). A size lifts the age filter only; without this case a later change could route the inventory path around the predicate.
- [x] 1.5 `memory.stats` case in the same or an adjacent file: `pendingJudgmentsTotal` from `memory.stats` SHALL equal the one from `memory.context` on the same connection and the same fixture (spec scenario "Stats and context agree on the pending depth").
- [x] 1.6 Control that MUST pass before and after: a pending pair between two `active` memories still appears in the list and the total, with and without a `judgments` size. A control that fails means the harness is wrong, not the code.
- [x] 1.7 Control that MUST pass before and after: the fixture's supersede actually happened — assert `repos.memory.unsafeGetById(a.id)?.status === 'superseded'` and `…(b.id)?.status === 'active'` inside the test, not only in a probe. Without it a broken fixture reads as a passing fix.
- [x] 1.8 Control that MUST pass before and after: `adminListWithContent({status:'pending'})` and `adminCountWithFilters({status:'pending'})` still return the withheld rows (spec scenario "The operator's view of the same rows is unchanged"). Assert the count, not just non-emptiness.
- [x] 1.9 Control that MUST pass before and after: `findPendingOlderThanInScope` still returns a withheld pair, so the sweep can still orphan it (spec scenario "A withheld pair is still orphaned at the deadline"). Prefer driving the consolidation runner over asserting the repository read alone, so the assertion is about the outcome the spec names.

## 2. The predicate

- [x] 2.1 Define the endpoint-lifecycle predicate ONCE in `apps/server/src/db/repositories/relations-repository.ts`, beside `endpointsInScope` (~:69), as equality predicates on the existing `sourceMemory` / `targetMemory` aliases (`:65-66`). No new join, no subquery (design D4, `data-access` delta).
- [x] 2.2 Apply it in `listPendingInScope` (~:376) — one more conjunct in the existing `and(…)`, nothing else in the method changes.
- [x] 2.3 Apply it in `countPendingInScope` (~:402), likewise.
- [x] 2.4 Confirm by inspection that nothing else changed: `git diff --stat` SHALL show only `relations-repository.ts` plus test files in this group's commit, and `grep -n "status, 'active'" apps/server/src/db/repositories/relations-repository.ts` SHALL show the predicate defined once and referenced twice.
- [x] 2.5 Confirm `findPendingOlderThanInScope` (~:263) and every `admin*` read are untouched (design D3, D5) — `git diff` on the file is the evidence.
- [x] 2.6 No comment beyond at most one line stating the non-obvious why, if one is needed at all. The rationale belongs in the spec, which the requirement text now carries; do not restate the design in the source.
- [x] 2.7 Confirm every test in group 1 is green and every control (1.6-1.9) is still green.

## 3. Query plans

- [x] 3.1 Capture `EXPLAIN QUERY PLAN` for both reads BEFORE and AFTER the predicate, for the `project` and the `global` shape of `endpointsInScope` (four plans each side), against a corpus built by `pnpm run corpus:build` at the invocation `data-access/spec.md` records. Record the plans in the commit body.
- [x] 3.2 If any plan gains a `SCAN` or a `USE TEMP B-TREE`, stop and report before landing: `listPendingInScope` runs on every `memory.context`. If no plan changes, say so explicitly rather than leaving it unstated — "no change" is the finding.
- [x] 3.3 Only if 3.2 shows a plan change: measure wall-clock for both reads at 1k / 20k / 50k with the same harness, name the instrument (isolated statement vs the `memory.context` handler end-to-end), and bring the numbers to the design as a new decision. Do NOT add an index speculatively.

## 4. Mutation-check the guard

A guard is not covered until its test fails without it. Use `node scripts/mutate.mjs --file … --spec … --mutation … --with …` for each, and confirm the file is byte-identical afterwards.

- [x] 4.1 Weaken the predicate to test ONLY the source's status; confirm the retired-TARGET tests (1.2, and any MCP case that names an archived target) go red while the retired-source tests stay green.
- [x] 4.2 Weaken it to test ONLY the target's status; confirm the retired-SOURCE tests (1.1, 1.3) go red.
- [x] 4.3 Remove the predicate from `countPendingInScope` only, leaving it in `listPendingInScope`; confirm the total assertions (1.1, 1.3, 1.5) go red while the list-only assertions stay green. This is the list/total-divergence failure the `data-access` requirement exists to prevent, so it must be detectable.
- [x] 4.4 Remove the predicate from `listPendingInScope` only; confirm the page assertions go red.
- [x] 4.5 Report the four results as a table in the commit body. A test green on both sides of a mutation proves nothing and MUST be rewritten, not explained.

## 5. Verification

- [x] 5.1 `pnpm run typecheck` clean.
- [x] 5.2 `pnpm run lint` clean.
- [x] 5.3 `pnpm test` fully green, with no existing test weakened or skipped to accommodate the predicate. If a pre-existing test goes red, that is a finding to report — it would mean a fixture depends on a retired-endpoint pending being surfaced (design Risks) — and it MUST be understood before it is changed.
- [x] 5.4 Confirm `apps/server/src/test/invariants.test.ts` is unaffected: no SQL left `db/`, no `admin*` or `unsafe*` call was added outside its allowed caller set.
- [x] 5.5 `pnpm run eval` is NOT required and SHALL NOT be run for this change: no retrieval ranking, scoring or candidate-detection path is touched. Record that decision in the commit body so its absence does not read as an omission.
- [x] 5.6 Determine whether `seed-dev` or `seed-volumetric` create pending relations whose endpoint is later retired (`grep -n "createPending\|topicKey\|markSuperseded" apps/server/src/scripts/seed-*.ts`). If they do, the seeded corpus's pending totals shift; check whether `seed-volumetric.test.ts` asserts anything derived from these two reads and update it only if it does.

## 6. Docker smoke against pre-existing seeded data

Standing requirement for anything touching MCP or production behaviour. Follow the `rembric-smoke-tests` skill for bring-up and teardown. Note that `dev:docker:up` reseeds on every boot (`seed-dev --reset`), so capture the baseline from the SAME corpus the after-run uses.

- [x] 6.1 (DEVIATION: `dev:docker:up` runs `seed-dev --reset` in the container CMD, so a populated volume cannot survive a boot. The dev stack bind-mounts `apps/server/src`, so before/after was driven by flipping the mounted source under `tsx watch` — one boot, one corpus, no reseed between the two readings. The fixture was created over MCP after boot, as this task allows.) Bring up the stack on `main` (pre-change image) and record, through the real MCP boundary over HTTP — not by calling a handler in-process — the `pendingJudgmentsTotal` and the `pendingJudgments[]` length for a project scope holding at least one `topic_key` revision. Create that revision through `memory.save` over MCP if the seeded corpus has none.
- [x] 6.2 With the stack still on the same volume, compute the retired-endpoint pending count with a read-only SQL probe joining both endpoints. This is the number the change must remove; name it in the smoke report.
- [x] 6.3 Rebuild with the change, restart against the SAME volume without reseeding, and confirm through the same MCP calls that `pendingJudgmentsTotal` dropped by exactly the number from 6.2 and that the surviving page entries all have `active` endpoints. Include a control: the total is NOT zero if adjudicable pairs exist — a smoke that passes because both sides are empty proves nothing.
- [x] 6.4 Confirm `/dashboard/judgments?status=pending` in the running container still lists and counts the withheld rows, with their `Mark orphaned` action present.
- [x] 6.5 Confirm the boot performed no migration and logged no migration line — this change ships none.
- [x] 6.6 Tear down per the skill, leaving no stray container or volume.

## 7. Close-out

- [ ] 7.1 `/simplify` over the diff, then `/code-review`; resolve findings before archiving.
- [ ] 7.2 Archive via the `sdd-archiver` agent. Verify the `mcp-api` MODIFIED requirement merged as a whole-requirement replacement and that no scenario of "The MCP server MUST expose three research tools" was dropped (compare the scenario list before and after), that the `memory` ADDED requirement landed alongside the MODIFIED queue-depth one, and that the `data-access` requirement did not disturb "Hot query paths MUST retain the index and query shapes their measured basis rests on".
- [ ] 7.3 `pnpm run check:spec-provenance` clean.
- [ ] 7.4 Commit and push (Conventional Commits; never `--no-verify`).
- [ ] 7.5 Comment on issue #298 with what shipped, the measured before/after from 6.3, and an explicit note that the two suggestions deferred here — a `stale` facet on `/dashboard/judgments`, and a warning when the `global` scope is empty — are NOT included, so they are not assumed closed by this change.

## 8. Deferred, recorded so they are not silently lost

- [x] 8.1 Do NOT implement auto-orphaning at supersede time (the issue's own alternative, design D3's rejected option). If it is still wanted after this ships, it needs its own change: a new mutation on the `saveWithTopicKey` write path, a specified and journaled reason string, and a decision about a pair whose endpoint is later reactivated by an undo.
- [x] 8.2 Do NOT add the `stale` facet to `/dashboard/judgments` here (design Open Questions). Leave the operator view exactly as it is.
- [x] 8.3 Do NOT add an empty-`global`-scope warning to `memory.stats` or the dashboard here. Unrelated to the queue predicate; it rides on #298 only because both were found in the same clean-up.
