import type { Repositories } from '../db/repositories/index.js';
import type { Memory } from '../db/schema/memory.js';

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
 * Similarity floors are engine constants calibrated for the compiled-in
 * embedding model (gte-multilingual-base q8) — not operator configuration.
 * VEC: sandbox-calibrated on a 16-pair battery (positives 0.73–0.97,
 * negatives 0.43–0.68); revisit against backfill distribution logs.
 * FTS: BM25-derived proxy `1/(1+|rank|)` — corpus-size sensitive, same
 * recalibration channel.
 */
export const VEC_THRESHOLD = 0.7;
export const FTS_THRESHOLD = 0.4;

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
  snippet: string;
}

export function findSaveTimeCandidates(
  repos: Pick<Repositories, 'memory' | 'vectors'>,
  saved: Memory,
  opts: CandidateOptions,
): SaveCandidate[] {
  const poolSize = opts.poolSize ?? 20;

  // Vec kNN is only useful once the just-saved row has an embedding (the
  // worker may not have processed it yet); otherwise the FTS pass below
  // picks up the slack.
  const vecRows = repos.vectors.knnByCosine({
    memoryId: saved.id,
    scope: saved.scope,
    projectId: saved.projectId,
    excludeIds: saved.replaces,
    limit: poolSize,
  });
  const vecPool: SaveCandidate[] = vecRows
    .map((r) => ({
      targetId: r.id,
      similarity: 1 - Math.max(0, Math.min(1, r.distance)),
      source: 'vec' as const,
      snippet: snippet(r.content, 200),
    }))
    .filter((c) => c.similarity >= VEC_THRESHOLD);

  // BM25 returns lower-is-better; normalize via 1/(1+|rank|) to a [0,1]
  // proxy, then keep matches above the configured threshold.
  const matchExpr = escapeFts(saved.content);
  const ftsPool: SaveCandidate[] = [];
  if (matchExpr.length > 0) {
    const ftsRows = repos.memory.searchBm25Candidates({
      matchExpr,
      excludeId: saved.id,
      scope: saved.scope,
      projectId: saved.projectId,
      excludeIds: saved.replaces,
      limit: poolSize,
    });
    for (const r of ftsRows) {
      const sim = 1 / (1 + Math.abs(r.rank));
      if (sim >= FTS_THRESHOLD) {
        ftsPool.push({
          targetId: r.id,
          similarity: sim,
          source: 'fts',
          snippet: snippet(r.content, 200),
        });
      }
    }
  }

  // --- 3. Merge + dedupe ----------------------------------------------
  // For each unique target id, keep the higher-scoring source (vec wins
  // ties because vec is semantic, fts is lexical).
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

/**
 * Build an FTS5 MATCH expression from user-supplied content.
 *
 * Strategy: extract alphanumeric tokens, drop very short / noise tokens,
 * uniquify, cap at 16 terms, then OR them together. We avoid a phrase
 * match because it requires the exact ngram to appear verbatim in the
 * indexed document; for candidate detection we want "any overlap" with
 * BM25 ranking those that overlap more.
 *
 * Returns an empty string when no usable tokens are found; the caller
 * skips the query in that case (no candidates is the right answer).
 */
function escapeFts(text: string): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(`"${raw}"`);
    if (tokens.length >= 16) break;
  }
  if (tokens.length === 0) return '';
  return tokens.join(' OR ');
}
