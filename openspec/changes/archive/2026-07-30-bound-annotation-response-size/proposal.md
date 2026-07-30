## Why

`order-relation-annotations` (shipped 2026-07-29) made the per-memory annotation bound
caller-settable: `relations_limit`, max `RELATION_ANNOTATION_MAX = 50`. It bounded the ROW and
left the RESPONSE unbounded. `memory.search` accepts `limit` up to 200 independently, batch
`memory.get` accepts 100 `ids` independently, and the two bounds never meet — so the largest
legal request projects **200 × 50 = 10 000 annotations** in one tool result, up from the 2 000
the hard-coded bound of 10 allowed before that change. The regression is 5×, and it is a direct
consequence of making the bound caller-settable without giving the response a budget.

The size follows from `reason`, which `memory.judge` / `memory.compare` accept at up to 2 000
characters (`mcp/relations-tools.ts`) and which the annotation projection emits verbatim.
Arithmetic puts one pretty-printed annotation at ~2.1 KB, so the worst case is **~20 MB of
JSON**, and `mcp/result.ts::ok()` emits every payload TWICE (a `text` block plus
`structuredContent`), which puts **~40 MB on the wire**. Those figures are estimates and this
change treats them as a hypothesis: task 1 builds the pathological corpus and measures the real
bytes at every surface before any bound is chosen.

Two facts make this worse than "a caller asked for a big response":

1. **The documented recipe produces the worst case.** The published requirement obliges the
   `relations_limit` description to teach `min(relationsTotal, 50)`. An agent that follows it on
   a search it had already widened to `limit: 200` lands on the ceiling by doing exactly what the
   tool told it to. No hostile caller is required.
2. **Even bounding the count is not enough, and neither is bounding `reason` alone.** At the
   pre-regression default (200 × 10) verbatim reasons already reach ~4 MB pretty / ~8 MB wire;
   with `reason` bounded and the count left alone, 10 000 annotations still carry ~1.3 MB of
   pure scaffolding. Both terms have to be addressed, which is why this is a change and not a
   one-line clamp.

There is **no response-size guard anywhere in the MCP surface today** — `ok()` serializes
whatever it is handed, and the only size-shaped requirement in the specs is
`DESCRIPTION_MAX_LENGTH`, which bounds tool DESCRIPTIONS. A tool result larger than the caller's
context window is not a degraded answer, it is a guaranteed overflow of the thing the memory
server exists to protect.

Every candidate remedy contradicts something published on 2026-07-29, so the fix has to be
argued rather than applied. `design.md` D1–D4 record the choice; D6–D8 record what was rejected.

## What Changes

- **Bound `reason` in multi-row annotation projections.** `memory.search` result rows and batch
  `memory.get` project each judged annotation's `reason` through the shipped `snippet()` helper
  at a named constant (`ANNOTATION_REASON_CHARS`, proposed value 350 — the number
  `CONTEXT_SNIPPET_CHARS` already ships for every other multi-item text projection, so no new
  number is invented). Single-id `memory.get` keeps `reason` VERBATIM: it returns one memory, its
  exposure is 50 annotations rather than 10 000, and it is the drill-down destination the
  truncation needs. The dashboard is untouched — it reads `adminListWithContent`, not the
  annotation projection, so the full reason stays visible where the spec already points callers.
  Chosen over truncating at write time, which append-only forbids.
- **Give the response an aggregate annotation budget.** A new
  `RELATION_ANNOTATION_RESPONSE_BUDGET` bounds `rows × per-row annotation bound` for the
  multi-row surfaces. Proposed value **2 000 = 200 (`limit` max) × 10 (the shipped multi-row
  default)**, i.e. exactly the worst case the server already serves when nobody passes anything
  — so no default request can ever be rejected, and the ceiling introduces no payload regime
  that is not already shipping. **BREAKING** for two currently-permitted requests:
  `limit > 40` with `relations_limit: 50`, and `ids: 100` with `relations_limit: 50`.
- **Over-budget is REJECTED, not clamped**, with an `invalid_input` naming both parameters and
  the legal trade (`limit: 40 × 50`, `limit: 200 × 10`, or drill in with single-id `memory.get`).
  This keeps the per-row maximum of 50 and the "rejected, not clamped" idiom the published
  requirement established, and adds one aggregate rule in the same idiom — the cheapest of the
  three contradictions available. Silent clamping is rejected in D7; so is clamp-with-a-receipt.
- **The worst case becomes CI-asserted rather than reasoned about.** A test constructs the
  largest LEGAL request at all three annotation surfaces, invokes the real tools, and asserts the
  serialized `CallToolResult` (both copies `ok()` emits) stays within a named byte ceiling. Same
  shape as the `DESCRIPTION_MAX_LENGTH` guard: a named ceiling, measured over a real response,
  and a rule that a future change colliding with it must either fit or raise the ceiling and
  record the re-verification.
- **Two published inaccuracies inside the requirements being restated are corrected**, not
  expanded: the annotation body is `reason` + `confidence`, never "a short snippet of the
  target's content"; and the surviving annotations are the highest-PRECEDENCE ones, not "the 10
  most recent" (which has contradicted the tier ordering since `order-relation-annotations`).
  See design D5.

## What does NOT change

No input schema gains an argument, so **no plugin work across the four clients**:
`git ls-files apps/plugin/` must be untouched, and `grep -r relations_limit apps/plugin/` is
already empty (no shipped client sends it). No migration, no schema change, no derived-table
invalidation, no `EXTRACTOR_VERSION` / embedding-recipe bump. `RELATION_ANNOTATION_MAX` stays 50;
the per-surface defaults stay 10 / 10 / 50; the annotation ORDER and `relationsTotal` are
untouched. Unbounded `content` is deliberately out of scope (D8): it is data-derived, not
schema-derived, and its remedy (`snippet`, `fields`) already ships.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: the annotation bound/total requirement gains the aggregate response budget and the
  rejection rule; the annotation-body description is corrected and the `reason` bound stated; a
  new requirement makes the worst-case annotation payload a named, CI-asserted ceiling.
- `memory`: the annotation requirement states that the annotation BODY may be bounded per
  surface while ordering, bound semantics and total stay identical; the constants requirement
  gains `ANNOTATION_REASON_CHARS`, `RELATION_ANNOTATION_RESPONSE_BUDGET` and the payload ceiling.

## Impact

Code:

- `apps/server/src/services/relations.ts` — declare `ANNOTATION_REASON_CHARS` and
  `RELATION_ANNOTATION_RESPONSE_BUDGET` beside `RELATION_ANNOTATION_MAX` (the constants' single
  home; no SQL, no repository change).
- `apps/server/src/mcp/_shared.ts` — one shared helper that bounds an annotation list's reasons,
  so the two multi-row call sites cannot drift.
- `apps/server/src/mcp/memory-tools.ts` — apply the helper at the search-row and batch-`get`
  annotation sites (NOT the single-id site); add the pre-query budget check to both handlers;
  extend the `relations_limit` description with the aggregate rule.
- Tests: `apps/server/src/services/relations.test.ts`,
  `apps/server/src/mcp/memory-tools.test.ts`, `apps/server/src/test/mcp-integration.test.ts`
  (protocol-level rejection + the payload-ceiling guard).

Not affected: `db/` (no query changes), `dashboard/` (reads a different projection),
`server/api-router.ts` (the HTTP surface projects no annotations), `apps/plugin/**`,
`consolidation/`, every migration.

Invariants touched: none of the load-bearing five. Append-only is respected precisely BECAUSE
the bound is a read projection — stored `reason` text is never rewritten — and a rollback
therefore loses nothing.
