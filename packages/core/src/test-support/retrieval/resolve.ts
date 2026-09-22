import type { IngestedCorpus, QueryItem, QueryScope } from './types.js';

export function resolveScope(
  corpus: IngestedCorpus,
  query: Pick<QueryItem, 'scope' | 'widened'>,
): QueryScope {
  const projectId = corpus.projectIdBySlug.get(query.scope.project);
  if (!projectId) throw new Error(`queries.ts: unknown project slug '${query.scope.project}'`);
  if (!query.widened) return { projectId, projectIds: [projectId] };
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
