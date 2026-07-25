## Why

`memory_relations` is a graph of **judgements** between memories — supersedes, conflicts, related — not a graph of what memories are _about_. There are zero entities anywhere in the server. For a memory system serving coding agents, that is the most consequential absence: the agent cannot ask "what do I know about this file", "what have I learned about this package", "have I seen this error code before" — even though those are the questions it has an exact key for, and they are the questions it asks right before making a change.

The reason this matters more than it looks is a defect the audit reproduced. Hybrid search is worst precisely on **exact-identifier** queries: a file path, a symbol name, an error code, a ULID. The dense branch, given one or two rare tokens, returns a window of vaguely-related neighbours that does not include the row containing the token; the lexical branch nails it at rank 1; and the fusion constants then let any row appearing in both windows outscore it. `fix-retrieval-ranking-math` corrects the arithmetic, but the deeper point stands: **ranking is the wrong mechanism for a question that has an exact answer.** An entity index makes those lookups an index hit rather than a scoring contest — no fusion, no window, no threshold.

## What this change is NOT

There is evidence against the obvious version of this idea, and it should be stated up front rather than discovered later. In its own author's published benchmark, a triple-stream retriever (BM25 + vector + graph) scored **worse** than BM25 alone — Recall@5 36.8% versus 43.8%, and worse on NDCG@10 and MRR. A 2026 survey of long-term dialog memory reaches a compatible conclusion, that observed differences are driven more by foundational system settings than by architectural additions.

So this change does **not** add a graph stream to RRF fusion. That specific use is the one the evidence condemns, and it stays out until the eval harness shows a measured win. What the evidence does not touch, and what this change delivers, are three different jobs:

1. **Exact-address retrieval** — an index lookup keyed on an entity, not a ranked query.
2. **A second recall channel for save-time conflict detection** — entity overlap finds contradictions that text and vector similarity both miss.
3. **A precise seed for context relevance** — entity overlap from the working directory and the files a session touched, instead of embedding a path string as if it were prose.

## What Changes

- **Deterministic entity extraction at save time.** No LLM, no model, no inference. Only things with syntax that can be recognised with confidence: file paths, git refs, package names, error codes and identifiers, URLs, and ticket-style ids. Extraction is a pure function of `title + content`, runs inside the existing save transaction, and its failure never fails a save.
- **Two new tables.** `memory_entities` (the normalised entity, its kind, and its scope) and a link table joining memories to entities. Both are derived data reconstructible from the append-only primary rows, in the same class as `memory_vec` and `memory_fts` — which is what licenses a rebuild path.
- **An `entity` filter on `memory.search`, and no new tool.** `memory.search({ entity: 'apps/server/src/db/migrate.ts' })` returns every memory linked to that entity in scope, chronologically, bypassing ranking entirely. Read projections gain an `entities[]` field so the agent can see what a memory is about and pivot from it. The MCP tool count is unchanged — the audit measured four confusable tool clusters and ~31 KB of `tools/list` resident every turn, so adding tools here would cost more than it buys.
- **Entity overlap as a save-time candidate source.** A new memory sharing a rare entity with an existing one is a candidate even when neither the lexical nor the dense branch surfaces it — the "use `chown 10001`" versus "run as root" case, where two contradictory memories about the same file share almost no vocabulary and sit far apart in embedding space. Candidates carry their source, so `entity` joins `fts` and `vec` as a labelled channel.
- **An entity-derived seed for `memory.context` relevance.** When the relevance channel derives its own seed, entities extracted from the session's working directory take precedence over embedding the path as text.
- **A rebuild path and an integrity check.** Both tables are recomputable from `memory` alone; the doctor report gains a link-count delta so drift is visible.
- **Operator visibility.** The dashboard exposes which entities carry the most accumulated knowledge — and, more usefully, which files in the project have none.

## Capabilities

### New Capabilities

- `memory-entities`: deterministic extraction of syntactically-recognisable entities from memory text, a scoped index over them, exact-address retrieval, and entity overlap as a conflict-detection channel.

### Modified Capabilities

- `mcp-api`: `memory.search` accepts an `entity` filter; memory-returning reads expose `entities[]`; save candidates may carry `source: 'entity'`.
- `memory`: entity overlap is an additional save-time candidate channel alongside lexical and dense similarity.
- `persistence`: two new derived tables, with a documented rebuild path.
- `dashboard`: an entity view.

## Impact

New:

- `apps/server/src/services/entities.ts` — the extractor (pure, exhaustively unit-tested)
- `apps/server/src/db/schema/entities.ts`, `apps/server/src/db/repositories/entities-repository.ts`
- a migration creating both tables plus a backfill over existing memories
- `apps/server/src/dashboard/entities.ts`

Touched:

- `apps/server/src/services/memory.ts` — extraction inside the save transaction; the `entity` filter
- `apps/server/src/services/save-time-candidates.ts` — the entity channel
- `apps/server/src/mcp/memory-tools.ts` — the filter argument and the `entities[]` projection
- `apps/server/src/db/diagnostics.ts` — the link-count integrity check

Depends on: `add-retrieval-eval-harness` — not because address lookup needs measuring (it does not; it is exact), but because the candidate-detection channel changes how many pending relations are minted per save, and the seed change affects what relevance returns.

Invariants: append-only untouched — extraction only ever inserts derived rows, never mutates `content` or `title`. Scope-at-service-layer holds: entities are scoped and the filter runs through the same scoped read path. `topic_key` convergence is unaffected. The new tables are explicitly derived, never primary.
