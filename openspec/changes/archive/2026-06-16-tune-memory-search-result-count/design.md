## Context

Hybrid search (dense ⊕ FTS via RRF) is live in `memory.search`. The retrieval already follows "fetch wide, return narrow": each branch over-fetches into a bounded `rank_window_size = min(limit + offset + margin, RANK_WINDOW_CEILING)`, RRF fuses the ranked id lists, and the result is sliced to `limit`. The only knob that was never aligned with retrieval norms is the **default** `limit` when the caller omits it: `clampLimit(undefined)` returns 20 (`apps/server/src/services/memory.ts`). A live query returned 20 rows padded with distant memories; the user flagged it as too many.

## Goals / Non-Goals

**Goals:**

- Default `memory.search` result count aligned with the industry norm (final top-k ~3-10, saturating ~10).
- The default lives in one named constant, not a magic literal.
- Zero risk to the recently-shipped cross-lingual recall.

**Non-Goals:**

- Changing explicit-`limit` behavior, the clamp bounds (`[1, 200]`), the rank window, RRF, the FTS branch, or the dense kNN.
- Adding a similarity/cosine threshold on the dense branch (see "Deferred" below).
- Any reranker, migration, MCP tool-shape change, or dashboard change.

## Decisions

**D1 — Default `DEFAULT_SEARCH_LIMIT = 8`, applied to both search modes.** `clampLimit` is shared by the hybrid text-query branch and the no-query chronological listing, so the single constant moves both defaults in lock-step. 8 over 5: there is no reranker, so RRF ordering near the top is imprecise; a slightly higher final count hedges that without re-entering the noise zone (still ≤ the ~10 saturation point). Over a hardcoded 20: the observed padding is the recall-first design overshooting a small useful set.

**D2 — A one-line value change, not a structural one.** The "fetch wide, return narrow" machinery already does the right thing; only the returned count was miscalibrated. Extracting the literal to `DEFAULT_SEARCH_LIMIT` makes the contract greppable and keeps it from silently drifting back.

**D3 — Encode the default in the spec.** The default page size is observable MCP behavior (omit `limit` → get N rows). Specifying it (vs. leaving it an implementation detail) keeps the contract honest and prevents a silent revert.

## Risks / Trade-offs

- **A caller relying on the old 20-row default gets 8.** Mitigation: callers that need more pass an explicit `limit` (unchanged, up to 200). The MCP `memory.search` page just gets smaller by default — the intended effect. Audit `memory.test.ts` and any in-repo caller for an implicit-20 assumption.
- **Performance:** lowering the default does NOT speed up the core retrieval (query embed + kNN partition scan + FTS scan are driven by in-partition corpus size, not by the returned count). It marginally shrinks the rank window (~50→~38 candidates/branch) and row hydration (≤20→≤8 rows + per-row review-state). The real win is downstream: a smaller payload means the consuming LLM ingests less context → faster, cheaper, less-noisy answers. We should not advertise this as a retrieval speedup.

## Deferred: cosine-distance floor on the dense branch

The original intuition was to also trim semantically-distant dense neighbors with a cosine floor before fusion (the distance is already returned by `knnByQueryVector`, so the filter is free). It is **deliberately deferred**, not abandoned, because:

- It reverses prior decision **D3 of the hybrid-search change** ("No similarity thresholds on the search vector branch"), whose stated rationale is precisely the weak cross-lingual match (cosine ~0.6) that this project shipped support for.
- The calibration bands overlap: unrelated pairs sit at cosine similarity ≈ 0.43-0.68, while legitimate weak/cross-lingual matches sit ≈ 0.6 — some junk is _closer_ than some real matches, so no floor cleanly separates them. Only a far-tail floor (cut similarity < ~0.40, i.e. distance > ~0.60) is safe, and it would remove at most a couple of filler rows inside an already-small top-8.
- The bulk of the observed noise (ranks 9-20) disappears just by lowering the default. Measure first.

**Re-open criteria:** if real-world top-8 results still show an obvious far-tail of unrelated rows, add a follow-up change for a conservative far-tail floor (similarity < ~0.40), with the value tuned empirically against the existing real-embedder cross-lingual test so no legitimate match is dropped. That refines the prior decision from "no threshold" to "no recall-capping threshold; a noise floor well below the weakest useful match is permitted."
