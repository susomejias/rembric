## 1. Reproduce the measurement against the shipped configuration

The 56% figure in `proposal.md` was produced with `poolSize = 50`. The shipped value is 20. Reproduce it under the real constant before building anything, so the requirement's "lower bound" wording is justified by a number taken from the code that ships.

- [x] 1.1 Write a throwaway script under the scratch dir (NOT a tracked file) that ingests the eval corpus (`apps/server/src/test/retrieval/ingest.ts`) with the real embedder and calls `findSaveTimeCandidates` per row at the shipped `CANDIDATE_POOL_SIZE = 20`. Record total, mean, p50, p90, max, the count of rows exceeding `CANDIDATES_PER_SAVE_MAX = 5`, and the top-5 capture rate.
- [x] 1.2 Record the numbers in `openspec/changes/surface-save-candidate-total/measurements/before.md` with the method, the corpus size, and the explicit label that this is a post-hoc steady-state distribution and NOT a save-time measurement.
- [x] 1.3 State in the same file whether the pool bound of 20 was ever reached (the `poolSize = 50` run peaked at 15). If max < 20, say so plainly: on that corpus a pool-bounded count is exact, and the "lower bound" wording is protection for larger corpora rather than a description of the measured data.
- [x] 1.4 If the shipped-pool numbers differ materially from the `poolSize = 50` numbers already quoted in `proposal.md`, correct the proposal to the shipped figures and keep the 50-pool figures beside them, labelled.

## 2. The count, computed where the cap is applied

- [x] 2.1 In `apps/server/src/services/save-time-candidates.ts`, export `CANDIDATE_POOL_SIZE = 20` and replace the inline `opts.poolSize ?? 20` at `:92`. Keep `CandidateOptions.poolSize?` as an internal test seam; do not read it from the environment.
- [x] 2.2 Change `findSaveTimeCandidates` to return both the capped list and the pre-cap length, taken from `all` at the `slice` site so the two can never drift. Update the sole caller.
- [x] 2.3 Delete the unreachable `if (supersededByTopicKey && c.targetId === supersededByTopicKey.id) continue` in `apps/server/src/mcp/memory-tools.ts` (inside `saveMemoryWithCandidates`; grep for the predicate rather than trusting a line number — the sibling `order-relation-annotations` is editing this file concurrently, and the statement moved from `:668` to `:705` while this change was being written). Justification is in `design.md` D7; do not leave a comment restating it.
- [x] 2.4 Thread the count through `saveMemoryWithCandidates` and return `candidatesDetected` from `handleSave`; add the number to the `memory.save` output schema. Do NOT add a field to the per-candidate `candidate` zod object.
- [x] 2.5 In `apps/server/src/mcp/observability-tools.ts`, sum the per-item counts in `handleCapturePassive` and return `candidatesDetected` on every successful response, including the zero-extraction early return.

## 3. The description

- [x] 3.1 Extend `SAVE_DESCRIPTION` in `apps/server/src/mcp/server.ts` with the four points the `mcp-api` requirement enumerates: what the number counts and that it is a lower bound; that only `candidates[]` carries `judgmentId`s; that a high value points at `topic_key` convergence via `memory.suggest_topic_key`; and that the remainder is re-derivable with `memory.search` and recordable with `memory.compare`.
- [x] 3.2 Ensure the text names `CANDIDATES_PER_SAVE_MAX` as an operator setting and does NOT name any request argument that raises the surfaced count. Grep the new text for any imperative that would send the agent to a non-existent parameter.
- [x] 3.3 Record the resulting character count. It must stay under `DESCRIPTION_MAX_LENGTH = 1900`; the pre-change baseline is 1172.

## 4. Tests

