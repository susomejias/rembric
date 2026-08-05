import { fuseRRFWithScores, RANK_CONSTANT } from '../../../services/hybrid-search.js';
import type { GateSetting, IngestedCorpus, Retriever } from '../types.js';

async function searchOne(
  corpus: IngestedCorpus,
  text: string,
  k: number,
  projectId: string,
  gates: GateSetting | undefined,
): Promise<{ ids: string[]; abstained: boolean }> {
  const { memories, abstained } = await corpus.memory.searchWithAbstention(
    { query: text, limit: k },
    { kind: 'project', projectId },
    gates,
  );
  return { ids: memories.map((m) => m.id), abstained };
}

/**
 * Drives the production `memory.search` text-query path unchanged, through
 * `searchWithAbstention` so the reported flag is scored alongside the ids. The
 * gate values are the only thing the sweep varies.
 *
 * A widened query has no production path to drive yet, so it is served here by
 * one search per project fused over per-project ranks. That is a stand-in and
 * not a proposal: fusing per-project lists hands every project a rank-1 row,
 * which is the ranking the shipped widening has to avoid. What it fixes in
 * place is the TARGET — the committed floors say the foreign gold must be
 * reachable and must rank where it ranks here — so a widening that reaches it
 * less well reddens them.
 */
export const hybridRetriever: Retriever<IngestedCorpus> = {
  name: 'hybrid',
  discriminatingMetric: `recall@k vs 'grep' — the corpus's honest-control comparison`,
  init: (corpus) => corpus,
  async query(text, corpus, k, scope, gates) {
    if (scope.projectIds.length === 1) return searchOne(corpus, text, k, scope.projectId, gates);

    const perProject = await Promise.all(
      scope.projectIds.map((projectId) => searchOne(corpus, text, k, projectId, gates)),
    );
    const fused = fuseRRFWithScores(
      perProject.map((r) => r.ids),
      RANK_CONSTANT,
    );
    return {
      ids: fused.slice(0, k).map((r) => r.id),
      abstained: perProject.every((r) => r.abstained),
    };
  },
};
