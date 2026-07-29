# Design — WITHDRAWN renderer, shipped Phase 1

> **This document is a rejection record.** The `/dashboard/graph` view was built three times over one production-shaped corpus, measured each time, and withdrawn by the owner on render time. Everything below the "What shipped" section exists so that the measurements are not lost and so the same view is not rebuilt in six months on an argument that was already tried and recorded. **The four-engine ledger and the trilemma are the valuable residue — read them before proposing any graph rendering in this repo.**

## Context

The **memory graph** — memories as nodes, judgment verdicts as edges — is fully browsable and not at all visible. `/dashboard/judgments` pages 50 **edges** at a time with a true total, filters on status and kind, and a detail page carrying both memories' content plus the agent's `reason` and `evidence`. The information is complete; the shape is absent, because degree, connected components and chain depth are properties of a graph and a paginated edge list renders one edge per row.

**That premise was never falsified and is not what killed the view.** What killed it is that no renderer this repo is willing to carry draws a real partition in a time an operator will wait through. The vocabulary is still load-bearing wherever it appears below: **node = memory, edge = judgment verdict**.

Two facts about the shipped code set the boundaries, and one of them is why Phase 1 exists at all.

**The per-memory judgment list already exists and was unspecified.** `dashboard/memories.ts` calls `repos.relations.adminListTouching(row.id)`, whose SQL is `listTouching`'s predicate plus the admin content join, `not_conflict` excluded, `ORDER BY created_at DESC`, **unbounded**. Grep across all of `openspec/` for `adminListTouching`, for the empty-state string, and for any per-memory judgment requirement returned nothing — so Phase 1 is an ADDED requirement (specify what ships, then fix its ordering), not a MODIFIED one. The defect it fixes is measured and independent of any renderer: 23% of result rows on a real corpus exhausted the MCP side's 10-annotation bound while `listTouchingAny` carried no `ORDER BY` at all, so which annotations survived was SQLite scan order and a `conflicts_with` could silently never be shown.

**The whole-partition read shape is already measured slow.** `tune-hot-query-paths` records `relations.adminListWithContent({})` at **115.6 ms at 50k rows**, in one synchronous better-sqlite3 connection where a slow query stalls every MCP client, the HTTP API, the dashboard and `/healthz` together. That number is why the withdrawn design counted before it fetched, and it is worth keeping in view for any future whole-partition read.

## What shipped

Two things, and no more.

1. **Phase 1** — the memory detail page's `Judgments` section, specified for the first time and ordered through the one shared comparator (D1, D2).
2. **Two corrections to published requirements that were already factually wrong** about the dashboard's served asset set (D-SPEC).

## What was withdrawn, and the decision behind it

Reviewed on the corpus in `data-dev`: **2 055 memories / 7 105 relations**, one dominant partition, with the landing defaults (memory `active`, relation `judged`, all kinds) selecting **1 420 nodes / 3 555 edges**.

The shipped renderer — Cytoscape `cose`, animated in the main thread, concealed behind a settling indicator — took **25.4 s** to settle that default selection, and 56 s at 2 039 nodes. The owner withdrew the view rather than continue tuning it:

> _"tarda muchísimo en renderizarse, si es muy pesado quitamos este render del grafo, no quiero perder más tiempo en esto ya, con 2k de memorias es casi 1 minuto esperando a renderizarse."_

**This is a decision on cost, not a bug report.** The view worked, drew correctly, degraded correctly without JavaScript, refused correctly above its caps, and was legible once settled. It was withdrawn because settling took a minute on an ordinary corpus and three engines had already failed to fix that.

## The four-engine ledger — measured, not argued

Every row was implemented and measured, not read about. **All timings below are from a GPU-less container** (WebGL through SwiftShader), so frame rates are a floor and never a forecast; settle times are CPU-bound and more transferable, but they are still this container's.

