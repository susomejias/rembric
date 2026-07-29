# WITHDRAWN — the `/dashboard/graph` memory-graph view is not shipped

> **Status: the graph view was built three times, measured, and withdrawn by the owner on render time. It is removed from the tree.** What ships from this change is Phase 1 — the memory detail page's `Judgments` section, specified and tier-ordered — plus two corrections to published requirements that were already factually wrong. Phase 2 (`/dashboard/graph`, its payload, its caps, its `admin*` reads, its dependency and its stylesheet) is deleted, and `design.md` keeps the measured ledger for all four renderers so nobody rebuilds it on an argument that was already tried.
>
> Owner's words, on the corpus that decided it: _"tarda muchísimo en renderizarse, si es muy pesado quitamos este render del grafo, no quiero perder más tiempo en esto ya, con 2k de memorias es casi 1 minuto esperando a renderizarse."_

## Why

Two independent things motivated this change, and only one of them survived contact with a production-shaped corpus.

**Phase 1 fixed a measured defect and is unrelated to any renderer.** The memory detail page's `Judgments` section shipped with no published contract and with no ordering rule beyond `created_at DESC`. That is not a cosmetic gap: 23% of result rows on a real corpus exhausted the 10-annotation bound the MCP side applies, and `listTouchingAny` carried **no `ORDER BY` at all** — so _which_ annotations survived the bound was SQLite scan order. A `conflicts_with` could silently never be shown. The fix is one shared comparator, and the operator surface has to consume the same one the agent surface does or the two rank the same memory's edges differently.

**Phase 2 wanted to show the corpus's shape and could not do it fast enough to be usable.** Degree, connected components and chain depth are properties of a graph; a paginated edge list renders one edge per row. That premise was never falsified. What was falsified is that any renderer this repo is willing to carry can draw a real partition in a time an operator will wait through. On the review corpus — **2 055 memories / 7 105 relations**, default selection **1 420 nodes / 3 555 edges** — the shipped renderer took **25.4 s** to settle, and 56 s at 2 039 nodes. That is the whole reason for the withdrawal.

## What Changes

### Ships: Phase 1 — the memory detail page's Judgments section gets a contract and an order

- **The section is specified for the first time**, describing what ships (`adminListTouching`, `not_conflict` excluded, kind / status / counterpart / timestamp, `data-href` row navigation, the `No judgments touch this memory.` empty state), so the operator's per-memory judgment view stops being undocumented behaviour.
- **Its rows are ordered by the tiered priority established in `order-relation-annotations`** — `conflicts_with` > `supersedes` > `superseded_by`, then `pending_conflict`, then `scoped` > `compatible` > `related`, then `created_at DESC`, then `judgment_id`. This change **consumes** `compareAnnotations` + `ANNOTATION_TIER` from `apps/server/src/services/relations.ts` and does not fork them; `RELATION_ANNOTATION_MAX`, `relationsTotal` and the `relations_limit` maximum belong to that change and are untouched here.
- **The section stays unbounded and unpaginated, deliberately.** `memory/spec.md` promises the annotations the MCP bound withholds are "visible via the dashboard", and this is the only per-memory judgment view in the product — capping it would falsify a published requirement. The heading carries the **degree** (the rendered row count) instead of a total, because with no cap a total restates the row count.
- **Rejected: adding a `memory` filter to `/dashboard/judgments` instead.** It would duplicate a section on the page the operator is already on, and it would order nothing.

### Ships: two corrections to published requirements that were already false

Both were found while reading the shipped code for Phase 2, and both remain true — and remain wrong in the published text — now that the graph is gone. Reverting them would republish a factually incorrect enumeration.

- **"No frontend build pipeline SHALL be required".** Its scenario says the browser runs "HTMX (vendored) plus inline scripts smaller than 2 KB each, embedded by the SSR shell for the timestamp upgrader and the sidebar toggle". `templates.ts` ships **six** shell scripts (`TS_UPGRADER`, `SB_COLLAPSE`, `MOB_TOGGLE`, `ROW_LINK`, `CONFIRM`, `MD_COPY`) and `update-modal.ts::MODAL_SCRIPT` a seventh, emitted per page in the body by a feature module rather than by the shell. Every one is under 2 KB; the enumeration of _purposes_ and of _who embeds them_ is stale. It is restated as the rule it was enforcing — no bundler, no transpiler, no framework, no CDN, no served first-party JavaScript file, first-party JS inline, hand-written and under 2 KB each — with the served third-party set enumerated as **exactly one** named, pinned, non-framework file (HTMX). **This is a narrowing of a stale enumeration, not a widening of a permission**; the two-library form this change once proposed is withdrawn with the renderer that needed it.
- **"The dashboard MUST be served at `/dashboard`".** It enumerates the served static assets as "(HTMX and Pico.css)". **Pico.css is not served and has not been for some time** — the only committed `.js` asset is `htmx.min.js` and the dashboard has its own CSS layers — so the sentence is false independently of this change. The requirement is restated to describe the asset _classes_ and to point at the frontend-pipeline requirement as the single place the library list is maintained, so it cannot go stale in two places at once. Nothing about the no-CDN rule or the bundled-in-the-package rule is weakened.

