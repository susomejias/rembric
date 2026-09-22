import { type SearchScope } from '@rembric/db';

import type { IngestedCorpus, QueryScope, Retriever } from '../types.js';

function searchScopeOf(scope: QueryScope): SearchScope {
  if (scope.projectIds.length < 2) return { kind: 'project', projectId: scope.projectId };
  return {
    kind: 'authorized-projects',
    projectIds: scope.projectIds,
    homeProjectId: scope.projectId,
  };
}

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
