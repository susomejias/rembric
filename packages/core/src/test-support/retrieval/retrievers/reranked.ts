import type { IngestedCorpus, Retriever } from '../types.js';

import { searchScopeOf } from './hybrid.js';

export const rerankedRetriever: Retriever<IngestedCorpus> = {
  name: 'reranked',
  discriminatingMetric: `mrr and ndcg vs 'hybrid' — it reorders the same pool, so recall cannot show its effect`,
  init: (corpus) => corpus,
  async query(text, corpus, k, scope, gates) {
    const { memories, abstained } = await corpus.memory.searchWithAbstention(
      { query: text, limit: k },
      searchScopeOf(scope),
      gates,
      { rerank: true },
    );
    return { ids: memories.map((m) => m.id), abstained };
  },
};
