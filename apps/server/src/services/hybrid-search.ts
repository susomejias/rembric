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
/**
 * RRF only preserves "a rank-1 single-branch row outranks a bottom-of-window
 * both-branches row" while `window > RANK_CONSTANT + 2` (from
 * `1/(k+1) > 2/(k+window)`). Floored at `+4` for margin over that crossover
 * — derived from `RANK_CONSTANT`, not a bare literal, so the two constants
 * can't drift apart again. See fix-retrieval-ranking-math.
 */
const RANK_WINDOW_FLOOR = RANK_CONSTANT + 4;

/** The per-branch over-fetch window for a given page — exported for direct unit testing. */
export function computeRankWindowSize(limit: number, offset: number): number {
  return Math.min(
    Math.max(limit + offset + RANK_WINDOW_MARGIN, RANK_WINDOW_FLOOR),
    RANK_WINDOW_CEILING,
  );
}

/**
 * Absolute floor on the highest relevance level in the gate window (see
 * `computeRelevanceLevel`). `null` ships this disabled: an uncalibrated floor
 * silently destroys recall. Enabling it requires a committed
 * `pnpm run eval --sweep-abstention` grid meeting the bar in memory/spec.md
 * ("Retrieval and lifecycle constants MUST be named and bounded in one place").
 */
export const ABSTENTION_FLOOR: number | null = null;
/**
 * Relative-filter ratio: a pool row survives only while its relevance level is
 * at or above `ratio × leaderLevel`. Enabled at 0.40 on the committed sweep in
 * `archive/2026-07-28-rescore-relevance-abstention/measurements/sweep.txt`,
 * which is plateau-interior with two admissible steps either side. `ABSTENTION_FLOOR`
 * stays `null` — its two level distributions overlap and no value separates them.
 */
export const RELATIVE_LEVEL_RATIO: number | null = 0.4;
/**
 * At most this many results per originating session. `null` ships this
 * disabled, same reasoning as `ABSTENTION_FLOOR`: it is applied to the whole
 * fused pool before the page is sliced, so a held-back row is replaced by
 * whatever ranked next in a 64–400 row pool, not by a comparable row. On a
 * one-topic session that measurably swaps most of page 1 for noise, and the
 * eval corpus cannot see it (every corpus row has `session_id = NULL`, which
 * is never grouped). Needs a session-labelled fixture before re-enabling.
 */
export const DIVERSITY_CAP: number | null = null;

export interface HybridSearchOpts {
  repos: Pick<Repositories, 'memory' | 'vectors'>;
  embedQuery?: (text: string) => Promise<Float32Array>;
  query: string;
  scope: MemoryScope;
  projectId: string | null;
  /** Omitted means any status — the `topic_key` history read (see `MemoryService.search`). */
  status?: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter (see openspec/changes/fix-audited-defects). */
  topicKey?: string;
  limit: number;
  offset: number;
  /** Widen a `project` scope to also match `global` rows; no-op for `global` scope. */
  includeGlobal?: boolean;
  /** Injectable clock for the recency term of the ranking boost; defaults to `new Date()`. */
  now?: () => Date;
  /** These three override their module constants; production callers omit them. */
  abstentionFloor?: number | null;
  relativeLevelRatio?: number | null;
  diversityCap?: number;
  /** Calibration-sweep sink; supplying it forces the pool text read even with both gates `null`. */
  onGateWindow?: (leader: GateLeader) => void;
}

export interface HybridSearchResult {
  ids: string[];
  abstained: boolean;
  reason?: string;
}

const ABSTAIN_REASON = 'no candidate cleared the relevance floor';

/** The pool leader's level and the two components of that same row, so a per-branch split can be decided on evidence. */
export interface GateLeader {
  level: number;
  coverage: number;
  cosine: number;
  poolSize: number;
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