### Withdrawn: everything about `/dashboard/graph`

Removed from the tree, not left dormant: the route and its handler (`dashboard/graph.ts`), the payload module (`graph-payload.ts`), the stylesheet (`styles/views/graph.css`), the `04b GRAPH` nav entry and its icon, the `cytoscape` dependency and its `copy-assets.mjs` target, the `GRAPH_NODE_CAP` / `GRAPH_EDGE_CAP` config knobs and their boot log line, the five `adminGraph*` / `adminMemoryIdsForEntity` repository reads, the `jsonIsland` template helper, the `VIEW NEIGHBOURHOOD ›` link on memory detail, the `GRAPH ›` link on `/dashboard/judgments`, and the four test files that covered them.

**Kept:** `apps/server/src/dashboard/relation-filters.ts`. It was extracted by this change so `/dashboard/graph` and `/dashboard/judgments` could not come to mean different things by the same query parameter; with the graph gone it still serves `judgments.ts`, and it is a better shape than the hand-maintained `Set`s it replaced (a new `memory_relations.relation` value now cannot reach the database without reaching the filter bar).

**Do not re-propose an engine as the fix.** All four were built and measured, and the ledger is in `design.md`:

| renderer                                    | verdict                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Server-side SVG, deterministic BFS layering | **Illegible at 277 nodes** — a layered layout has no repulsive term between non-neighbours        |
| Cytoscape `cose` (what shipped)             | 3.5 s at 428 nodes · 13.5 s at 963 · **25.4 s at 1 420** · 56 s at 2 039, all blocked main thread |
| Cytoscape `fcose`                           | 3.2x at 428 nodes but **1.08x at 2 039**; `quality:'draft'` **throws** on a multi-component graph |
| sigma + ForceAtlas2 in a Web Worker         | ~50x faster, 40k nodes at 59 FPS on the owner's M5 — **rejected on complexity and appearance**    |

Also already argued and rejected: lowering the cap (that is the 900-node position, which forecloses drawing an ordinary partition), raising it, a lower `numIter`, and persisting a layout. A re-proposal has to answer the owner's judgement of the _rendering_, not produce a faster number — the fastest available number was already conclusive and was already rejected.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: one ADDED requirement specifying the memory-detail `Judgments` section and its tiered ordering (it ships today with no published contract at all), plus the two MODIFIED requirements above, both of which correct published text that is factually wrong about the shipped asset set. No requirement about a graph view, a canvas, a served rendering library, a payload or a cap is published.
- `data-access`: **no delta.** The three `admin*` graph reads this change originally added are deleted, so there is nothing left to specify.

`memory` is **not** modified: the tier order is `order-relation-annotations`' contract in that capability, and consuming it is not changing it. `memory-entities` is **not** modified.

## Impact

- `apps/server/src/dashboard/memories.ts` — the `Judgments` section sorted through the shared comparator; the heading carries the degree
- `apps/server/src/dashboard/memory-detail-hub.test.ts` — the ordering, degree and empty-state assertions
- `apps/server/src/dashboard/relation-filters.ts` — the shared kind/status filter vocabulary, now consumed by `judgments.ts` alone
- `apps/server/src/dashboard/judgments.ts` — reads its filter vocabulary from `relation-filters.ts` instead of two hand-maintained `Set`s
- `openspec/specs/dashboard/spec.md` — published at archive time only (`pnpm run check:spec-provenance` is CI-gated)

**Existing installations**: no migration, no schema change, no new index, no derived-index invalidation, no new env var and no new dependency. The detail page's `Judgments` rows appear in a new deterministic order over unchanged rows. Removing the graph is a plain image upgrade: the route 404s, the nav entry and the served library disappear, nothing was ever written so there is nothing to undo, and an installation that had set `REMBRIC_GRAPH_NODE_CAP` or `REMBRIC_GRAPH_EDGE_CAP` gets them ignored rather than rejected — `config.ts` does not reject unknown env vars.

**Invariants**: append-only untouched — every read is a `SELECT`, and the change adds no mutation verb, no form and therefore no `data-confirm` modal. Scope-at-service-layer untouched. `topic_key` convergence, fresh-context judgment and the derived-never-stored review discipline are all untouched. No new MCP tool, no plugin file, no HTTP API route and no design token, so no work across the four clients.
