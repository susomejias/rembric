import {
  projectScope,
  type Memory,
  type MemoryStatus,
  type Repositories,
  type TokenTermFrequency,
} from '@rembric/db';

import { extractEntities, type ExtractedEntity } from './entities.js';
import { ftsQueryTokens, joinFtsTokens, tokenContainment, tokenSet } from './hybrid-search.js';

export const DISMISSAL_ANCESTRY_CAP = 10;

export const VEC_THRESHOLD = 0.7;

export const LEXICAL_CANDIDATE_FLOOR = 0.6;

export const ENTITY_RARITY_THRESHOLD = 0.15;

export const ENTITY_RARITY_MIN_LINKS = 5;

export const CANDIDATE_POOL_SIZE = 20;

export const DRAIN_MAX_PAIR_CHARS = 64_000;

/** FTS5's bm25 clamps a term's idf to 1e-6 from exactly this share of indexed rows upward. */
export const COMMON_TERM_DOCUMENT_RATIO = 0.5;

export const CANDIDATE_LOW_BAND_CEILING = 0.75;

export const CANDIDATE_HIGH_BAND_FLOOR = 0.85;

export type CandidateBand = 'low' | 'middle' | 'high';

export interface CandidateSignals {
  /** Cosine to the saved memory; null when either side has no vector, so it is unknown. */
  vecSimilarity: number | null;
  /** Admitted by the lexical channel (rank pool and floor). */
  lexical: boolean;
  /** Shares a rare entity with the saved memory. */
  entity: boolean;
}

export function classifyCandidateBand({
  vecSimilarity: vec,
  lexical,
  entity,
}: CandidateSignals): CandidateBand | null {
  const dense = vec !== null && vec >= VEC_THRESHOLD;
  if (!dense && !lexical && !entity) return null;
  if (vec !== null && vec >= CANDIDATE_HIGH_BAND_FLOOR) return 'high';
  if (lexical || vec === null) return 'middle';
  if (entity) return dense ? 'middle' : 'low';
  return vec < CANDIDATE_LOW_BAND_CEILING ? 'low' : 'middle';
}

export interface CandidateOptions {
  perSaveMax: number;
  /** Test seam only — never read from the environment. */
  poolSize?: number;
  /** Test seam only — never read from the environment. */
  lexicalFloor?: number;
  /** Test seam only — never read from the environment; `null` turns pruning and its reads off. */
  commonTermRatio?: number | null;
  /** Test seam only — never read from the environment. `false` puts every pair in the middle band. */
  bands?: boolean;
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
  band: CandidateBand;
}

export function lexicalOverlap(
  queryTokens: ReadonlySet<string>,
  candidate: { title: string; content: string },
): number {
  return tokenContainment(queryTokens, tokenSet(`${candidate.title}\n\n${candidate.content}`));
}

export function vectorSimilarity(distance: number): number {
  return 1 - Math.max(0, Math.min(1, distance));
}

export function lexicalAdmits(
  similarity: number,
  floor: number = LEXICAL_CANDIDATE_FLOOR,
): boolean {
  return similarity >= floor;
}

export function vectorAdmits(similarity: number): boolean {
  return similarity >= VEC_THRESHOLD;
}

export interface SaveCandidateResult {
  /** The first `perSaveMax` middle- and high-band pairs of the ranked order `detected` counts. */
  candidates: SaveCandidate[];
  /** The first `perSaveMax` low-band pairs of the same ranked order; never judged. */
  related: SaveCandidate[];
  detected: number;
}

type Unbanded = Omit<SaveCandidate, 'band'>;