  // Pre-boost: the boost is a ranking multiplier, not a relevance measure.
  const gatesEnabled = abstentionFloor !== null || relativeLevelRatio !== null;
  let gated: { id: string; score: number }[] = fused;
  if (gatesEnabled || opts.onGateWindow) {
    const scored = poolLevels(fused, dense, opts);
    const leveled = fused.map((r) => ({ ...r, level: scored.get(r.id)?.level ?? 0 }));
    const leader = poolLeader(leveled, scored);
    opts.onGateWindow?.({ ...leader, poolSize: fused.length });
    if (abstentionFloor !== null && (leveled.length === 0 || leader.level < abstentionFloor)) {
      return { ids: [], abstained: true, reason: ABSTAIN_REASON };
    }
    if (relativeLevelRatio !== null) {
      gated = applyRelativeLevelFilter(leveled, leader.level, relativeLevelRatio);
    }
  }

  const boosted = applyRankingBoost(gated, opts);
  const diversified = diversityCap !== null ? applyDiversityCap(boosted, diversityCap) : boosted;

  const ids = diversified.map((r) => r.id);
  return { ids: ids.slice(opts.offset, opts.offset + opts.limit), abstained: false };
}

function poolLevels(
  pool: readonly { id: string }[],
  dense: readonly { id: string; score: number }[],
  opts: HybridSearchOpts,
): Map<string, { level: number; coverage: number; cosine: number }> {
  const scored = new Map<string, { level: number; coverage: number; cosine: number }>();
  if (pool.length === 0) return scored;
  const queryTokens = tokenSet(opts.query);
  const cosineById = new Map(dense.map((d) => [d.id, d.score]));
  const rows = opts.repos.memory.textByIds({
    ids: pool.map((r) => r.id),
    scope: opts.scope,
    projectId: opts.projectId,
    includeGlobal: opts.includeGlobal,
  });
  for (const r of rows) {
    scored.set(r.id, relevanceComponents(queryTokens, r, cosineById.get(r.id)));
  }
  return scored;
}

/**
 * The reference both gates measure against: the best-scoring row in the WHOLE
 * fused pool, with its own two components. Fusion orders by rank position, so
 * its first row is not necessarily the best-matching one. Maxing over the pool
 * rather than a `limit + offset` prefix is what makes a gate decision
 * independent of the requested page and of the order the branches happened to
 * fuse in; ties resolve to the earliest row in fused order.
 */
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

/**
 * Per-row relevance level in `[0,1]`: the greater of the query's token coverage
 * in the row's text and the row's dense cosine. Both are bounded and read only
 * the query and the row, so a calibrated threshold means the same thing at 40
 * rows and at 5,000. A row the dense branch never returned scores on coverage
 * alone.
 */
export function relevanceComponents(
  queryTokens: ReadonlySet<string>,
  row: { title: string; content: string },
  denseCosine: number | undefined,
): { level: number; coverage: number; cosine: number } {
  const coverage = tokenContainment(queryTokens, tokenSet(`${row.title}\n\n${row.content}`));
  const cosine = denseCosine ?? 0;
  return { level: Math.max(coverage, cosine), coverage, cosine };
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

// Declared clamp bounds; the per-signal weights below only ever reach
// [0.9, 1.35] in practice (see applyRankingBoost's docstring) — left
// unreachable-wide rather than tightened, since tightening changes no
// behavior and would misrepresent this as the fix. See fix-retrieval-ranking-math.
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
}

/**
 * Re-weights the fused pool by a multiplier clamped to `[BOOST_MIN,
 * BOOST_MAX]` (reachable range `[0.9, 1.35]` given the current per-signal
 * weights), applied BEFORE the `limit` truncation — so it CAN and is meant
 * to change page membership: a fresh, confirmed memory should outrank a
 * stale unconfirmed one at a close raw RRF score. The clamp bounds the
 * multiplier's magnitude; it does not, and is not meant to, prevent
 * reordering near-ties. Carries `sessionId` through from the same metadata
 * lookup so the diversity cap doesn't need a second query.
 */
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
    return { id, score: score * boost, sessionId: m?.sessionId ?? null };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * Walks the ranked pool in order, admitting at most `cap` rows per
 * originating session; a row over its session's cap is held back and
 * appended (in its original relative order) once the walk ends, so the
 * cap only ever reorders — it never shrinks the result count. Null-session
 * rows (pre-session or HTTP-written memories) are never grouped with each
 * other — treating "no session" as one session would cap all of them
 * together, the opposite of the intent.
 */
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

