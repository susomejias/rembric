# Tasks

Ordered so the safety property exists before anything can write, and so the harness's own cost is measured before it is declared usable.

## 1. Re-verify the preconditions on disk

- [ ] 1.1 Confirm the `DELETE FROM memory` allow-list in `apps/server/src/test/invariants.test.ts` still names exactly `db/repositories/memory-repository.ts` and `scripts/seed-dev.ts`. If a third entry has appeared, STOP — design D1's argument rests on that list being closed, and it must be re-argued rather than worked around.
- [ ] 1.2 Confirm `apps/server/src/scripts/` still holds only `seed-dev.ts` and `upgrade-helper.ts` (plus their tests), so the harness is genuinely new rather than a rename of something already there.
- [ ] 1.3 Re-read `tune-hot-query-paths/design.md`'s corpus paragraph and record the target shape as found, not as quoted here: bodies, vector dimensionality, confirmations per memory, scope count, entities per memory, file size at 50k, and the separate session count. If it has moved, the harness follows the change that will consume it.
- [ ] 1.4 Confirm `EMBEDDING_INPUT_VERSION` and the vec table's dimensionality on disk, so the synthetic vectors are written at the width the real embedder produces rather than at a width copied from prose.

## 2. The safety property, before any write path exists

- [ ] 2.1 Implement the argument surface first — `--db <path>`, `--memories N`, `--sessions M`, `--seed S` — with NO destructive flag of any kind, and the refusal: exit non-zero, write nothing, when the target database holds any `memory` row.
- [ ] 2.2 Refuse the dev stack's data directory explicitly, by path, in addition to the non-empty check. The non-empty check alone would let the harness write into a freshly-wiped `data-dev`, which is the exact sequence that destroyed the resident corpus.
- [ ] 2.3 Test the refusals BEFORE the generator exists, so they are not retrofitted around a working happy path: a populated database is refused with a message naming the path; the dev data directory is refused even when empty; neither leaves a file modified. Verifiable: the tests fail if either guard is removed.
- [ ] 2.4 Assert that the harness contains no `DELETE`, no `--reset`, no `--force` and no destructive env gate, and that `invariants.test.ts`'s allow-list is unchanged by this change. This is the executable form of design D1 — the constraint is worth nothing if the next contributor can add a flag and only prose objects.

## 3. The generator

- [ ] 3.1 Deterministic PRNG seeded from `--seed`, used for every random choice, so the corpus is a pure function of the arguments. Do NOT use `Math.random()` anywhere.
- [ ] 3.2 Declare the shape as named exported constants — body length distribution, entities per memory, confirmations per memory, scope count, superseded fraction — in one place, so §4's assertion has something to compare against rather than re-deriving the intent.
- [ ] 3.3 Generate bodies from a word list to the declared length distribution (design D3). Not lorem ipsum, not one repeated token: FTS5 is a real consumer here and a degenerate token distribution produces an index that does not behave like production's.
- [ ] 3.4 Write rows through the application write path so the FTS triggers, `memory_replaces` and the entity tables are populated the way the server populates them (design D6). Never insert into a derived table directly.
- [ ] 3.5 Synthetic unit vectors at the dimensionality confirmed in 1.4, deterministic from the seed (design D2). Print the caveat — vectors are synthetic, no retrieval-quality claim may be drawn — in the harness's own output, not only in a design document.
- [ ] 3.6 Generate the superseded fraction through real `topic_key` chains rather than by writing `status = 'superseded'` directly, so `replaces` edges and the chain shape exist. Several of `tune`'s findings walk that graph.
- [ ] 3.7 Sessions on their own axis (design D4), buildable with `--memories 0` so a session-scoped measurement costs nothing on the other axis.
- [ ] 3.8 Progress output at a coarse interval, because a 50k run is long enough that silence reads as a hang.

## 4. Assert the declared shape