export function findSaveTimeCandidates(
  repos: Pick<Repositories, 'memory' | 'vectors' | 'relations' | 'entities' | 'termStatistics'>,
  saved: Memory,
  opts: CandidateOptions,
  extractedEntities: ExtractedEntity[] = [],
): SaveCandidateResult {
  const poolSize = opts.poolSize ?? CANDIDATE_POOL_SIZE;
  const lexicalFloor = opts.lexicalFloor ?? LEXICAL_CANDIDATE_FLOOR;
  const projectId = saved.projectId;
  if (projectId === null) return { candidates: [], related: [], detected: 0 };

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
  const cosineById = new Map(vecRows.map((r) => [r.id, vectorSimilarity(r.distance)]));
  const vecPool: Unbanded[] = vecRows
    .map((r) => ({
      targetId: r.id,
      similarity: vectorSimilarity(r.distance),
      source: 'vec' as const,
      title: r.title,
      snippet: snippet(r.content, 200),
      topicKey: r.topicKey,
    }))
    .filter((c) => vectorAdmits(c.similarity));

  const queryTokens = tokenSet(saved.content);
  const matchExpr = saveTimeMatchExpression(
    repos.termStatistics,
    saved.content,
    opts.commonTermRatio === undefined ? COMMON_TERM_DOCUMENT_RATIO : opts.commonTermRatio,
  );
  const ftsPool: Unbanded[] = [];
  if (matchExpr.length > 0) {
    const ftsRows = repos.memory.searchBm25Candidates({
      matchExpr,
      excludeId: saved.id,
      projectId,
      excludeIds,
      limit: poolSize,
    });
    for (const r of ftsRows) {
      const similarity = lexicalOverlap(queryTokens, r);
      if (!lexicalAdmits(similarity, lexicalFloor)) continue;
      ftsPool.push({
        targetId: r.id,
        similarity,
        source: 'fts',
        title: r.title,
        snippet: snippet(r.content, 200),
        topicKey: r.topicKey,
      });
    }
  }

  const entityPool: Unbanded[] = [];
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
          similarity: lexicalOverlap(queryTokens, r),
          source: 'entity',
          title: r.title,
          snippet: snippet(r.content, 200),
          topicKey: r.topicKey,
          entityValue: e.value,
        });
      }
    }
  }

  const byId = new Map<string, Unbanded>();
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

  const unknown = [...byId.keys()].filter((id) => !cosineById.has(id));
  if (vecRows.length > 0 && unknown.length > 0) {
    const scope = projectScope(projectId);
    for (const r of repos.vectors.cosineDistances({
      memoryId: saved.id,
      scope,
      targetIds: unknown,
    }))
      cosineById.set(r.id, vectorSimilarity(r.distance));
  }
  const lexicalIds = new Set(ftsPool.map((c) => c.targetId));
  const entityIds = new Set(entityPool.map((c) => c.targetId));
  const all: SaveCandidate[] = [...byId.values()]
    .sort(
      (a, b) =>
        Number(b.source === 'entity') - Number(a.source === 'entity') ||
        b.similarity - a.similarity,
    )
    .map((c) => ({
      ...c,
      band:
        opts.bands === false
          ? 'middle'
          : (classifyCandidateBand({
              vecSimilarity: cosineById.get(c.targetId) ?? null,
              lexical: lexicalIds.has(c.targetId),
              entity: entityIds.has(c.targetId),
            }) ?? 'middle'),
    }));
  const judged = all.filter((c) => c.band !== 'low');
  return {
    candidates: judged.slice(0, opts.perSaveMax),
    related: all.filter((c) => c.band === 'low').slice(0, opts.perSaveMax),
    detected: judged.length,
  };
}

export function saveTimeMatchExpression(
  termStatistics: Pick<
    Repositories['termStatistics'],
    'adminDocumentCount' | 'adminTokenTermFrequencies'
  >,
  content: string,
  commonTermRatio: number | null,
): string {
  const tokens = ftsQueryTokens(content, { maxTerms: 16 });
  if (tokens.length === 0 || commonTermRatio === null) return joinFtsTokens(tokens);
  return joinFtsTokens(
    pruneCommonTokens(
      tokens,
      termStatistics.adminTokenTermFrequencies(tokens),
      termStatistics.adminDocumentCount(),
      commonTermRatio,
    ),
  );
}

export function pruneCommonTokens(
  tokens: readonly string[],
  termsByToken: readonly (readonly TokenTermFrequency[])[],
  documentCount: number,
  commonTermRatio: number,
): string[] {
  const kept: string[] = [];
  let keptReachesAnotherRow = false;
  tokens.forEach((token, i) => {
    const frequencies = (termsByToken[i] ?? []).map((t) => t.documentFrequency ?? 0);
    if (frequencies.length === 1 && frequencies[0]! >= commonTermRatio * documentCount) return;
    kept.push(token);
    // The saved row is already indexed, so a frequency of 1 is the saved row alone.
    if (frequencies.length > 0 && Math.min(...frequencies) > 1) keptReachesAnotherRow = true;
  });
  return keptReachesAnotherRow ? kept : [...tokens];
}