| Renderer                                                                   | Verdict                                  | Measured                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-side SVG, deterministic BFS layering**                            | **Failed — illegible**                   | A hairball inside a grid of vertical columns at **277 nodes / 554 edges** (one ordinary filter selection). Edges cross without pattern, layer bands read as arbitrary columns, no hub, component or chain is perceptible. Also inert: no hover, no drag, no label.                                                                                                                  |
| **cytoscape 3.34.0 + `cose`** (what shipped)                               | **WITHDRAWN by the owner — too slow**    | Settle: **3.5 s at 428/1 504 · 13.5 s at 963/3 324 · 25.4 s at 1 420/3 555 · 56.2 s at 2 039/7 104.** 4.8x the nodes costs 16x the time, all of it blocked main thread. Node count dominates — `cose`'s repulsion term is pairwise.                                                                                                                                                 |
| **cytoscape + `fcose`**                                                    | **REJECTED — measured, do not retry**    | 3.2x faster at 428 nodes (3 489 → 1 124 ms) and **only 1.08x at 2 039** (56 169 → 51 865 ms): the spectral draft helps in the small, the force refinement dominates at scale. Its `quality: 'draft'` mode **throws** (`Cannot read properties of undefined (reading 'nodeIndexes')` in `relocateComponent`) on a multi-component graph, and this graph always has several.          |
| **sigma 3.0.3 + graphology 0.26.0 + graphology-layout-forceatlas2 0.10.1** | **REJECTED by the owner — not on speed** | FA2 + Barnes-Hut: **1 081 ms at 2 039/7 104** against `cose`'s 56 169 — **~50x** — 3 024 ms at 5 000, 6 945 ms at 10 000, 15 809 ms at 20 000, near-linear where `cose` was not; sigma's first render 42 ms at 10 000 nodes. Off the main thread on the owner's M5: **40 000 nodes / 140 000 edges, 59 FPS, 17 ms p50 main-thread frame** while still laying out, no ceiling found. |
| **vis-network**                                                            | rejected on paper — styling              | Viable; a more opinionated appearance means more of the brutalist palette is fought rather than fed in.                                                                                                                                                                                                                                                                             |
| **d3-force**                                                               | rejected on paper — wrong layer          | Supplies the layout only, leaving hit-testing, hover, drag, camera and labels hand-written. The interaction was the point.                                                                                                                                                                                                                                                          |

**Why sigma was rejected despite winning on every number**, because this is the part a re-proposal has to answer:

1. **Complexity.** Three direct packages plus three transitives (`events@3.3.0`, `graphology-utils@2.5.2`, `graphology-types@0.24.8`) — six MIT packages against Cytoscape's one zero-dependency package; an `esbuild` invocation in `apps/server`'s build to convert a CJS-only `worker.js` into a `<script>`-loadable IIFE; four served asset files instead of two; a layout supervisor with **no stop condition of its own**, hence a three-bound stop ladder (iteration budget, wall-clock ceiling, rolling-median frame-time governor) plus an operator STOP control; two graphology graphs to decouple the paint rate from the iteration rate; and hand-written drag, hover reducers and camera clamping, because sigma supplies no stylesheet, no drag and no layout scheduling. Each piece was justified individually. Together they are a machine, built for a corpus size no operator has reported.
2. **Appearance.** sigma cannot draw a dashed stroke at all (the string `dash` occurs nowhere in the package), so the encoding's third channel had to become edge **geometry** — hairline, band, taper, bow — and the drawing read as busier rather than clearer. A view whose whole purpose is legibility cannot be adopted on a benchmark over the owner's own reading of it.

## The trilemma — the finding that generalises

**High cap · Cytoscape · no visible animation: you can have two.**

- **Cytoscape + no visible animation** ⇒ **low cap.** `cose` animated in the main thread puts its collapsing intermediate frames on screen, which reads as the page rendering twice, so the drawing has to be concealed until `layoutstop`. Concealing it converts settle time into a blank wait, and a wait an operator will sit through caps the selection near **900 nodes** — which forecloses drawing an ordinary partition.
- **Cytoscape + high cap** ⇒ **visible animation, or a one-minute spinner.** At 1 420 nodes that is 25 s of concealed canvas; at 2 039, 56 s. The alternative is to show the collapse, which is the defect the concealment exists to fix.
- **High cap + no visible animation** ⇒ **not Cytoscape.** It needs an off-thread engine, which is exactly the sigma/FA2 build — rejected on complexity and appearance.

