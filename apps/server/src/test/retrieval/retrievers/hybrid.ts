import type { SearchScope } from '../../../services/scope.js';
import type { IngestedCorpus, QueryScope, Retriever } from '../types.js';

/**
 * The value the production construction site would hand the search path for
 * this query. Built here rather than imported because that site takes an MCP
 * request context; the shape is the same and the type is the same.
 */
function searchScopeOf(scope: QueryScope): SearchScope {
  if (scope.projectIds.length < 2) return { kind: 'project', projectId: scope.projectId };
  return {
    kind: 'authorized-projects',
    projectIds: scope.projectIds,
    homeProjectId: scope.projectId,
  };
}

/**
 * Drives the production `memory.search` text-query path unchanged, through
 * `searchWithAbstention` so the reported flag is scored alongside the ids. The
 * gate values are the only thing the sweep varies. A widened query takes the
 * identical path under a widened scope — one search, one globally-ordered list
 * per branch — so the floors below score the shipped ranking rather than a
 * harness-side approximation of it.
 */
export const hybridRetriever: Retriever<IngestedCorpus> = {
  name: 'hybrid',
  discriminatingMetric: `recall@k vs 'grep' — the corpus's honest-control comparison`,
  init: (corpus) => corpus,
  async query(text, corpus, k, scope, gates) {
    const { memories, abstained } = await corpus.memory.searchWithAbstention(
      { query: text, limit: k },
      searchScopeOf(scope),
      gates,
    );
    return { ids: memories.map((m) => m.id), abstained };
  },
};
