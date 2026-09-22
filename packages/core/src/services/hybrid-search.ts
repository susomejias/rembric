import {
  homeScope,
  partitionKeysFor,
  type MemoryStatus,
  type MemoryType,
  type QueryTermFrequencies,
  type Repositories,
  type SearchScope,
} from '@rembric/db';

/** RRF constant (Elastic's `rank_constant`); the common literature default. */
export const RANK_CONSTANT = 60;
/** Hard ceiling on the per-branch rank window, set above the max `limit` (200). */
export const RANK_WINDOW_CEILING = 400;
const RANK_WINDOW_MARGIN = 30;
const RANK_WINDOW_FLOOR = RANK_CONSTANT + 4;

/** The per-branch over-fetch window for a given page — exported for direct unit testing. */
export function computeRankWindowSize(limit: number, offset: number): number {
  return Math.min(
    Math.max(limit + offset + RANK_WINDOW_MARGIN, RANK_WINDOW_FLOOR),
    RANK_WINDOW_CEILING,
  );
}

export const ABSTENTION_FLOOR: number | null = null;
export const RELATIVE_LEVEL_RATIO: number | null = 0.4;
export const DIVERSITY_CAP: number | null = null;

export interface HybridSearchOpts {
  repos: Pick<Repositories, 'memory' | 'vectors' | 'termStatistics'>;
  embedQuery?: (text: string) => Promise<Float32Array>;
  query: string;
  scope: SearchScope;
  /** Omitted means any status — the `topic_key` history read (see `MemoryService.search`). */
  status?: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter (see openspec/changes/fix-audited-defects). */
  topicKey?: string;
  limit: number;
  offset: number;
  /** Injectable clock for the recency term of the ranking boost; defaults to `new Date()`. */
  now?: () => Date;
  /** These three override their module constants; production callers omit them. */
  abstentionFloor?: number | null;
  relativeLevelRatio?: number | null;
  diversityCap?: number;
  /** Calibration-sweep sink; supplying it forces the pool text read even with both gates `null`. */
  onGateWindow?: (leader: GateLeader) => void;
}

export interface SearchVerdict {
  abstained: boolean;
  abstainReason?: string;
  gateShortened?: true;
}

export interface HybridSearchResult extends SearchVerdict {
  ids: string[];
}

export const ABSTAIN_REASON = 'no candidate cleared the relevance floor';
/** Distinct from the floor's: attributing an empty pool to a gate that never ran is untrue. */
export const EMPTY_POOL_REASON = 'no candidate matched the query in this scope';

export interface GateLeader {
  level: number;
  coverage: number;
  cosine: number;
  poolSize: number;
  documentCount: number;
  documentFrequencies: QueryTermFrequencies;
}