/**
 * FTS5/BM25 branch — fault-isolated (a parse error degrades to empty). Best
 * match first, ids only: RRF fuses on rank, and bm25 is unbounded and
 * corpus-relative, so no downstream gate may read its magnitude.
 */
function lexicalRetriever(opts: HybridSearchOpts, rankWindowSize: number): string[] {
  const matchExpr = sanitizeFtsQuery(opts.query);
  if (!matchExpr) return [];
  try {
    const rows = opts.repos.memory.searchBm25Ids({
      matchExpr,
      scope: opts.scope,
      projectId: opts.projectId,
      status: opts.status,
      type: opts.type,
      tag: opts.tag,
      topicKey: opts.topicKey,
      limit: rankWindowSize,
      includeGlobal: opts.includeGlobal,
    });
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * sqlite-vec kNN branch — fault-isolated. Skipped when no embedder is wired
 * or when searching `archived` (archived vectors are outside the
 * post-model-change semantic guarantee). `tag` is a bounded post-filter over
 * the rank window because tags are not duplicated into the vector index.
 * Best match first; `score` is cosine similarity (`1 - distance`), bounded [0,1].
 */
async function denseRetriever(
  opts: HybridSearchOpts,
  rankWindowSize: number,
): Promise<{ id: string; score: number }[]> {
  if (!opts.embedQuery || opts.status === 'archived') return [];
  // `memory_vec.status` is an exact-match metadata filter, so an any-status
  // read enumerates the two non-archived values rather than dropping the
  // predicate: archived vectors stay out of this branch either way.
  const statuses: Exclude<MemoryStatus, 'archived'>[] = opts.status
    ? [opts.status]
    : ['active', 'superseded'];
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
        statuses.flatMap((status) =>
          opts.repos.vectors.knnByQueryVector({
            queryVector,
            partitionKey,
            status,
            type: opts.type,
            rankWindowSize,
          }),
        ),
      )
      .sort((a, b) => a.distance - b.distance);
    // Dedup (nearest wins) before the slice — RRF needs distinct ids.
    const seen = new Set<string>();
    let scored: { id: string; score: number }[] = [];
    for (const n of neighbors) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      scored.push({ id: n.id, score: 1 - Math.max(0, Math.min(1, n.distance)) });
      if (scored.length >= rankWindowSize) break;
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
 * Split text into whole Unicode word/number tokens: splits on whitespace,
 * strips stray quotes, and drops tokens with no letter/number in any script
 * (does NOT split at non-ASCII chars or drop accented/CJK tokens, unlike a
 * naive ASCII-only tokenizer) — a quoted phrase of pure punctuation
 * tokenizes to nothing and is useless (and risks an empty-phrase parse
 * edge). Shared by `sanitizeFtsQuery` and the save-time candidate
 * detector's token-containment similarity, so both use one tokenization rule.
 */
export function tokenizeWords(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/"/g, '').trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) tokens.push(t);
  }
  return tokens;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenizeWords(text).map((t) => t.toLowerCase()));
}

/**
 * Corpus-independent lexical overlap: the fraction of `queryTokens` present in
 * `candidateTokens`. Bounded [0,1], unlike raw bm25 (unbounded, corpus-size
 * dependent, and inverted: see fix-retrieval-ranking-math).
 */
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

/**
 * Build a crash-proof FTS5 MATCH expression from arbitrary natural-language
 * text: quotes each token as a phrase — which neutralizes FTS5
 * metacharacters AND bareword operators (AND/OR/NOT/NEAR) in one move —
 * optionally capped at `maxTerms` OR-phrases (save-time candidate detection
 * passes a cap; interactive search does not). The OR between quoted phrases
 * is the intended fusion-friendly recall semantics; a user's literal "OR"
 * becomes the phrase `"or"`. Returns '' when nothing usable remains (caller
 * skips the lexical branch).
 */
export function sanitizeFtsQuery(query: string, opts?: { maxTerms?: number }): string {
  const tokens = tokenizeWords(query);
  const capped = opts?.maxTerms !== undefined ? tokens.slice(0, opts.maxTerms) : tokens;
  return capped.map((t) => `"${t}"`).join(' OR ');
}
