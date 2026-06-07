import type { Repositories } from '../db/repositories/index.js';

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

export function findDecayCandidates(
  repos: Pick<Repositories, 'memory'>,
  scope: ScopeKey,
  thresholds: DecayThresholds = DEFAULT_DECAY,
  now: Date = new Date(),
): string[] {
  const cutoff = new Date(now.getTime() - thresholds.thresholdMs);
  return repos.memory.findDecayCandidateIds(
    scope.scope,
    scope.projectId,
    cutoff,
    thresholds.confidenceFloor,
  );
}
