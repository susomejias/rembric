import { projectScope, type Memory, type Repositories } from '@rembric/db';

import type { ExtractedEntity } from './entities.js';
import { sanitizeFtsQuery, tokenContainment, tokenSet } from './hybrid-search.js';

export const DISMISSAL_ANCESTRY_CAP = 10;

export const VEC_THRESHOLD = 0.7;

export const ENTITY_RARITY_THRESHOLD = 0.15;

export const ENTITY_RARITY_MIN_LINKS = 5;

export const CANDIDATE_POOL_SIZE = 20;

export interface CandidateOptions {
  perSaveMax: number;
  /** Test seam only — never read from the environment. */
  poolSize?: number;
}

export interface SaveCandidate {
  targetId: string;
  similarity: number;
  /** Which detector surfaced this match. */
  source: 'vec' | 'fts' | 'entity';
  title: string;
  snippet: string;
  topicKey: string | null;
  /** Set only for `source: 'entity'` — the value both memories share. */
  entityValue?: string;
}

export interface SaveCandidateResult {
  /** The first `perSaveMax` of the same ranked order `detected` was counted over. */
  candidates: SaveCandidate[];
  detected: number;
}

export function findSaveTimeCandidates(
  repos: Pick<Repositories, 'memory' | 'vectors' | 'relations' | 'entities'>,
  saved: Memory,
  opts: CandidateOptions,
  extractedEntities: ExtractedEntity[] = [],
): SaveCandidateResult {
  const poolSize = opts.poolSize ?? CANDIDATE_POOL_SIZE;
  const projectId = saved.projectId;
  if (projectId === null) return { candidates: [], detected: 0 };

  const ancestorIds = repos.memory.unsafeAncestorIds({
    startIds: saved.replaces,
    limit: DISMISSAL_ANCESTRY_CAP,
  });
  const dismissedIds =
    ancestorIds.length > 0 ? repos.relations.listNotConflictTargetsForSources(ancestorIds) : [];
  const excludeIds = [...saved.replaces, ...dismissedIds];

  const vecRows = repos.vectors.knnCandidates({
    memoryId: saved.id,
    scope: projectScope(projectId),
    excludeIds,
    limit: poolSize,
  });
  const vecPool: SaveCandidate[] = vecRows
    .map((r) => ({
      targetId: r.id,
      similarity: 1 - Math.max(0, Math.min(1, r.distance)),
      source: 'vec' as const,
      title: r.title,
      snippet: snippet(r.content, 200),
      topicKey: r.topicKey,
    }))
    .filter((c) => c.similarity >= VEC_THRESHOLD);

  const queryTokens = tokenSet(saved.content);
  const matchExpr = sanitizeFtsQuery(saved.content, { maxTerms: 16 });
  const ftsPool: SaveCandidate[] = [];
  if (matchExpr.length > 0) {
    const ftsRows = repos.memory.searchBm25Candidates({
      matchExpr,
      excludeId: saved.id,
      projectId,
      excludeIds,
      limit: poolSize,
    });
    for (const r of ftsRows) {
      ftsPool.push({
        targetId: r.id,
        similarity: tokenContainment(queryTokens, tokenSet(`${r.title}\n\n${r.content}`)),
        source: 'fts',
        title: r.title,
        snippet: snippet(r.content, 200),
        topicKey: r.topicKey,
      });
    }
  }

  const entityPool: SaveCandidate[] = [];
  if (extractedEntities.length > 0) {
    const excludeIdSet = new Set(excludeIds);
    const scopeMemoryCount = repos.entities.scopeActiveMemoryCount({
      projectId,
      excludeMemoryId: saved.id,
    });

    for (const e of extractedEntities) {
      if (scopeMemoryCount === 0) continue;
      const linkCount = repos.entities.entityLinkCount({
        projectId,
        kind: e.kind,
        value: e.value,
        excludeMemoryId: saved.id,
      });
      if (
        linkCount >= ENTITY_RARITY_MIN_LINKS &&
        linkCount / scopeMemoryCount > ENTITY_RARITY_THRESHOLD
      )
        continue;

      const rows = repos.entities.findOtherMemoriesForEntity({
        projectId,
        kind: e.kind,
        value: e.value,
        excludeMemoryId: saved.id,
        excludeIds,
        limit: poolSize,
      });
      for (const r of rows) {
        if (excludeIdSet.has(r.id)) continue;
        entityPool.push({
          targetId: r.id,
          similarity: tokenContainment(queryTokens, tokenSet(`${r.title}\n\n${r.content}`)),
          source: 'entity',
          title: r.title,
          snippet: snippet(r.content, 200),
          topicKey: r.topicKey,
          entityValue: e.value,
        });
      }
    }
  }

  const byId = new Map<string, SaveCandidate>();
  for (const c of [...vecPool, ...ftsPool, ...entityPool]) {
    const prev = byId.get(c.targetId);
    if (!prev) {
      byId.set(c.targetId, c);
    } else if (
      prev.source !== 'entity' &&
      (c.source === 'entity' || c.similarity > prev.similarity)
    ) {
      byId.set(c.targetId, c);
    }
  }
  const all = [...byId.values()].sort(
    (a, b) =>
      Number(b.source === 'entity') - Number(a.source === 'entity') || b.similarity - a.similarity,
  );
  return { candidates: all.slice(0, opts.perSaveMax), detected: all.length };
}

function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}
