import type { IngestedCorpus, Retriever } from '../types.js';

/**
 * Drives the production `memory.search` text-query path unchanged, through
 * `searchWithAbstention` so the reported flag is scored alongside the ids. The
 * gate values are the only thing the sweep varies.
 */
export const hybridRetriever: Retriever<IngestedCorpus> = {
  name: 'hybrid',
  discriminatingMetric: `recall@k vs 'grep' — the corpus's honest-control comparison`,
  init: (corpus) => corpus,
  async query(text, corpus, k, scope, gates) {
    const { memories, abstained } = await corpus.memory.searchWithAbstention(
      {
        query: text,
        limit: k,
      },
      scope.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'project', projectId: scope.projectId! },
      gates,
    );
    return { ids: memories.map((m) => m.id), abstained };
  },
};