There is no fourth corner, and that is why the view is withdrawn rather than retuned. Every lever that was tried moves along one edge of this triangle: the cap (both directions), `numIter`, `fcose`, the concealment rule, the fit, the layout density constants. None of them leaves the triangle.

## Decisions that survive, because they describe shipped code

### D1. Phase 1 consumes `order-relation-annotations`' comparator; it does not fork it

The tier list and the total-order tiebreak are that change's contract, exported from `apps/server/src/services/relations.ts` as `ANNOTATION_TIER` + `compareAnnotations`. The dashboard imports the export. If the two surfaces sorted by different rules, the operator page and the agent's `relations[]` would rank the same memory's edges differently, which is the disagreement that change exists to prevent.

The comparator takes `{ view: RelationView; createdAt: Date; judgmentId: string }`, so the dashboard builds that shape per row rather than passing raw rows. `view.kind` is **POV-dependent** (`supersedes` vs `superseded_by` depends on whether this memory is the source), which is why the order is applied in TypeScript and **not** as an `ORDER BY` on `adminListTouching`: the POV derivation is not a column.

Only the comparator is consumed. `RELATION_ANNOTATION_MAX`, `relationsTotal` and the `relations_limit` maximum of 50 are that change's contract and are neither read nor described here.

### D2. The detail section stays unbounded, and reports degree instead of a total

`memory/spec.md` promises the annotations withheld by the MCP annotation bound remain "visible via the dashboard", and this section is the only per-memory judgment view the dashboard has — `/dashboard/judgments` has no memory filter. A cap here would falsify a published requirement, so there is none, and the sort site carries a one-line comment recording that, because it is exactly the kind of non-obvious invariant a future cleanup would "fix".

With no cap, a `relationsTotal`-style figure would restate the rendered row count. The heading carries the **degree** instead — the number of rows rendered.

_Rejected:_ a `memory` filter on `/dashboard/judgments`. It would duplicate a section on the page the operator is already on, and it would order nothing. `/dashboard/judgments` is also **not** renamed: it is correctly named, being a list of judgments.

### D-SPEC. Two published requirements are corrected rather than left false

Both were found by reading the shipped code, both are independent of the graph, and both remain wrong in the published text now that the graph is gone.

**"No frontend build pipeline SHALL be required".** Its scenario says the browser runs "HTMX (vendored) plus inline scripts smaller than 2 KB each, embedded by the SSR shell for the timestamp upgrader and the sidebar toggle". `templates.ts` in fact emits **six** shell scripts — `TS_UPGRADER` (1011 B), `SB_COLLAPSE` (1276 B), `MOB_TOGGLE` (1234 B), `ROW_LINK` (1154 B), `CONFIRM` (1801 B, the `data-confirm` modal), `MD_COPY` (1890 B) — and `update-modal.ts::MODAL_SCRIPT` (1150 B) is emitted **per page in the body** by a feature module, not by the shell. Every one is under 2 KB; the enumeration of purposes and of who embeds them is simply stale. Restated as the rule it was enforcing, with the served third-party set enumerated as **exactly one** named, pinned, non-framework file. **This is a narrowing of a stale enumeration, not a widening**: the two-library form this change once proposed is withdrawn with the renderer that needed it, and the 6 KB view-module budget it asked for is withdrawn too — no view module ships a script.

