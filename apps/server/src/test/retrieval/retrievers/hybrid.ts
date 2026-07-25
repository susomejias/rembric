import type { IngestedCorpus, Retriever } from '../types.js';

/** Drives the production `memory.search` text-query path unchanged. */
export const hybridRetriever: Retriever<IngestedCorpus> = {
  name: 'hybrid',
  discriminatingMetric: `recall@k vs 'grep' — the corpus's honest-control comparison`,
  init: (corpus) => corpus,
  async query(text, corpus, k, scope) {
    const results = await corpus.memory.search(
      {
        query: text,
        limit: k,
        includeGlobal: scope.includeGlobal,
      },
      scope.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'project', projectId: scope.projectId! },
    );
    return results.map((m) => m.id);
  },
};
