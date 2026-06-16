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
}

export async function hybridSearch(opts: HybridSearchOpts): Promise<string[]> {
  const rankWindowSize = Math.min(
    opts.limit + opts.offset + RANK_WINDOW_MARGIN,
    RANK_WINDOW_CEILING,
  );

  const lexical = lexicalRetriever(opts, rankWindowSize);
  const dense = await denseRetriever(opts, rankWindowSize);

  const fused = fuseRRF([dense, lexical], RANK_CONSTANT);
  return fused.slice(opts.offset, opts.offset + opts.limit);
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
  try {
    const queryVector = await opts.embedQuery(opts.query);
    const neighbors = opts.repos.vectors.knnByQueryVector({
      queryVector,
      partitionKey: partitionKeyFor(opts.scope, opts.projectId),
      status: opts.status,
      type: opts.type,
      rankWindowSize,
    });
    let ids = neighbors.map((n) => n.id);
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
export function fuseRRF(rankedLists: string[][], rankConstant = RANK_CONSTANT): string[] {
  const score = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (rankConstant + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Build a crash-proof FTS5 MATCH expression from arbitrary natural-language
 * text. Keeps whole Unicode word tokens (does NOT split at non-ASCII chars or
 * drop accented/CJK tokens — unlike the ASCII-only save-time `escapeFts`),
 * drops pure-punctuation tokens, and quotes each surviving token as a phrase —
 * which neutralizes FTS5 metacharacters AND bareword operators (AND/OR/NOT/
 * NEAR) in one move. The OR between quoted phrases is the intended fusion-
 * friendly recall semantics; a user's literal "OR" becomes the phrase `"or"`.
 * Returns '' when nothing usable remains (caller skips the lexical branch).
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const t = raw.replace(/"/g, '').trim();
    if (!t) continue;
    // Drop tokens with no letter/number in any script — a quoted phrase of
    // pure punctuation tokenizes to nothing and is useless (and risks an
    // empty-phrase parse edge).
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    tokens.push(`"${t}"`);
  }
  return tokens.join(' OR ');
}