**"The dashboard MUST be served at `/dashboard`".** It enumerates the served static assets as "(HTMX and Pico.css)". **Pico.css is not served and has not been for some time**: the only committed `.js` asset is `htmx.min.js`, and the dashboard has its own CSS layers built by `build-css.mjs`. The sentence was false before this change touched anything. **Decision: keep the correction.** Reverting to the published wording would republish a factually wrong enumeration; the drift is real whoever found it. The requirement is restated to describe the asset _classes_ and to point at the frontend-pipeline requirement as the single place the library list is maintained, so it cannot go stale in two places at once. Nothing about the no-CDN rule or the bundled-in-the-package rule is weakened.

Also corrected in passing, and worth keeping because it is easy to get wrong again: first-party JS is **not** served through `assets.ts`. `HASHED_RE` does match `.js`, so the absence of hashing is a property of the filenames rather than of the middleware — but nothing generates a first-party JS asset and `build-css.mjs` hashes CSS only, so a served first-party script would fall outside `HASHED_RE` and be cached `max-age=3600`. Inline therefore remains the rule for first-party code.

## Measurements kept on the record

Preserved because they cost real time to obtain and are about the **read path**, which is unchanged by the withdrawal — so they remain usable evidence for any future whole-partition dashboard read.

**Count-before-fetch is cheap and a fetch is not.** The refusal decision (a selection count plus one isolate `COUNT`, no rows) measured **1.48 ms** one row over the cap, 2.21 ms at 1 200/2 000, 15.65 ms at ten times the caps, 57.54 ms at 30 000/50 000 — a function of **corpus size**, not of any cap constant, and still several times cheaper than the 115.6 ms `adminListWithContent({})` fetch it existed to avoid.

**A node count as a correlated `EXISTS` beats the `UNION` form, measured rather than assumed.** `EXISTS` 1.05 / 3.48 / 7.08 ms at 900 / 3 000 / 9 000 nodes against `UNION`'s 1.69 / 5.88 / 12.05 ms, both returning the identical count. Plans: `EXISTS` → `SCAN n` + `CORRELATED SCALAR SUBQUERY` with `MULTI-INDEX OR` over the two endpoint indexes; `UNION` → `MERGE (UNION)` with two `USE TEMP B-TREE FOR ORDER BY`.

**A measurement trap that nearly produced a fabricated defect, and will again.** In a **fresh** test database that same decision reads **1 760 ms** at ten times the cap, which looks like a stall of the shared synchronous connection. It is a harness artefact: `db/client.ts` runs `ANALYZE` at boot, and with those statistics the planner picks the `MULTI-INDEX OR` plan; without them it falls back to a per-node scan of `memory_relations`, which is O(nodes × edges). **Any new bench must mirror the boot-time `ANALYZE`**, exactly as `review-reads.bench.test.ts` already does. No query was rewritten and no index was added on account of that number.

**Response bytes, if a whole-partition dashboard read is ever proposed again.** ≈**333 B per drawn element**, of which a server-rendered node/edge list was **73%** — 798 KB total at 2 000/7 000 = 191 KB payload + 582 KB list. A JSON payload island was about **half** the size of the SVG it replaced at the same selection (127 KB against 244 KB at 600/1 000), while the _total_ response was 2.2x larger, because the list is a second serialisation of the same selection.

**Two index legs, no new index.** Both hop legs were index-served by the existing `memory_relations_source_status_idx (source_id, status)` and `memory_relations_target_status_idx (target_id, status)`. The shape that mattered: **two `IN (…)` legs, one per endpoint column** — with a single `source_id IN (…) OR target_id IN (…)` predicate SQLite drives from the joined `memory` aliases and scans. `EXPLAIN QUERY PLAN` showed `SEARCH` on both legs, no `SCAN memory_relations`. `memory_entity_links` is `PRIMARY KEY (entity_id, memory_id) WITHOUT ROWID`, serving an entity seed as a PK-prefix scan; `memory_scope_project_status_idx (scope, project_id, status)` serves a per-partition memory count.

## Lessons worth more than the view

