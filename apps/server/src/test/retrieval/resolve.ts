import type { IngestedCorpus, QueryScope, QueryScopeFixture } from './types.js';

/**
 * Lives here rather than in `run-eval.ts` because that module calls `main()` at
 * import — the same reason `floor-ratchet.ts` was extracted. Both resolvers
 * throw on a miss: an unknown fixture slug that silently resolved to some other
 * project would make a test pass against the wrong corpus.
 */
export function resolveScope(corpus: IngestedCorpus, fixture: QueryScopeFixture): QueryScope {
  const projectId = corpus.projectIdBySlug.get(fixture.project);
  if (!projectId) throw new Error(`queries.ts: unknown project slug '${fixture.project}'`);
  return { projectId };
}

export function resolveGold(corpus: IngestedCorpus, stableIds: string[]): string[] {
  return stableIds.map((sid) => {
    const id = corpus.idByStableId.get(sid);
    if (!id) throw new Error(`queries.ts: unknown gold stableId '${sid}'`);
    return id;
  });
}