export async function hybridSearch(opts: HybridSearchOpts): Promise<HybridSearchResult> {
  const rankWindowSize = computeRankWindowSize(opts.limit, opts.offset);
  const abstentionFloor =
    opts.abstentionFloor !== undefined ? opts.abstentionFloor : ABSTENTION_FLOOR;
  const relativeLevelRatio =
    opts.relativeLevelRatio !== undefined ? opts.relativeLevelRatio : RELATIVE_LEVEL_RATIO;
  const diversityCap = opts.diversityCap ?? DIVERSITY_CAP;

  const lexicalIds = lexicalRetriever(opts, rankWindowSize);
  const dense = await denseRetriever(opts, rankWindowSize);

  const fused = fuseRRFWithScores([dense.map((d) => d.id), lexicalIds], RANK_CONSTANT);

  if (fused.length === 0) {
    if (opts.onGateWindow) {
      const { documentCount, documentFrequencies } = poolLevels(fused, dense, opts);
      opts.onGateWindow({
        level: 0,
        coverage: 0,
        cosine: 0,
        poolSize: 0,
        documentCount,
        documentFrequencies,
      });
    }
    return { ids: [], abstained: true, abstainReason: EMPTY_POOL_REASON };
  }

  // Pre-boost: the boost is a ranking multiplier, not a relevance measure.
  const gatesEnabled = abstentionFloor !== null || relativeLevelRatio !== null;
  let gated: { id: string; score: number }[] = fused;
  let gateRemovedRows = false;
  if (gatesEnabled || opts.onGateWindow) {
    const { scored, documentCount, documentFrequencies } = poolLevels(fused, dense, opts);
    const leveled = fused.map((r) => ({ ...r, level: scored.get(r.id)?.level ?? 0 }));
    const leader = poolLeader(leveled, scored);
    opts.onGateWindow?.({
      ...leader,
      poolSize: fused.length,
      documentCount,
      documentFrequencies,
    });
    if (abstentionFloor !== null && leader.level < abstentionFloor) {
      return { ids: [], abstained: true, abstainReason: ABSTAIN_REASON };
    }
    if (relativeLevelRatio !== null) {
      gated = applyRelativeLevelFilter(leveled, leader.level, relativeLevelRatio);
      gateRemovedRows = gated.length < leveled.length;
    }
  }

  const boosted = applyRankingBoost(gated, opts);
  const diversified = diversityCap !== null ? applyDiversityCap(boosted, diversityCap) : boosted;

  const ids = diversified.map((r) => r.id);
  const page = ids.slice(opts.offset, opts.offset + opts.limit);
  return {
    ids: page,
    abstained: false,
    ...(gateRemovedRows && page.length < opts.limit && opts.offset < fused.length
      ? { gateShortened: true }
      : {}),
  };
}

interface PoolLevels {
  scored: Map<string, { level: number; coverage: number; cosine: number }>;
  documentCount: number;
  documentFrequencies: QueryTermFrequencies;
}

function poolLevels(
  pool: readonly { id: string }[],
  dense: readonly { id: string; score: number }[],
  opts: HybridSearchOpts,
): PoolLevels {
  const scored = new Map<string, { level: number; coverage: number; cosine: number }>();
  const documentCount = opts.repos.termStatistics.adminDocumentCount();
  const documentFrequencies = opts.repos.termStatistics.adminQueryTermFrequencies(opts.query);
  const queryTokens = new Set(documentFrequencies.keys());
  const weightOf = termWeightsFor(documentCount, documentFrequencies);
  const cosineById = new Map(dense.map((d) => [d.id, d.score]));
  const rows = opts.repos.memory.textByIds({
    ids: pool.map((r) => r.id),
    scope: opts.scope,
  });
  for (const r of rows) {
    scored.set(r.id, relevanceComponents(queryTokens, r, cosineById.get(r.id), weightOf));
  }
  return { scored, documentCount, documentFrequencies };
}

export function poolLeader(
  leveled: readonly { id: string; level: number }[],
  scored: ReadonlyMap<string, { coverage: number; cosine: number }>,
): { level: number; coverage: number; cosine: number } {
  let best: { id: string; level: number } | undefined;
  for (const r of leveled) if (!best || r.level > best.level) best = r;
  const components = best ? scored.get(best.id) : undefined;
  return {
    level: best?.level ?? 0,
    coverage: components?.coverage ?? 0,
    cosine: components?.cosine ?? 0,
  };
}

export function relevanceComponents(
  queryTokens: ReadonlySet<string>,
  row: { title: string; content: string },
  denseCosine: number | undefined,
  weightOf: TermWeightLookup,
): { level: number; coverage: number; cosine: number } {
  const coverage = weightedCoverage(
    queryTokens,
    tokenSet(`${row.title}\n\n${row.content}`),
    weightOf,
  );
  const cosine = denseCosine ?? 0;
  return { level: Math.max(coverage, cosine), coverage, cosine };
}

export type TermWeightLookup = (term: string) => number;