**A falsifier evaluated only on synthetic data has not been evaluated.** The server-side SVG renderer's own falsifier was "a node cap high enough that the deterministic layout stops being legible". It was checked at the cap against synthetic fixtures and judged not to fire. On a production-shaped corpus it fires at **277 nodes**, and it was already firing at **35** — the earlier note admitting "a readable node at the fitted scale was in fact already failing at 35 nodes, not only at the cap" was read as cosmetic three separate times.

**A benchmark on the serving machine says nothing about the client.** The same synchronous FA2 measured **7x slower on the owner's M5 than in this container**. Layout cost is the client's, and the client is the one machine the answer depends on.

**Fixing the wrong axis completely proves it was the wrong axis.** Layer wrapping bounded a BFS-layered component's aspect ratio from 0.011 into `[0.85, 1.53]`, proved over a 3..301-spoke sweep with before/after captures — and left the drawing exactly as unreadable, because aspect was never the binding problem. The binding problem was the absence of a repulsive term between non-neighbours, which a layered layout does not have.

**The server/client line was drawn in the right place, and that is reusable.** The payload contract — nodes as `{id, title, status, degree, bucket}`, edges as `{id, sourceId, targetId, kind}`, meta as counts, and **no coordinate, colour or pixel size** — survived server-side SVG → Cytoscape canvas → sigma/WebGL → back to Cytoscape **without a field changing**, because everything in it is a fact about the selection rather than about the drawing. If a graph view is ever built again, start from that contract.

**Refuse rather than truncate, if a bounded view is ever built again.** A truncated graph inverts every one of its own justifications: a hub whose edges were cut reads as a leaf, a component whose members were cut reads as isolated, a chain whose middle was cut reads as two unrelated memories. Sampling is worse than truncation because it looks deliberate. The escape hatch for a corpus too large to draw whole is a **declared** subgraph (seed plus hops), never a silent slice.

## What a re-proposal must answer

Not a checklist to satisfy on paper — these are the specific things that were already tried and recorded.

- **Speed numbers are not evidence.** The fastest available engine was measured at ~50x and was rejected. A re-proposal must produce a **rendering the owner judges at least as legible**, on the owner's own corpus, before any timing is discussed.
- **`fcose` is closed.** 1.08x where it was needed, and `quality:'draft'` throws on a multi-component graph.
- **Lowering the cap is closed.** That is the ~900-node position, and it forecloses drawing an ordinary partition.
- **A `kind=related` landing default is closed.** `related` was 79.5% of the review corpus's edges, so it looks like the obvious noise filter, but it hid all **42** `conflicts_with` edges in the default selection — the highest-value edge in the product — and the noise it was meant to suppress is what a force layout suppresses instead.
- **A re-proposal must leave the trilemma, not move along it.** If it keeps a main-thread iterative layout, it inherits the concealment-versus-cap tension exactly as measured above.
- **It must not reintroduce a served rendering library under the corrected frontend-pipeline requirement.** That requirement now enumerates exactly one served third-party file; a second one is a new OpenSpec change with its own argument.

## Rejections carried forward unchanged

These were decided on their own merits and are not consequences of the withdrawal.

- **Precomputing or caching a graph payload, a layout or a node position** — derived state needing invalidation on every judgment, against the derived-data closure property `record-graph-retrieval-rejection` publishes and against the repo's "review state is derived, never stored" discipline.
- **A created-after / date-range filter on any graph view** — a time window fragments components, manufacturing "isolated clusters" that are artifacts of the window rather than of the corpus. It breaks the isolated-cluster signal while appearing to serve it.
- **`needsReview` as a SQL filter** — derived per node at read time in `services/review.ts`, so it cannot be a predicate; as a filter it would require fetching a partition before any count could govern a refusal. It belongs as an encoding, not a filter, and an encoding needs no predicate.
- **Multi-hop traversal for _retrieval_** — `record-graph-retrieval-rejection` and `memory-entities/spec.md` foreclose LLM-built graph retrieval. Nothing here was ever scored or fed into ranking.
- **Graph editing from a drawing** — re-judging an edge from a canvas. Any future view stays read-only, so it adds no mutation verb and no `data-confirm` modal.
