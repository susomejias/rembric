## Context

Rembric has a judgement graph and no knowledge graph. The audit found zero entities anywhere in the server, which means the questions a coding agent has an _exact key_ for — this file, this package, this error code — must be asked as text queries and answered by a ranked retriever. That is the query class the audit reproduced as ranked retrieval's worst: the dense branch misses rare tokens, and the fusion constants then let both-branch mediocrity outscore a single-branch exact hit.

## Goals

- Answer "what do I know about X" as an index lookup, completely, with no ranking involved.
- Give save-time conflict detection a recall channel that text and vector similarity structurally cannot provide.
- Give context relevance a precise seed from the working directory instead of embedding a path as prose.
- Show the operator which parts of the codebase have accumulated knowledge and which are blind.

## Non-Goals

- **No graph stream in RRF fusion.** This is the load-bearing exclusion; see Decision 1.
- No LLM entity extraction, no entity resolution, no triple store, no traversal engine.
- No new MCP tool.
- No inferred relationships between entities. Entities link to memories, not to each other.

## Decisions

**Decision 1 — Exclude the fusion stream, and say why in the spec.**
The obvious version of this feature is "add a graph branch to the RRF". The evidence is against it: in its own author's published benchmark a BM25+vector+graph triple-stream scored **worse** than BM25 alone (Recall@5 36.8% vs 43.8%, and worse on NDCG@10 and MRR), and a 2026 survey of long-term dialog memory concludes that observed differences are driven more by foundational system settings than by architectural additions. Meanwhile the three uses this change _does_ ship are not ranking mechanisms at all, so that evidence does not bear on them. Writing the exclusion into the spec as a requirement means a future contributor cannot add the stream without a measured win and a dedicated change — which is the outcome the evidence argues for.

**Decision 2 — Precision over recall in the extractor, deliberately.**
A false entity link is worse than a missing one, because the entire value proposition is that an entity lookup is _exact_. If `memory.search({entity: 'migrate.ts'})` returns memories that merely mention the word, the mechanism degrades into a bad text search and the agent learns to distrust it. So the extractor recognises only high-confidence syntax and skips ambiguous prose. Recall can be improved later by adding kinds; precision lost at the start is not recoverable, because the index will already be polluted.

**Decision 3 — Deterministic extraction is not a compromise here, it is the right design.**
The competitor mechanisms that need an LLM need it for _entity resolution_ — deciding that "the auth service" and "AuthService" are the same thing in prose. Coding-agent memory does not have that problem in the cases that matter: a file path is a canonical string, a package name is a canonical string, an error code is a canonical string. The entities with real retrieval value are exactly the ones with syntax. Spending an LLM call to find them would be paying for a capability the problem does not require.

**Decision 4 — Zero new tools; `entity` is an argument.**
The audit measured 23 tools, four confusable clusters, and ~31 KB of `tools/list` resident every turn, of which `outputSchema` is the larger half and contributes nothing to selection. A new `memory.entities` tool would add to the cluster problem to express something `memory.search` can express as a filter. The `entities[]` projection on reads is what makes the filter discoverable — the agent sees what a memory is about and can pivot, without being taught a new verb.

**Decision 5 — Entity plus text query narrows; it does not fuse.**
Fusing an exact set with a ranked set reintroduces exactly the arithmetic that made identifier queries fail. Narrowing is unambiguous and is what a caller supplying both actually wants: "among what I know about this file, what concerns migrations".

**Decision 6 — Common entities generate no candidates.**
An entity linked to a large share of the scope carries no signal — every memory in a small project might mention the project's own package name. Without a rarity gate the entity channel would flood the per-save candidate budget, starving the lexical and dense channels and creating judgement load with no information. The gate is the same idea as IDF, applied to link counts.

**Decision 7 — Derived tables, with a rebuild path from day one.**
Both tables are pure functions of append-only primary data, which is what licenses a rebuild — the same argument the vector table already relies on. Shipping the rebuild and the drift check _with_ the feature rather than after it matters because the failure mode of a derived index is silent incompleteness, and the audit found that nothing currently verifies FTS or vector integrity at runtime either. This change should not add a third unverified derived index.

**Decision 8 — Backfill existing memories in the migration, resumably.**
An entity index that only covers memories saved after it shipped is close to useless on an established corpus — the operator's accumulated knowledge is precisely what they want to address. The backfill is a pure recomputation with no external dependency, so it can run in batches and resume, in the same shape as the embedding backfill.

## Risks

- **Extractor false positives pollute the index permanently.** The mitigation is precision-first plus the rebuild path: if a rule turns out too loose, tighten it and rebuild, since nothing is lost. This is the strongest argument for shipping the rebuild with the feature.
- **Judgement load rises.** The entity channel mints candidates the other two channels never proposed. That is the point, but it compounds a known protocol weakness: a pending that goes unjudged in-session hides for 24 hours and then re-surfaces without its original context. The rarity gate and the per-save cap bound it; the underlying protocol issue belongs elsewhere.
- **Two more tables to keep in sync through a future table-rebuild migration on `memory`.** The audit already flagged that `DROP TABLE memory` silently drops triggers spread across four migration files. Adding link-table triggers raises that cost. Mitigated by the trigger-set invariant assertion and by these tables being link-only, so a rebuild recovers them.
- **Path entities are noisy in a monorepo.** `src/index.ts` is not distinctive. Rarity gating handles it for candidates; for lookup the caller supplies the full path they care about, so the burden is on them and that is acceptable.
- **This is the largest change in the set.** Two tables, a migration with a backfill, an extractor with a large test surface, a new dashboard view. It should not be attempted before the cheap high-value items land.

## Migration

One migration creating both tables and their indexes, plus a resumable backfill over existing non-archived memories. No change to `memory` itself, so no table rebuild and no FK dance.

## Open Questions

- **Which entity kinds ship first.** File paths and error codes are the highest-confidence and highest-value; package names need a lockfile or manifest to disambiguate from prose; symbol identifiers are the noisiest. Leaning paths + error codes + git refs + URLs + ticket ids in the first pass, with symbols deferred until the extractor's precision is measurable.
- **The rarity threshold for the candidate channel.** A fixed link count, or a proportion of the scope's memories? Proportion adapts to corpus size, which is the same lesson the inverted BM25 threshold taught — absolute thresholds over corpus-relative quantities do not hold.
- **Whether `memory.context` should surface entity-derived relevance as its own channel** or fold it into the relevance channel from `improve-recall-relevance`. Folding is simpler; a separate channel is more explainable to the model. Leaning fold, with the seed source recorded.
- **Whether the extractor should run over `content` only or `title + content`.** The embedding recipe uses `title + content`; consistency argues for matching it.
