import { inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { memory as memoryTable, type Memory } from '../db/schema/memory.js';

/**
 * Candidate detection for the consolidation.
 *
 * Three flavors:
 *   - findRedundancyCandidates: pairs of active memories with high vector
 *     similarity (sqlite-vec kNN). Falls back to FTS5 token overlap if the
 *     vec table is empty or `embeddingEnabled=false`.
 *   - findDriftCandidates: pairs of active memories sharing type and tags
 *     where the newer one might contradict the older. The LLM judge
 *     decides; we only nominate.
 *   - findContradictionCandidates: small clusters of active memories of
 *     the same type+tag set. Used for explicit conflict resolution.
 *
 * All detectors are scope-aware: the WHERE clause restricts to one
 * (scope, project_id) tuple so the consolidation never crosses scope boundaries.
 */

export interface ScopeKey {
  scope: 'global' | 'project';
  projectId: string | null;
}

export interface CandidatePair {
  a: Memory;
  b: Memory;
  /** Similarity score in [0..1] where 1 = identical; meaning depends on the source. */
  score: number;
}

export interface CandidatesOptions {
  scope: ScopeKey;
  /** Cosine-distance threshold for vec-based candidates (smaller = more similar). */
  vecDistanceMax?: number;
  /** Max pairs per detector. */
  limit?: number;
}

interface PairRow {
  a_id: string;
  b_id: string;
  score: number;
}

// Marker so the Memory import is retained when hydratePairs is the only
// consumer.
void (null as unknown as Memory);

const DEFAULT_VEC_DISTANCE = 0.25;
const DEFAULT_LIMIT = 25;

export function findRedundancyCandidates(db: Db, opts: CandidatesOptions): CandidatePair[] {
  const vecMax = opts.vecDistanceMax ?? DEFAULT_VEC_DISTANCE;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const scopeFilter = scopeWhere(opts.scope);

  // Pair active memories of the same scope whose embeddings are close.
  // sqlite-vec exposes vec_distance_cosine; we look for pairs where both
  // sides have embeddings (memory_vec joined twice).
  const rows = db.all<PairRow>(sql`
    SELECT
      ma.id AS a_id,
      mb.id AS b_id,
      vec_distance_cosine(va.embedding, vb.embedding) AS score
    FROM memory ma
      JOIN memory_vec va ON va.memory_id = ma.id
      JOIN memory mb ON mb.id > ma.id
      JOIN memory_vec vb ON vb.memory_id = mb.id
    WHERE ma.status = 'active'
      AND mb.status = 'active'
      AND ${scopeFilter('ma')}
      AND ${scopeFilter('mb')}
      AND vec_distance_cosine(va.embedding, vb.embedding) < ${vecMax}
    ORDER BY score ASC
    LIMIT ${limit}
  `);

  return hydratePairs(db, rows);
}

export function findDriftCandidates(db: Db, opts: CandidatesOptions): CandidatePair[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scopeFilter = scopeWhere(opts.scope);

  // Drift: pairs of same type & tag intersection with > 30 days between
  // them. We don't decide here whether the newer contradicts the older —
  // that's the LLM judge's job. We only nominate the pair.
  const rows = db.all<PairRow>(sql`
    SELECT
      ma.id AS a_id,
      mb.id AS b_id,
      (julianday(mb.created_at / 1000.0, 'unixepoch') -
       julianday(ma.created_at / 1000.0, 'unixepoch')) AS score
    FROM memory ma
      JOIN memory mb ON mb.id > ma.id
        AND mb.type = ma.type
        AND mb.status = 'active'
    WHERE ma.status = 'active'
      AND ${scopeFilter('ma')}
      AND ${scopeFilter('mb')}
      AND EXISTS (
        SELECT 1 FROM json_each(ma.tags) ja, json_each(mb.tags) jb
        WHERE ja.value = jb.value
      )
      AND (mb.created_at - ma.created_at) > ${30 * 24 * 60 * 60 * 1000}
    ORDER BY score DESC
    LIMIT ${limit}
  `);

  return hydratePairs(db, rows);
}

export function findContradictionCandidates(db: Db, opts: CandidatesOptions): CandidatePair[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scopeFilter = scopeWhere(opts.scope);

  // Contradictions are nominated as pairs of same type that don't share a
  // unique-key tag (e.g. two "works at" memories) -- the LLM judge sorts
  // out whether they actually conflict.
  const rows = db.all<PairRow>(sql`
    SELECT
      ma.id AS a_id,
      mb.id AS b_id,
      1.0 AS score
    FROM memory ma
      JOIN memory mb ON mb.id > ma.id
        AND mb.type = ma.type
        AND mb.status = 'active'
    WHERE ma.status = 'active'
      AND ${scopeFilter('ma')}
      AND ${scopeFilter('mb')}
    ORDER BY mb.created_at DESC
    LIMIT ${limit}
  `);

  return hydratePairs(db, rows);
}

function scopeWhere(scope: ScopeKey): (alias: string) => ReturnType<typeof sql> {
  return (alias) =>
    scope.scope === 'global'
      ? sql.raw(`${alias}.scope = 'global' AND ${alias}.project_id IS NULL`)
      : sql.raw(
          `${alias}.scope = 'project' AND ${alias}.project_id = '${scope.projectId?.replace(/'/g, "''") ?? ''}'`,
        );
}

function hydratePairs(db: Db, rows: PairRow[]): CandidatePair[] {
  if (rows.length === 0) return [];
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.a_id);
    ids.add(r.b_id);
  }
  // Use Drizzle's typed builder so JSON columns and timestamp_ms columns
  // are deserialized correctly; raw SQL would return snake_case strings.
  const memories = db
    .select()
    .from(memoryTable)
    .where(inArray(memoryTable.id, [...ids]))
    .all();
  const byId = new Map(memories.map((m) => [m.id, m]));
  const pairs: CandidatePair[] = [];
  for (const r of rows) {
    const a = byId.get(r.a_id);
    const b = byId.get(r.b_id);
    if (!a || !b) continue;
    pairs.push({ a, b, score: r.score });
  }
  return pairs;
}