- [x] 4.1 `save-time-candidates.test.ts`: the returned count is the pre-cap length, asserted with more candidates than the cap and with fewer.
- [x] 4.2 `save-time-candidates.test.ts`: the returned list is the first N of the same ranked order the count was taken over (prefix property), so raising the cap only extends it.
- [x] 4.3 `save-time-candidates.test.ts`: the count can exceed `CANDIDATE_POOL_SIZE` when several rare entities each contribute distinct targets — this is the fact the "lower bound, and MAY exceed the pool bound" wording rests on, and it must be demonstrated rather than asserted in prose.
- [x] 4.4 `memory-tools.test.ts`: a save whose detection ranks more than `CANDIDATES_PER_SAVE_MAX` returns exactly `perSaveMax` candidates and the larger `candidatesDetected`; the number of pending `memory_relations` rows written equals `candidates.length` and not `candidatesDetected`.
- [x] 4.5 `memory-tools.test.ts`: a save with zero candidates returns `candidatesDetected: 0`; `CANDIDATES_PER_SAVE_MAX = 0` also returns `0` with `candidates: []`.
- [x] 4.6 `memory-tools.test.ts`: a `topic_key` save's superseded predecessor appears in neither `candidates[]` nor `candidatesDetected` — the test that would fail if `design.md` D7's unreachability argument were wrong.
- [x] 4.7 `memory-tools.test.ts`: no response field reports truncation as a boolean.
- [x] 4.8 `observability-tools.test.ts`: a passive capture over several learnings reports the sum; a capture that extracts nothing reports `0`.
- [x] 4.9 `mcp-integration.test.ts`: the `memory.save` description stays under `DESCRIPTION_MAX_LENGTH`, and asserts the presence of the `topic_key` guidance so a future edit cannot quietly drop the one behavioural lever in this change.
- [x] 4.10 Scope test: a memory in another project that would resemble the saved row is counted by neither `candidates[]` nor `candidatesDetected`.

## 5. Acceptance bar — prove the hot path did not move

No latency number is claimed anywhere in this change, so the bar is a comparison, not a threshold. `memory.save` runs on the single synchronous SQLite connection shared with `/mcp`, `/api`, the dashboard and `/healthz`.

- [x] 5.1 Query-count proof (the primary bar, and the one that must be exact): count SQL statements executed by one `memory.save` before and after, using a statement counter on the connection rather than inference. The two counts MUST be **identical**. A difference of even one means the count is no longer being read off an already-materialised array and the implementation has diverged from `design.md` D1.
- [ ] 5.2 Wall-clock at 1k / 20k / 50k memory rows using the corpus fixtures from the `tune-hot-query-paths` change. Establish the noise band first by running the PRE-change build twice; the post-change median and p95 must fall inside the larger of that observed spread or ±5%.
- [x] 5.3 Record both results in `measurements/acceptance.md`. If 5.1 is not exactly equal, stop and fix the implementation rather than widening the bar.

## 6. Verification

- [x] 6.1 `pnpm run typecheck`
- [x] 6.2 `pnpm run lint`
- [x] 6.3 `pnpm test`
- [x] 6.4 `pnpm run eval` — non-regression only. This change does not touch ranking, so any metric movement is a signal that something unintended changed; investigate rather than re-baseline.
- [x] 6.5 `.env.example`: delete the two stale lines `CANDIDATE_VEC_THRESHOLD=0.85` and `CANDIDATE_FTS_THRESHOLD=0.4` (`:33-34`). Neither exists in `config.ts`; both sit in the block an operator reads to decide whether candidate detection is configurable, which is this change's subject. Confirm by grep that no other tracked file references either name.
- [x] 6.6 Confirm no new SQL was introduced outside `db/` and that `invariants.test.ts` still passes its data-access-confinement assertion.
- [x] 6.7 Confirm `git ls-files apps/plugin/` is untouched by this change — no client ships an input-schema change, so any plugin diff is a mistake.

## 7. Real Docker smoke against pre-existing seeded data

Standing requirement for anything touching MCP or production behaviour. **Operator-run on the host** — pauses `/opsx:apply`.