export function termWeight(documentCount: number, documentFrequency: number): number {
  const n = Math.max(0, documentCount);
  const df = Math.min(Math.max(0, documentFrequency), n);
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export function termWeightsFor(
  documentCount: number,
  documentFrequencies: QueryTermFrequencies,
): TermWeightLookup {
  const memo = new Map<string, number>();
  return (term) => {
    const hit = memo.get(term);
    if (hit !== undefined) return hit;
    const reported = documentFrequencies.get(term);
    if (reported === undefined) {
      throw new Error(`no term statistic was read for '${term}'`);
    }
    const w = termWeight(documentCount, reported ?? 0);
    memo.set(term, w);
    return w;
  };
}

export function weightedCoverage(
  queryTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
  weightOf: TermWeightLookup,
): number {
  let covered = 0;
  let total = 0;
  for (const t of queryTokens) {
    const w = weightOf(t);
    total += w;
    if (candidateTokens.has(t)) covered += w;
  }
  return total === 0 ? 0 : covered / total;
}

/** Keeps a row iff `level >= ratio × leaderLevel`, in fused order. */
export function applyRelativeLevelFilter<T extends { level: number }>(
  ranked: readonly T[],
  leaderLevel: number,
  ratio: number,
): T[] {
  const cut = ratio * leaderLevel;
  return ranked.filter((r) => r.level >= cut);
}

const BOOST_MIN = 0.7;
const BOOST_MAX = 1.4;
const TYPE_WEIGHT: Record<MemoryType, number> = {
  user: 0.1,
  feedback: 0.1,
  project: 0,
  reference: 0,
  procedural: 0,
};
const DAY_MS = 86_400_000;

export interface BoostedResult {
  id: string;
  score: number;
  sessionId: string | null;
  projectId: string | null;
}

export function applyRankingBoost(
  fused: { id: string; score: number }[],
  opts: HybridSearchOpts,
): BoostedResult[] {
  if (fused.length === 0) return [];
  const ids = fused.map((f) => f.id);
  const meta = opts.repos.memory.rankingMetadataByIds(ids);
  const confirmations = opts.repos.memory.confirmationCountsByIds(ids);
  const nowMs = (opts.now ?? (() => new Date()))().getTime();

  const boosted = fused.map(({ id, score }) => {
    const m = meta.get(id);
    const confirmationCount = confirmations.get(id) ?? 0;
    let boost = 1;
    if (m) {
      boost += TYPE_WEIGHT[m.type] ?? 0;
      if (m.lastSeenAt) {
        const ageDays = (nowMs - m.lastSeenAt.getTime()) / DAY_MS;
        if (ageDays < 7) boost += 0.1;
        else if (ageDays > 90) boost -= 0.1;
      }
      if (confirmationCount >= 3) boost += 0.15;
      else if (confirmationCount >= 1) boost += 0.05;
    }
    boost = Math.min(BOOST_MAX, Math.max(BOOST_MIN, boost));
    return {
      id,
      score: score * boost,
      sessionId: m?.sessionId ?? null,
      projectId: m?.projectId ?? null,
    };
  });
  const homeProjectId = homeScope(opts.scope).projectId;
  const fusedRank = new Map(fused.map((f, i) => [f.id, i]));
  boosted.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.projectId === homeProjectId) - Number(a.projectId === homeProjectId) ||
      fusedRank.get(a.id)! - fusedRank.get(b.id)!,
  );
  return boosted;
}

export function applyDiversityCap<T extends { sessionId: string | null }>(
  ranked: T[],
  cap: number,
): T[] {
  const perSessionCount = new Map<string, number>();
  const admitted: T[] = [];
  const backfill: T[] = [];
  for (const row of ranked) {
    if (row.sessionId === null) {
      admitted.push(row);
      continue;
    }
    const count = perSessionCount.get(row.sessionId) ?? 0;
    if (count < cap) {
      perSessionCount.set(row.sessionId, count + 1);
      admitted.push(row);
    } else {
      backfill.push(row);
    }
  }
  return [...admitted, ...backfill];
}

