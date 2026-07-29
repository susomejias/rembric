## 1. Measure the real worst case BEFORE choosing any bound (design.md D1)

- [ ] 1.1 Add a measurement fixture (a test, not a script, so it is re-runnable and reviewed) that builds the pathological corpus in one scope: **≥ 200 active memories**, each carrying **≥ 50 judged annotations** whose stored `reason` is **exactly 2 000 characters** (the `memory.judge` / `memory.compare` schema cap), plus at least one memory whose annotations are a mix of `pending` (no `reason`, carries `judgmentId`) and `judged`, so both annotation shapes are measured. Memory `content` lengths must be realistic, not minimal — record the distribution used.
- [ ] 1.2 Measure through the REAL MCP path (`src/test/mcp-integration.test.ts` harness, not the bound handlers), for each of the four requests below, recording BOTH `content[0].text.length` and `JSON.stringify(structuredContent).length`, and their sum — `mcp/result.ts::ok()` emits the payload twice, so a one-copy figure understates the transported size:
  - `memory.search` at `limit: 200` with NO `relations_limit` (today's default ceiling);
  - `memory.search` at `limit: 200, relations_limit: 50` (the post-`order-relation-annotations` ceiling, the regression);
  - `memory.get` with 100 `ids` at `relations_limit: 50`;
  - `memory.get` with a single `id` at `relations_limit: 50`.
- [ ] 1.3 Record all four measurements as a table in this file, and state for each how far it is from the pre-`order-relation-annotations` ceiling. The pre-measurement ARITHMETIC hypothesis to confirm or refute is: ~2.1 KB per judged annotation pretty-printed, ~20 MB for 200 × 50, ~40 MB transported, and ~1.3 MB of annotation scaffolding surviving even with `reason` removed entirely. **If measurement disagrees with the hypothesis, the constants in section 2 follow the measurement and `design.md` is amended** — do not reconcile the numbers by adjusting the fixture.
- [ ] 1.4 From 1.3, decide `ANNOTATION_REASON_CHARS` (proposed 350, the shipped `CONTEXT_SNIPPET_CHARS` value) and record the decision. If 350 leaves the measured post-change worst case above what a conservative agent context window can hold, land a smaller value and record the measurement that forced it — `RELATION_ANNOTATION_RESPONSE_BUDGET` is pinned to shipped behaviour (design D3) and is NOT the knob that moves.

## 2. Bound the annotation reason on multi-row reads (design.md D2)

- [ ] 2.1 Declare `ANNOTATION_REASON_CHARS` in `apps/server/src/services/relations.ts` beside `RELATION_ANNOTATION_MAX` (the constants' single home per the `memory` capability's constants requirement), at the value decided in 1.4.
- [ ] 2.2 Add one helper in `apps/server/src/mcp/_shared.ts` that returns an annotation list with each judged `reason` passed through the existing `snippet(content, max)` (slice + `…`), leaving `pending` annotations untouched. It lives in the projection layer because services never import from `mcp/` and the per-surface difference is a presentation decision (design D2).
- [ ] 2.3 Apply the helper at the TWO multi-row annotation sites in `apps/server/src/mcp/memory-tools.ts` — the `memory.search` result-row projection and the batch (`ids`) `memory.get` projection. Do NOT apply it at the single-id `memory.get` site.
- [ ] 2.4 Test: a stored 2 000-char `reason` comes back at most `ANNOTATION_REASON_CHARS`, ending in the ellipsis marker, and its leading characters equal the stored value's prefix — asserted at BOTH multi-row surfaces, with the two responses byte-identical for that annotation.
- [ ] 2.5 Test: the same annotation read via single-id `memory.get` returns the reason verbatim (2 000 chars, no ellipsis).
- [ ] 2.6 Test: a `reason` shorter than the bound is returned unchanged with no ellipsis appended; a `pending` annotation (no `reason`) is unaffected.
- [ ] 2.7 Test: after any number of reads, the `memory_relations.reason` column still holds the full stored text (append-only — the bound is a projection).
- [ ] 2.8 Add a drift guard: a test asserting that every multi-row annotation surface bounds the reason, driven from a fixture whose stored reason exceeds the cap, so a future third multi-row consumer that forgets the helper fails rather than silently regressing.

## 3. Give the response an aggregate budget (design.md D3, D6, D7)

- [ ] 3.1 Declare `RELATION_ANNOTATION_RESPONSE_BUDGET` in `apps/server/src/services/relations.ts`, derived in code from the shipped numbers rather than written as a literal (maximum `limit` × the multi-row annotation default = 200 × 10 = 2 000), so raising either input moves the budget visibly instead of leaving a stale constant.
- [ ] 3.2 In the `memory.search` handler, before any query, reject when `limit × (relations_limit ?? default)` exceeds the budget, with the repo's `invalid_input` error shape. The message must name both parameters, the budget, and at least one legal combination (e.g. `limit: 40` with `relations_limit: 50`, or `limit: 200` at the default), and point at single-id `memory.get` for one memory's annotations at the maximum.
- [ ] 3.3 Same check in the batch (`ids`) `memory.get` handler on `ids.length × (relations_limit ?? default)`. The single-id form is exempt by construction (1 × 50) — assert that rather than special-casing it.
- [ ] 3.4 Extend `relationsLimitParam`'s `.describe()` with the joint bound: that the row count and `relations_limit` are limited together, how to trade between them, and that single-id `memory.get` reads one memory at the maximum. Keep every existing clause (default, maximum, `min(relationsTotal, 50)`, rejected-not-clamped) — the published requirement mandates all of them. Interpolate the budget from the constant so the text cannot drift.
- [ ] 3.5 Test at the protocol layer (`src/test/mcp-integration.test.ts`, since the bound handlers bypass zod and the handler check must be observed as the client sees it): `limit: 200, relations_limit: 50` is rejected; the error text names both parameters and a legal combination; no partial result is returned.
- [ ] 3.6 Test that DEFAULTS are never rejected: `limit: 200` with no `relations_limit` is served (product exactly at budget), and `memory.get` with 100 `ids` and no `relations_limit` is served.
- [ ] 3.7 Test the trade: `limit: 8, relations_limit: 50`; `limit: 40, relations_limit: 50`; `limit: 200` at the default — all served, with the annotation counts each request asked for. `ids: 100, relations_limit: 50` is rejected.
- [ ] 3.8 Test that the budget never changes a SERVED response: for a request inside the budget, the rows, their order, each row's `relations` length and `relationsTotal` are identical to the same request on the pre-change build (a fixture assertion, not a snapshot of the whole payload).
- [ ] 3.9 Assert the rendered `inputSchema.properties.relations_limit.description` on both tools contains the joint-bound sentence, and confirm the tool-DESCRIPTION cap guard (`DESCRIPTION_MAX_LENGTH`) still passes — parameter descriptions do not count against it, verified in `order-relation-annotations` task 3.3, so this must remain true rather than be assumed.

## 4. Make the ceiling CI-asserted, not reasoned about (design.md D4)

- [ ] 4.1 Declare the annotation payload ceiling constant, with the measured post-change worst case from 5.1 as its basis, and a one-line note of what measurement produced it.
- [ ] 4.2 Add the guard test: construct the largest LEGAL request at each of the three annotation surfaces **from the constants themselves** (not from literals), invoke the real tools against the 1.1 corpus, and assert `text.length + JSON.stringify(structuredContent).length` is within the ceiling at each.
- [ ] 4.3 Verify the guard bites: temporarily raise `RELATION_ANNOTATION_MAX`, then `ANNOTATION_REASON_CHARS`, then the budget, one at a time, and confirm 4.2 FAILS each time. Restore all three and record the three observed failures here. A ceiling test that cannot fail is documentation.
- [ ] 4.4 Confirm the guard does NOT depend on corpus size beyond the fixture's guarantees (it measures a bounded projection, so a larger corpus must not change the measured worst case) — run it against the 1.1 corpus and against a doubled one and record both figures.

## 5. Re-measure and state the outcome

- [ ] 5.1 Re-run the four measurements of 1.2 on the post-change build and record them beside the before-figures in the 1.3 table.
- [ ] 5.2 State the two numbers this change must produce: the **factor by which the worst-case annotation payload of a legal `memory.search` shrinks** (before/after), and the **post-change worst case in bytes, counting both copies `ok()` emits**. Both measured, neither computed.
- [ ] 5.3 Confirm the DEFAULT-request measurement also improved (the reason bound applies at the default too) and record it — this is the part of the fix that predates the regression.

## 6. Regression safety

- [ ] 6.1 Mutation check: remove the reason-bounding helper call from the search-row site only, and confirm 2.4 and 2.8 FAIL (asserting the edit matched before running, so "0 failures" cannot mean "matched nothing"). Restore and record the failure counts.
- [ ] 6.2 Mutation check: remove the budget check from the `memory.search` handler and confirm 3.5 FAILS; remove it from batch `memory.get` and confirm 3.7's `ids: 100 × 50` case FAILS. Restore and record.
- [ ] 6.3 Run the full suite and confirm no PRE-EXISTING test depended on a verbatim `reason` in a multi-row response or on the over-budget combination being served. Record the before/after `Tests N passed` counts with the SAME command (a root `pnpm test` count and an `apps/server` `npx vitest run` count are not comparable), and assert the delta equals exactly the number of tests added.
- [ ] 6.4 Confirm no SQL, repository, migration or derived-table change: `git diff --name-only` touches nothing under `apps/server/src/db/`.
- [ ] 6.5 Confirm no client work: `git diff --name-only -- apps/plugin/` is empty, and `grep -rn relations_limit apps/plugin/` still returns nothing. No tool input schema gained an argument, so none of the four clients needs a release.

## 7. Verification

- [ ] 7.1 `pnpm run typecheck` green.
- [ ] 7.2 `pnpm run lint` green.
- [ ] 7.3 `pnpm test` green, with the counts recorded per 6.3.
- [ ] 7.4 `pnpm run eval` green as a NON-REGRESSION check only, not as evidence: retrievers return ids and the annotation list is not scored at any `k`, so the harness cannot see this change (same reasoning as `order-relation-annotations` design D6). Baselines must be unchanged; do NOT run `--write-baselines`.
- [ ] 7.5 `npx openspec validate bound-annotation-response-size --strict` green.
- [ ] 7.6 `pnpm run check:spec-provenance` green — `openspec/specs/{memory,mcp-api}/spec.md` must NOT be edited in the implementation commit; the published text arrives at archive time.

## 8. Real Docker smoke against pre-existing seeded data (operator-run)

- [ ] 8.1 **Operator step.** Bring up the dev stack against a database seeded BEFORE this change (`pnpm run dev:docker:up`; if the host needs it, `chown -R 10001:10001 data-dev` first), so the annotations being read were written by the old build. Confirm the seed produced judged relations with reasons — if the seeder writes only short reasons, judge one relation over MCP with a 2 000-char reason first, so the smoke exercises the bound rather than a no-op.
- [ ] 8.2 `memory.search` at defaults over `/mcp/<slug>`: rows carry `relations` and `relationsTotal` as before, and the long reason arrives bounded with the ellipsis marker.
- [ ] 8.3 `memory.get` with the same memory's `id`: the same annotation's reason arrives verbatim.
- [ ] 8.4 `memory.search` with `limit: 200, relations_limit: 50`: rejected, with the error naming both parameters and a legal combination. Then run one of the legal combinations from 3.7 and confirm it is served.
- [ ] 8.5 Open `/dashboard/judgments` and confirm the full reason is still displayed there (the escape hatch the specs already point callers at).
- [ ] 8.6 Confirm the first boot after the upgrade ran no migration and rewrote nothing: no new migration file, and the `memory_relations` row count and `reason` values are unchanged.

## 9. Deferred and explicitly rejected — recorded so they are not lost

- [ ] 9.1 File a follow-up for the duplicate payload emission in `mcp/result.ts::ok()` (a `text` block plus `structuredContent` doubles EVERY MCP response; the MCP spec makes the text mirror a SHOULD). Attach the exact factor measured in 1.2. Design Open question 1 — deliberately not decided here, because dropping it needs compatibility evidence from all four clients.
- [ ] 9.2 Record that unbounded `content` is OUT of scope and why (design D8: data-derived, not schema-derived; a guard at `ok()` could only bound it by failing reads whose caller has no projection parameter to comply with). Do NOT add a guard in `ok()` as part of this change.
- [ ] 9.3 Record the rejected remedies with their reasons, so none is re-proposed as an obvious fix: silent clamping (D6), clamp-with-a-receipt (D6, the closest call — the fallback if field evidence shows frequent rejections), lowering the multi-row `relations_limit` maximum below 50 (D3), a byte-based pre-query budget (D3), and an aggregate cap enforced by shedding annotations from some rows (D3).
- [ ] 9.4 Leave design Open question 3 open (whether `ANNOTATION_REASON_CHARS` and `CONTEXT_SNIPPET_CHARS` should converge). Do not merge them in this change.