function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}

export type ChannelVerdict = 'admitted' | 'not_admitted' | 'unknown';

export type PairEvaluation =
  | { kind: 'unreadable' }
  | { kind: 'failed'; error: string }
  | { kind: 'retired'; sourceStatus: MemoryStatus; targetStatus: MemoryStatus }
  | { kind: 'oversized' }
  | {
      kind: 'channels';
      lexical: ChannelVerdict;
      vector: ChannelVerdict;
      entity: ChannelVerdict;
      lexicalSimilarity: number;
      vectorSimilarity: number | null;
    };

export interface EvaluatePairOptions {
  vectorIndexCurrent: boolean;
  /** Test seam only. */
  extract?: (title: string, content: string) => ExtractedEntity[];
}

/** Rank-free: no pool, MATCH term selection, exclusion ids or cap, so it admits a superset of detection. */
export function evaluatePair(
  repos: Pick<Repositories, 'memory' | 'vectors' | 'entities'>,
  projectId: string,
  sourceId: string,
  targetId: string,
  opts: EvaluatePairOptions,
): PairEvaluation {
  try {
    const rows = repos.memory.findBoundedEndpoints({
      projectId,
      ids: [sourceId, targetId],
      maxChars: DRAIN_MAX_PAIR_CHARS,
    });
    const source = rows.find((r) => r.id === sourceId);
    const target = rows.find((r) => r.id === targetId);
    if (!source || !target) return { kind: 'unreadable' };
    if (source.status !== 'active' || target.status !== 'active') {
      return { kind: 'retired', sourceStatus: source.status, targetStatus: target.status };
    }
    if (
      source.title === null ||
      source.content === null ||
      target.title === null ||
      target.content === null
    ) {
      return { kind: 'oversized' };
    }
    const sourceText = { title: source.title, content: source.content };
    const targetText = { title: target.title, content: target.content };

    const lexicalSimilarity = lexicalOverlap(tokenSet(sourceText.content), targetText);

    let vectorSimilarityValue: number | null = null;
    if (opts.vectorIndexCurrent) {
      const distance = repos.vectors.pairCosineDistance(projectId, sourceId, targetId);
      if (distance !== null) vectorSimilarityValue = vectorSimilarity(distance);
    }

    return {
      kind: 'channels',
      lexical: lexicalAdmits(lexicalSimilarity) ? 'admitted' : 'not_admitted',
      vector:
        vectorSimilarityValue === null
          ? 'unknown'
          : vectorAdmits(vectorSimilarityValue)
            ? 'admitted'
            : 'not_admitted',
      entity: entityVerdict(repos, sourceId, targetId, sourceText, targetText, opts),
      lexicalSimilarity,
      vectorSimilarity: vectorSimilarityValue,
    };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

function entityVerdict(
  repos: Pick<Repositories, 'entities'>,
  sourceId: string,
  targetId: string,
  source: { title: string; content: string },
  target: { title: string; content: string },
  opts: EvaluatePairOptions,
): ChannelVerdict {
  const key = (e: { kind: string; value: string }) => `${e.kind}\u0000${e.value}`;
  const stored = repos.entities.findEntitiesForMemories([sourceId, targetId]);
  const sourceKeys = new Set((stored.get(sourceId) ?? []).map(key));
  const targetKeys = new Set((stored.get(targetId) ?? []).map(key));
  const shares = () => [...targetKeys].some((k) => sourceKeys.has(k));
  if (shares()) return 'admitted';
  const extract = opts.extract ?? extractEntities;
  try {
    for (const e of extract(source.title, source.content)) sourceKeys.add(key(e));
    for (const e of extract(target.title, target.content)) targetKeys.add(key(e));
  } catch {
    return 'unknown';
  }
  return shares() ? 'admitted' : 'not_admitted';
}
