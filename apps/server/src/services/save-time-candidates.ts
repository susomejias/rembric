import type { Repositories } from '../db/repositories/index.js';
import type { Memory } from '../db/schema/memory.js';

import { sanitizeFtsQuery, tokenizeWords } from './hybrid-search.js';

/**
 * Save-time candidate detector for `memory.save`.
 *
 * Runs two passes, deduplicates by target id, ranks by max(vec, fts),
 * returns the top N.
 *
 *   1. Vec kNN (when an embedding for the just-saved row already
 *      exists; otherwise this pass is a no-op for THIS save and the
 *      FTS pass below picks up the slack).
 *   2. FTS5 BM25 query against the row's content.
 *
 * Scope isolation: the SQL filters by `(scope, project_id)` matching
 * the just-saved row. Rows already linked to it via `replaces` are
 * excluded.
 *
 * The detector NEVER inserts rows — it only proposes pairs. The caller
 * (in `MemoryService.save`) decides which to surface to the agent and
 * which to leave to the consolidator.
 */

/**
 * Vec similarity floor is an engine constant calibrated for the compiled-in
 * embedding model (gte-multilingual-base q8) — not operator configuration.
 * Sandbox-calibrated on a 16-pair battery (positives 0.73–0.97, negatives
 * 0.43–0.68); revisit against backfill distribution logs.
 *
 * The lexical side has no equivalent absolute floor: FTS5's raw bm25 is
 * unbounded and scales with corpus size and term IDF, so no fixed threshold
 * over it is stable (see fix-retrieval-ranking-math). Lexical admission is
 * by rank position within the already bm25-ordered pool instead — the SQL
 * `ORDER BY rank LIMIT poolSize` in `searchBm25Candidates` IS the admission
 * rule; there is no separate gate.
 */
export const VEC_THRESHOLD = 0.7;

export interface CandidateOptions {
  perSaveMax: number;
  /** Internal candidate pool size before the cap is applied; default 20. */
  poolSize?: number;
}

export interface SaveCandidate {
  targetId: string;
  /** 0..1, normalized */
  similarity: number;
  /** Which detector surfaced this match. */
  source: 'vec' | 'fts';
  title: string;
  snippet: string;
  topicKey: string | null;
}

export function findSaveTimeCandidates(
  repos: Pick<Repositories, 'memory' | 'vectors' | 'relations'>,
  saved: Memory,
  opts: CandidateOptions,
): SaveCandidate[] {
  const poolSize = opts.poolSize ?? 20;

  // Suppress targets the new memory's ancestry (`replaces`) already judged
  // `not_conflict`, so a re-save never re-surfaces an already-dismissed pair.
  const dismissedIds =
    saved.replaces.length > 0
      ? repos.relations.listNotConflictTargetsForSources(saved.replaces)
      : [];
  const excludeIds = [...saved.replaces, ...dismissedIds];

  // Vec kNN is only useful once the just-saved row has an embedding (the
  // worker may not have processed it yet); otherwise the FTS pass below
  // picks up the slack.
  const vecRows = repos.vectors.knnCandidates({
    memoryId: saved.id,
    scope: saved.scope,
    projectId: saved.projectId,
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

  // Admission is by rank position: the query already orders by bm25 best-
  // first and LIMITs to poolSize, so every returned row is admitted. The
  // REPORTED similarity is a separate concern — bounded token containment
  // over the sanitized token set, truthful against its documented `0..1`
  // range and comparable enough to cosine for the max(vec, fts) merge below.
  const matchExpr = sanitizeFtsQuery(saved.content, { maxTerms: 16 });
  const ftsPool: SaveCandidate[] = [];
  if (matchExpr.length > 0) {
    const ftsRows = repos.memory.searchBm25Candidates({
      matchExpr,
      excludeId: saved.id,
      scope: saved.scope,
      projectId: saved.projectId,
      excludeIds,
      limit: poolSize,
    });
    const queryTokens = tokenSet(saved.content);
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

  // --- 3. Merge + dedupe ----------------------------------------------
  // For each unique target id, keep the higher-scoring source (vec wins
  // ties because vec is semantic, fts is lexical). Both similarities are
  // now bounded [0,1] and corpus-independent, so this comparison is
  // meaningful — it wasn't while fts reported an inverted, unbounded proxy.
  const byId = new Map<string, SaveCandidate>();
  for (const c of [...vecPool, ...ftsPool]) {
    const prev = byId.get(c.targetId);
    if (!prev || c.similarity > prev.similarity) byId.set(c.targetId, c);
  }
  const all = [...byId.values()].sort((a, b) => b.similarity - a.similarity);
  return all.slice(0, opts.perSaveMax);
}

function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}

/** Lowercased token set, built on `hybrid-search.ts`'s shared word tokenizer. */
function tokenSet(text: string): Set<string> {
  return new Set(tokenizeWords(text).map((t) => t.toLowerCase()));
}

/**
 * Corpus-independent lexical overlap: the fraction of `queryTokens` also
 * present in `candidateTokens`. Bounded [0, 1] by construction — a candidate
 * whose text is byte-identical to the query text scores exactly 1.0, and a
 * candidate sharing only a near-universal term with a large query scores
 * near 0, unlike raw bm25 (unbounded, corpus-size dependent, and inverted:
 * see fix-retrieval-ranking-math). Iterates the smaller of the two sets —
 * the intersection size doesn't depend on which side you walk.
 */
function tokenContainment(queryTokens: Set<string>, candidateTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const [small, large] =
    queryTokens.size <= candidateTokens.size
      ? [queryTokens, candidateTokens]
      : [candidateTokens, queryTokens];
  let hits = 0;
  for (const t of small) if (large.has(t)) hits++;
  return hits / queryTokens.size;
}
