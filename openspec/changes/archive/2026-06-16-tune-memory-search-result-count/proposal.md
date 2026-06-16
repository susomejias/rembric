## Why

`memory.search` defaults to returning 20 results when the caller omits `limit`. Industry retrieval practice puts the useful final top-k fed to an LLM at ~3-10, with accuracy saturating around 10 and larger result sets introducing noise rather than recall (Comet RAG guide; RankRAG, arXiv 2407.02485; LlamaIndex default `similarity_top_k=2`; LangChain retriever `k=4`). A real query — "Cuáles son los nodos de mi homelab?" — returned 20 rows padded with semantically-distant memories, which is exactly the recall-first design (`limit=20` + a kNN that returns its top-k regardless of distance) overshooting. The fix is to align the default with the norm.

## What Changes

- Lower the default `memory.search` result count from **20 to 8** when `limit` is omitted, expressed as a named `DEFAULT_SEARCH_LIMIT` constant rather than a magic literal in `clampLimit`. 8 (not 5) because there is no reranker yet: a slightly higher final count compensates for RRF's imprecise ordering near the top.
- The default applies to BOTH search modes (the hybrid text-query branch and the no-query chronological listing), since `clampLimit` is shared. Explicit `limit` values are unchanged (still clamped to `[1, 200]`); the over-fetch rank window, RRF fusion, FTS branch, and dense branch are all untouched.
- **Not in scope (deliberately deferred):** a cosine-distance floor on the dense branch to trim semantically-distant neighbors. It reverses a deliberate prior decision (D3, "no similarity threshold on the search vector branch") whose rationale is the cross-lingual recall this project just shipped, and the unrelated/weak-match cosine bands overlap so no safe floor value is obvious. Lowering the default removes the bulk of the observed noise on its own; the floor is recorded in `design.md` as a measure-first follow-up.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory`: the search behavior requirement gains an explicit default result-count contract (the previously-unspecified default of 20 becomes a specified `DEFAULT_SEARCH_LIMIT` of 8, applied to both the hybrid and listing branches).

## Impact

- `apps/server/src/services/memory.ts` — `clampLimit` default value, extracted to a `DEFAULT_SEARCH_LIMIT` constant.
- Spec: `openspec/specs/memory/spec.md` — hybrid-retrieval requirement, default result-count clause.
- Tests: `apps/server/src/services/memory.test.ts` (any assertion that relies on the 20 default).
- No migration, no MCP tool-shape change, no dashboard change. The MCP `memory.search` contract change is the smaller default page size when `limit` is omitted.