function lexicalRetriever(opts: HybridSearchOpts, rankWindowSize: number): string[] {
  const matchExpr = sanitizeFtsQuery(opts.query);
  if (!matchExpr) return [];
  try {
    const rows = opts.repos.memory.searchBm25Ids({
      matchExpr,
      scope: opts.scope,
      status: opts.status,
      type: opts.type,
      tag: opts.tag,
      topicKey: opts.topicKey,
      limit: rankWindowSize,
    });
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

async function denseRetriever(
  opts: HybridSearchOpts,
  rankWindowSize: number,
): Promise<{ id: string; score: number }[]> {
  if (!opts.embedQuery || opts.status === 'archived') return [];
  const statuses: Exclude<MemoryStatus, 'archived'>[] = opts.status
    ? [opts.status]
    : ['active', 'superseded'];
  try {
    const queryVector = await opts.embedQuery(opts.query);
    const partitionKeys = partitionKeysFor(opts.scope);
    const neighbors = statuses
      .flatMap((status) =>
        opts.repos.vectors.knnByQueryVector({
          queryVector,
          partitionKeys,
          status,
          type: opts.type,
          rankWindowSize,
        }),
      )
      .sort((a, b) => a.distance - b.distance);
    const denseWindow = rankWindowSize * partitionKeys.length;
    // Dedup (nearest wins) before the slice — RRF needs distinct ids.
    const seen = new Set<string>();
    let scored: { id: string; score: number }[] = [];
    for (const n of neighbors) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      scored.push({ id: n.id, score: 1 - Math.max(0, Math.min(1, n.distance)) });
      if (scored.length >= denseWindow) break;
    }
    if (opts.tag && scored.length > 0) {
      const tagged = opts.repos.memory.idsWithTag(
        scored.map((s) => s.id),
        opts.tag,
      );
      scored = scored.filter((s) => tagged.has(s.id));
    }
    if (opts.topicKey && scored.length > 0) {
      const matching = opts.repos.memory.idsWithTopicKey(
        scored.map((s) => s.id),
        opts.topicKey,
      );
      scored = scored.filter((s) => matching.has(s.id));
    }
    return scored;
  } catch {
    return [];
  }
}

export function fuseRRFWithScores(
  rankedLists: string[][],
  rankConstant = RANK_CONSTANT,
): { id: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (rankConstant + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }));
}

/** Id-only view of `fuseRRFWithScores`, for callers that don't need the raw score. */
export function fuseRRF(rankedLists: string[][], rankConstant = RANK_CONSTANT): string[] {
  return fuseRRFWithScores(rankedLists, rankConstant).map((r) => r.id);
}

export function tokenizeWords(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/"/g, '').trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) tokens.push(t);
  }
  return tokens;
}

export function indexTerms(text: string): string[] {
  const terms: string[] = [];
  for (const raw of text.normalize('NFD').split(/[^\p{L}\p{N}\p{M}]+/u)) {
    const t = raw.replace(/\p{M}/gu, '').toLowerCase();
    if (t) terms.push(t);
  }
  return terms;
}

export function tokenSet(text: string): Set<string> {
  return new Set(indexTerms(text));
}

export function tokenContainment(
  queryTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0) return 0;
  const [small, large] =
    queryTokens.size <= candidateTokens.size
      ? [queryTokens, candidateTokens]
      : [candidateTokens, queryTokens];
  let hits = 0;
  for (const t of small) if (large.has(t)) hits++;
  return hits / queryTokens.size;
}

export function sanitizeFtsQuery(query: string, opts?: { maxTerms?: number }): string {
  const tokens = tokenizeWords(query);
  const capped = opts?.maxTerms !== undefined ? tokens.slice(0, opts.maxTerms) : tokens;
  return capped.map((t) => `"${t}"`).join(' OR ');
}
