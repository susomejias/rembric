import type { Repositories } from '../db/repositories/index.js';
import { partitionKeyFor } from '../db/repositories/scope-clause.js';
import type { MemoryScope, MemoryStatus, MemoryType } from '../db/schema/memory.js';

/**
 * Standard hybrid retrieval for `memory.search`, expressed in the repo's flat
 * idiom (a module function, mirroring `findSaveTimeCandidates`): a lexical
 * retriever (FTS5/BM25) and a dense retriever (sqlite-vec kNN) each over-fetch
 * into a bounded rank window, and their ranked id lists are fused with
 * Reciprocal Rank Fusion. This is the de-facto pattern documented by
 * Elasticsearch / Azure AI Search / Qdrant — adapted to a single SQLite file.
 *
 * Each branch is fault-isolated: a malformed lexical query or a missing
 * embedder degrades to the other branch rather than failing the whole search.
 */

/** RRF constant (Elastic's `rank_constant`); the common literature default. */
export const RANK_CONSTANT = 60;
/** Hard ceiling on the per-branch rank window, set above the max `limit` (200). */
export const RANK_WINDOW_CEILING = 400;
const RANK_WINDOW_MARGIN = 30;

export interface HybridSearchOpts {
  repos: Pick<Repositories, 'memory' | 'vectors'>;
  embedQuery?: (text: string) => Promise<Float32Array>;
  query: string;
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  limit: number;
  offset: number;
  /** Widen a `project` scope to also match `global` rows; no-op for `global` scope. */
  includeGlobal?: boolean;
  /** Injectable clock for the recency term of the ranking boost; defaults to `new Date()`. */
  now?: () => Date;
}

export async function hybridSearch(opts: HybridSearchOpts): Promise<string[]> {
  const rankWindowSize = Math.min(
    opts.limit + opts.offset + RANK_WINDOW_MARGIN,
    RANK_WINDOW_CEILING,
  );

  const lexical = lexicalRetriever(opts, rankWindowSize);
  const dense = await denseRetriever(opts, rankWindowSize);

  const fused = fuseRRFWithScores([dense, lexical], RANK_CONSTANT);
  const boosted = applyRankingBoost(fused, opts);
  return boosted.slice(opts.offset, opts.offset + opts.limit);
}

const BOOST_MIN = 0.7;
const BOOST_MAX = 1.4;
const TYPE_WEIGHT: Record<MemoryType, number> = {
  user: 0.1,
  feedback: 0.1,
  project: 0,
  reference: 0,
};
const DAY_MS = 86_400_000;

/**
 * Re-weights the fused pool by a clamped `[BOOST_MIN, BOOST_MAX]` multiplier
 * before the `limit` truncation. The clamp keeps it from overriding RRF order.
 */
export function applyRankingBoost(
  fused: { id: string; score: number }[],
  opts: HybridSearchOpts,
): string[] {
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
    return { id, score: score * boost };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted.map((b) => b.id);
}

/** FTS5/BM25 branch — fault-isolated (a parse error degrades to empty). */
function lexicalRetriever(opts: HybridSearchOpts, rankWindowSize: number): string[] {
  const matchExpr = sanitizeFtsQuery(opts.query);
  if (!matchExpr) return [];
  try {
    return opts.repos.memory.searchBm25Ids({
      matchExpr,
      scope: opts.scope,
      projectId: opts.projectId,
      status: opts.status,
      type: opts.type,
      tag: opts.tag,
      limit: rankWindowSize,
      includeGlobal: opts.includeGlobal,
    });
  } catch {
    return [];
  }
}

/**
 * sqlite-vec kNN branch — fault-isolated. Skipped when no embedder is wired
 * or when searching `archived` (archived vectors are outside the
 * post-model-change semantic guarantee). `tag` is a bounded post-filter over
 * the rank window because tags are not duplicated into the vector index.
 */
async function denseRetriever(opts: HybridSearchOpts, rankWindowSize: number): Promise<string[]> {
  if (!opts.embedQuery || opts.status === 'archived') return [];
  const status = opts.status;
  try {
    const queryVector = await opts.embedQuery(opts.query);
    // include_global scans the project + global partitions (each with its own
    // `k=` over-fetch), merged by distance into one ranked list.
    const partitionKeys =
      opts.includeGlobal && opts.scope === 'project'
        ? [partitionKeyFor(opts.scope, opts.projectId), partitionKeyFor('global', null)]
        : [partitionKeyFor(opts.scope, opts.projectId)];
    const neighbors = partitionKeys
      .flatMap((partitionKey) =>
        opts.repos.vectors.knnByQueryVector({
          queryVector,
          partitionKey,
          status,
          type: opts.type,
          rankWindowSize,
        }),
      )
      .sort((a, b) => a.distance - b.distance);
    // Dedup (nearest wins) before the slice — RRF needs distinct ids.
    const seen = new Set<string>();
    let ids: string[] = [];
    for (const n of neighbors) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      ids.push(n.id);
      if (ids.length >= rankWindowSize) break;
    }
    if (opts.tag && ids.length > 0) {
      const tagged = opts.repos.memory.idsWithTag(ids, opts.tag);
      ids = ids.filter((id) => tagged.has(id));
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Reciprocal Rank Fusion: `score(id) = Σ 1/(rankConstant + rank)` across the
 * lists in which the id appears, ordered by descending score. Rank-based, so
 * it needs no score normalization across the incomparable BM25 / cosine
 * scales — the de-facto hybrid fusion. Pure; no dependencies.
 */
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

/**
 * Build a crash-proof FTS5 MATCH expression from arbitrary natural-language
 * text. Keeps whole Unicode word tokens (does NOT split at non-ASCII chars or
 * drop accented/CJK tokens, unlike a naive ASCII-only tokenizer), drops
 * pure-punctuation tokens, and quotes each surviving token as a phrase —
 * optionally capped at `maxTerms` OR-phrases (save-time candidate detection
 * passes a cap; interactive search does not).
 * which neutralizes FTS5 metacharacters AND bareword operators (AND/OR/NOT/
 * NEAR) in one move. The OR between quoted phrases is the intended fusion-
 * friendly recall semantics; a user's literal "OR" becomes the phrase `"or"`.
 * Returns '' when nothing usable remains (caller skips the lexical branch).
 */
export function sanitizeFtsQuery(query: string, opts?: { maxTerms?: number }): string {
  const tokens: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const t = raw.replace(/"/g, '').trim();
    if (!t) continue;
    // Drop tokens with no letter/number in any script — a quoted phrase of
    // pure punctuation tokenizes to nothing and is useless (and risks an
    // empty-phrase parse edge).
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    tokens.push(`"${t}"`);
    if (opts?.maxTerms !== undefined && tokens.length >= opts.maxTerms) break;
  }
  return tokens.join(' OR ');
}
