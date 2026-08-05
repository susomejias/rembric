import type { IngestedCorpus, QueryItem, QueryScope } from './types.js';

/**
 * Lives here rather than in `run-eval.ts` because that module calls `main()` at
 * import — the same reason `floor-ratchet.ts` was extracted. Both resolvers
 * throw on a miss: an unknown fixture slug that silently resolved to some other
 * project would make a test pass against the wrong corpus.
 */
export function resolveScope(
  corpus: IngestedCorpus,
  query: Pick<QueryItem, 'scope' | 'widened'>,
): QueryScope {
  const projectId = corpus.projectIdBySlug.get(query.scope.project);
  if (!projectId) throw new Error(`queries.ts: unknown project slug '${query.scope.project}'`);
  if (!query.widened) return { projectId, projectIds: [projectId] };
  // Home first, then the rest in corpus order: the widened set is a token's
  // reach, which no query argument narrows, and the order has to be stable
  // because the fusion below it breaks ties by first appearance.
  const others = [...corpus.projectIdBySlug.values()].filter((id) => id !== projectId);
  return { projectId, projectIds: [projectId, ...others] };
}

export function resolveGold(corpus: IngestedCorpus, stableIds: string[]): string[] {
  return stableIds.map((sid) => {
    const id = corpus.idByStableId.get(sid);
    if (!id) throw new Error(`queries.ts: unknown gold stableId '${sid}'`);
    return id;
  });
}