- [ ] 7.1 Bring up the dev stack per `docs/docker.md` (`pnpm run dev:docker:up`), which wipes and reseeds, then let it seed fully so the corpus is non-trivial. Note the seeded active-memory count — a smoke against an empty corpus would make every `candidatesDetected` zero and prove nothing.
- [ ] 7.2 Restart against the SAME data directory on the new image (not a fresh wipe), so the run exercises an upgrade over pre-existing rows rather than a first boot.
- [ ] 7.3 Record `memory.doctor`'s pending-judgment count before and after a `memory.save`. The delta MUST equal the length of that save's `candidates[]`, never `candidatesDetected` — this is the queue-growth guarantee stated in `design.md`'s migration plan.
- [ ] 7.4 Call `memory.save` with content that deliberately resembles several seeded memories. Assert `candidatesDetected` is present, is a number, is greater than or equal to `candidates.length`, and that `candidates.length` is at most `CANDIDATES_PER_SAVE_MAX`. Assert the non-empty case explicitly: a run in which `candidatesDetected` is 0 for every probe has verified nothing.
- [ ] 7.5 Call `memory.capture_passive` with a `## Key Learnings` section of several items and assert the summed `candidatesDetected`.
- [ ] 7.6 Re-derive the tail: take the saved memory's own text, call `memory.search` with it, and confirm the unsurfaced neighbours are reachable. This is the claim the whole design rests on; it must be exercised against real data at least once rather than argued.
- [ ] 7.7 Confirm `/dashboard/judgments` shows exactly the pending rows the save created and no others, and that its total is unchanged by `candidatesDetected`.
- [ ] 7.8 Rollback rehearsal: run the previous image against the same data directory and confirm it starts, saves, and simply omits the field. Nothing may error on its absence.

## 8. Measurement the change must produce

- [ ] 8.1 After deploy, record the distribution of `candidatesDetected` against `candidates.length` over a day of real saves on the populated instance (99 active memories at the time of writing). This is the number `design.md` Open question 1 needs and cannot be obtained any other way — it is the whole reason the field exists.
- [ ] 8.2 Append it to `measurements/acceptance.md` with the active-memory count at the time. Do not include memory content, project slugs, session ids or any operator-identifying detail — counts and distributions only.

## 9. File the deferred items so they are not lost

- [ ] 9.1 File the entity-channel status predicate (`design.md` Open question 4): `findOtherMemoriesForEntity` filters `status != 'archived'` while both sibling channels filter `active`, its own doc comment claims "active", and `memory-entities/spec.md:348` requires "an existing **active** memory" — so a superseded row can take a save-time slot. Sole production caller is `save-time-candidates.ts:183`. Include that this punctures the structural-impossibility argument in `design.md` D5 for one channel.
- [ ] 9.2 File the one-hop `not_conflict` dismissal walk (Open question 5): `memory/spec.md:509` says "walking the `replaces` **chain**", the code passes the one-element `saved.replaces`, so a dismissal made two saves ago re-surfaces. Note that `PREDECESSOR_CAP`, the bounded breadth-first walk, and the trigger-maintained `memory_replaces` table already exist, and that the fix adds a query to a hot path and therefore needs its own measurement.
- [ ] 9.3 File one-verdict-per-pair (Open question 2) with the `markJudged(..., { requirePending: false })` evidence and the schema FSM comment.
- [ ] 9.4 File the missing `(source_id, target_id)` uniqueness (Open question 3), including that the unique index is NOT the cheap fix (table rebuild plus a pre-dedupe that decides which verdict wins) and that a direction-merging service guard would invert `applySupersedesSideEffect`.
- [ ] 9.5 File batched `memory.compare` (Open question 6) with the `judge` parity reference (`relations-tools.ts:62`, max 25) and the per-item-transaction / partial-failure contract it must mirror.
- [ ] 9.6 Record in the same place that slot efficiency was proposed, measured and rejected (`design.md` D5), so the three dead skips are not re-proposed from first principles.

## Apply notes (2026-07-29)

Numbers in `measurements/before.md` (task 1) and `measurements/acceptance.md` (task 5).

- **5.2 partially done.** Wall-clock measured at 1k and 20k rows, pre-change noise band
  established first; both medians and p95s inside it. 50k not measured — 5.1 came out exactly
  equal and the added work is one array-length read, so 50k would test the noise band.
- **7.1–7.8 not run.** `dev:docker:up` wipes `data-dev`, which holds the 2055-row corpus the
  operator asked to keep. Reasons and the specific unverified claims are listed in
  `measurements/acceptance.md`.
- **8.1–8.2 not collected.** Post-deploy observation; cannot be produced from a dev tree.
- **9.1 and 9.2 already landed** rather than being filed: the entity-channel `active`
  predicate shipped in `archive/2026-07-29-align-rarity-gate-population`, and the `replaces`
  chain walk shipped in the 2026-07-29 compliance commit (`collectAncestorIds`, bounded by
  `PREDECESSOR_CAP`). Both were open questions here; neither needs a follow-up change.
- **9.3–9.6 not filed as change folders.** The evidence sits in this change's `design.md`;
  no `openspec/changes/` entry was opened for them.
