## 0. Prerequisites

- [ ] 0.1 Confirm `add-retrieval-eval-harness` has landed — the candidate channel and the seed change both need measuring.
- [ ] 0.2 Confirm the trigger-set invariant assertion from `fix-audited-defects` exists, since this adds a third derived index whose drift must be catchable.
- [ ] 0.3 Decide the first-pass entity kinds (design.md open question 1) before writing the extractor.

## 1. The extractor (pure, and the precision bar is the deliverable)

- [ ] 1.1 Write `apps/server/src/services/entities.ts` as a pure function of `title + content` → `{kind, value}[]`. No model, no network, no I/O.
- [ ] 1.2 Implement the agreed kinds. Recognise only high-confidence syntax; skip ambiguous prose.
- [ ] 1.3 Normalise values per kind (path separators, case rules, trailing punctuation) so the same referent yields the same key.
- [ ] 1.4 Build a fixture corpus of real memory text — including prose that *resembles* entities but is not — and assert **zero false positives** on it. This is the load-bearing test: a false link degrades exact lookup into bad text search.
- [ ] 1.5 Assert reproducibility and assert the extractor never throws on adversarial input (very long tokens, NUL bytes, mixed scripts).

## 2. Schema and migration

- [ ] 2.1 Add `apps/server/src/db/schema/entities.ts`: the entity table (value, kind, scope, project) and the link table (memory ↔ entity). Document both as **derived, never primary**.
- [ ] 2.2 Migration creating both tables plus indexes for the two access patterns: entity → memories, and memory → entities.
- [ ] 2.3 Resumable batched backfill over existing non-archived memories, in the shape of the embedding backfill; server serves throughout.
- [ ] 2.4 Test: backfill resumes after restart; requests work during it; partial coverage degrades rather than errors.

## 3. Repository and service wiring

- [ ] 3.1 `apps/server/src/db/repositories/entities-repository.ts` — scoped reads only; the entity → memories read **requires** a `Scope` parameter.
- [ ] 3.2 Extract and link inside the existing save transaction in `apps/server/src/services/memory.ts`; a failure logs and does not fail the save.
- [ ] 3.3 Implement the `entity` filter as a chronological index lookup — no fusion, no rank window, no threshold, no boost.
- [ ] 3.4 Implement entity + text query as **narrowing** within the entity's memories, never as a fusion of two sets.
- [ ] 3.5 Test: the same path in two projects does not join them; twenty linked memories all return; a rare identifier invisible to text search is found; ordering is chronological and unboosted.

## 4. Save-time candidate channel

- [ ] 4.1 Add entity overlap as a third candidate source in `apps/server/src/services/save-time-candidates.ts`, labelled distinctly from lexical and dense.
- [ ] 4.2 Implement the rarity gate — proportion of the scope's memories rather than an absolute link count, per the lesson that absolute thresholds over corpus-relative quantities do not hold.
- [ ] 4.3 Respect the existing per-save candidate maximum across all three channels combined.
- [ ] 4.4 Test: a low-vocabulary-overlap contradiction about the same file is surfaced; a very common entity surfaces nothing; the per-save cap holds.

## 5. MCP surface — no new tool

- [ ] 5.1 Add the `entity` argument to `memorySearchSchema`; indicate in the response that exact-address retrieval was used.
- [ ] 5.2 Add the bounded `entities[]` projection to memory-returning reads, with truncation indicated.
- [ ] 5.3 Report the shared entity on entity-sourced candidates.
- [ ] 5.4 Update descriptions without inflating the tool-list byte budget; re-measure that budget and confirm no regression.
- [ ] 5.5 Test: an unknown entity returns empty and does NOT silently degrade into a text query over that string.

## 6. Integrity, rebuild and diagnostics

- [ ] 6.1 Implement the rebuild: truncate both tables and recompute from `memory`.
- [ ] 6.2 Add the link-count delta to `apps/server/src/db/diagnostics.ts` and surface it as a doctor warning.
- [ ] 6.3 Expose the rebuild as an admin-gated maintenance action, confined to the dashboard layer.
- [ ] 6.4 Test: truncate-and-rebuild yields an equivalent index; dropping both tables leaves every memory field untouched; drift is reported.

## 7. Context seed and dashboard

- [ ] 7.1 Prefer entities extracted from the session's working directory over embedding the path as prose, when the relevance channel derives its own seed.
- [ ] 7.2 Add `apps/server/src/dashboard/entities.ts`: counts by entity, filter by kind, a single-reference filter, and links into the existing memories view.
- [ ] 7.3 Test: the entity view is scope-isolated; the single-reference filter works.

## 8. Confirm the exclusion holds

- [ ] 8.1 Assert `memory.search` with a text query and no entity filter returns results **identical** to before the entity index existed. The fusion path must be untouched.
- [ ] 8.2 Re-run `pnpm run eval` and confirm the text-query metrics are unchanged, not merely similar.
- [ ] 8.3 Record the candidate-channel effect separately: how many candidates the entity channel proposes that neither other channel found, and how the agent judged them.

## 9. Verify

- [ ] 9.1 `pnpm run typecheck && pnpm run lint && pnpm test`.
- [ ] 9.2 Smoke against `pnpm run dev:docker:up`: migration and backfill apply; `memory.search({entity})` returns a known file's memories; the doctor delta reads zero after backfill.
