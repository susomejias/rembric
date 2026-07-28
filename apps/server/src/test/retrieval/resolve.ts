import type { IngestedCorpus, QueryScope, QueryScopeFixture } from './types.js';

/**
 * Lives here rather than in `run-eval.ts` because that module calls `main()` at
 * import — the same reason `floor-ratchet.ts` was extracted. Both resolvers
 * throw on a miss: an unknown fixture slug that silently became a global-scope
 * search would make a test pass against the wrong corpus.
 */
export function resolveScope(corpus: IngestedCorpus, fixture: QueryScopeFixture): QueryScope {
  if (fixture.scope === 'global') return { scope: 'global', projectId: null };
  const projectId = fixture.project ? corpus.projectIdBySlug.get(fixture.project) : undefined;
  if (!projectId) throw new Error(`queries.ts: unknown project slug '${fixture.project}'`);
  return { scope: 'project', projectId, includeGlobal: fixture.includeGlobal };
}

export function resolveGold(corpus: IngestedCorpus, stableIds: string[]): string[] {
  return stableIds.map((sid) => {
    const id = corpus.idByStableId.get(sid);
    if (!id) throw new Error(`queries.ts: unknown gold stableId '${sid}'`);
    return id;
  });
}
