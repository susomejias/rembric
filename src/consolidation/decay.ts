import { and, eq, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { confirmations } from '../db/schema/confirmations.js';
import { memory } from '../db/schema/memory.js';

/**
 * Identify memories eligible for deterministic decay (archive).
 *
 * Rule: status='active' AND last_seen_at < (now - thresholdMs) AND
 * confidence (count of confirmations) < confidenceFloor.
 *
 * Returns the ids only; the consolidation runner records the op via
 * `applyDecay`. No LLM call is required for this category.
 */

export interface DecayThresholds {
  /** How long without `last_seen_at` activity before decay considers a row. */
  thresholdMs: number;
  /** Minimum confirmation count below which decay applies. */
  confidenceFloor: number;
}

export const DEFAULT_DECAY: DecayThresholds = {
  thresholdMs: 90 * 24 * 60 * 60 * 1000,
  confidenceFloor: 1,
};

export interface ScopeKey {
  scope: 'global' | 'project';
  projectId: string | null;
}

interface DecayRow {
  id: string;
}

export function findDecayCandidates(
  db: Db,
  scope: ScopeKey,
  thresholds: DecayThresholds = DEFAULT_DECAY,
  now: Date = new Date(),
): string[] {
  const cutoff = new Date(now.getTime() - thresholds.thresholdMs);

  const scopeFilter =
    scope.scope === 'global'
      ? and(eq(memory.scope, 'global'), sql`${memory.projectId} IS NULL`)
      : and(eq(memory.scope, 'project'), eq(memory.projectId, scope.projectId ?? ''));

  const rows = db
    .select({ id: memory.id })
    .from(memory)
    .where(
      and(
        eq(memory.status, 'active'),
        lt(memory.lastSeenAt, cutoff),
        scopeFilter,
        sql`(SELECT count(*) FROM ${confirmations} WHERE ${confirmations.memoryId} = ${memory.id}) < ${thresholds.confidenceFloor}`,
      ),
    )
    .all() as DecayRow[];

  return rows.map((r) => r.id);
}