- [ ] 4.1 Co-located test: generate a small corpus into a temp database and assert the realised distribution matches the constants from 3.2 within a stated tolerance — entities per memory, body length percentiles, confirmations per memory, scope spread, superseded fraction. State the tolerance and why it is what it is.
- [ ] 4.2 Assert determinism directly: two runs with the same seed into two databases produce the same row counts and the same per-row content. Then assert that a DIFFERENT seed produces a different corpus, so the first assertion cannot pass on a generator that ignores the seed entirely.
- [ ] 4.3 Assert the derived state is real, not empty: `memory_fts`, `memory_replaces`, `memory_entities`, `memory_entity_links` and `memory_entity_scan` all carry rows consistent with the source table. A corpus with an empty FTS index would measure every lexical query as trivially fast.
- [ ] 4.4 Mutation check: bypass the write path for one table (write `memory` rows directly) and confirm 4.3 fails. A derived-state assertion that has never been observed to fail is not an assertion.

## 5. Measure the harness itself

- [ ] 5.1 Wall-clock and resulting file size at 1k, 20k and 50k memories, and for the 50k-session corpus, each stated with the machine it was measured on. Record them in `measurements.md` in this change folder.
- [ ] 5.2 Compare the 50k file size against `tune`'s recorded 571 MB. A large divergence means the shape does not match what those findings were measured on, and that is a stop condition for using this harness to re-verify them — say so rather than adjusting the number to fit.
- [ ] 5.3 State plainly whether the 50k run is fast enough to be used routinely. If it is not, record the number and name the bottleneck; do NOT bypass the real write path to make it faster, which design D6 forbids for reasons that outlive the inconvenience.

## 6. Wire it up

- [ ] 6.1 One `package.json` script entry. Name it so it cannot be confused with `seed:dev` at a glance — the two have opposite safety properties.
- [ ] 6.2 Confirm nothing in the shipped image invokes it: `apps/server/Dockerfile`, both compose files and the plugin tree are untouched. `git diff --name-only` must show only the script, its test, `package.json` and this change folder.

## 7. Verify

- [ ] 7.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test`, with the before-and-after counts recorded.
- [ ] 7.2 `pnpm run check:delta-freshness` — this change carries no `MODIFIED` block, so the expected result is a clean pass with nothing to review. Confirm that rather than assuming it.
- [ ] 7.3 `npx openspec validate commit-the-volumetric-harness --strict`.
- [ ] 7.4 `pnpm run eval` is NOT required and MUST NOT be run as evidence: no retrieval, ranking, scoring or embedding path is touched. Recorded so the omission is a decision.
- [ ] 7.5 Confirm the append-only invariant is untouched by construction: the harness only inserts, into a database it requires to be empty of memories.

## 8. Prove it does the job it exists for

- [ ] 8.1 Build a 20k corpus and re-capture `EXPLAIN QUERY PLAN` for one query `tune-hot-query-paths` already characterised. The plan should match what `tune` recorded. If it does not, either the harness's shape is wrong or that finding was corpus-specific — both are worth knowing before 36 tasks are built on it.
- [ ] 8.2 Record that comparison in `measurements.md` as the harness's acceptance evidence. Building a corpus is not the deliverable; building one that reproduces a known result is.
- [ ] 8.3 Hand `tune-hot-query-paths` the exact invocations its groups 4–9 need, in that change's notes, so unblocking it is a copy-paste rather than a re-derivation.

## 9. Record what was deliberately not done

- [ ] 9.1 Deferred: a CI regression gate running reduced-size measurements with tolerance bands. It needs this harness plus a decision about what a tolerable regression is; neither is settled here.
- [ ] 9.2 Deferred: expressing `seed-dev.ts`'s demo corpus in terms of this harness. Rejected for now — it couples a stable operator-facing fixture to a measurement tool for no measured benefit.
- [ ] 9.3 Answer design Open question 1 (whether the harness emits a manifest beside the corpus) with a decision and its reason, or carry it forward explicitly. Do not let it lapse silently.
- [ ] 9.4 Carry design Open question 2 forward (failing when a new source table goes unpopulated, driven from `schema-inventory.ts`) as a named follow-up rather than a comment.
- [ ] 9.5 Record the limitation the harness ships with: synthetic vectors mean no retrieval-quality question can be answered on its corpora, and `pnpm run eval` remains the instrument for those.
