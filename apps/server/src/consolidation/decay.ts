import type { Repositories } from '../db/repositories/index.js';
import type { MemoryType } from '../db/schema/memory.js';

import type { ScopeKey } from './candidates.js';

/**
 * Identify memories eligible for deterministic decay (archive).
 *
 * Rule: status='active' AND last_seen_at < now - per-type threshold
 * AND confidence < confidenceFloor. Reads nothing from the review axis: the two
 * are orthogonal and escalation is derived at read time, never swept.
 *
 * Returns the ids only; the consolidation runner records the op via
 * `applyDecay`. No LLM call is required for this category.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DecayThresholds {
  /**
   * Per-type `last_seen_at` inactivity window before decay considers a row.
   * Mirrors the SHAPE of `REVIEW_TTL_MS` but is a SEPARATE constant on
   * purpose: decay (access + confidence, keyed on `last_seen_at`) and review
   * (affirmation, keyed on `created_at` + per-type TTL) stay orthogonal axes.
   */
  thresholdByType: Partial<Record<MemoryType, number>>;
  /** Fallback window for any type without an explicit per-type entry. */
  defaultThresholdMs: number;
  /** Minimum confirmation count below which decay applies. */
  confidenceFloor: number;
}

export const DEFAULT_DECAY: DecayThresholds = {
  // Decay ≥ the review TTL of the same type (decay is a hard archive, review a
  // soft nudge). `reference` decays effectively never, matching its deliberate
  // absence from `REVIEW_TTL_MS`. Any type without an entry falls back to
  // `defaultThresholdMs` (the historical global 90-day behaviour).
  thresholdByType: {
    procedural: 120 * DAY_MS,
    project: 180 * DAY_MS,
    feedback: 365 * DAY_MS,
    user: 730 * DAY_MS,
    reference: 3650 * DAY_MS,
  },
  defaultThresholdMs: 90 * DAY_MS,
  confidenceFloor: 1,
};

export function findDecayCandidates(
  repos: Pick<Repositories, 'memory'>,
  scope: ScopeKey,
  thresholds: DecayThresholds = DEFAULT_DECAY,
  now: Date = new Date(),
): string[] {
  const thresholdByType = Object.entries(thresholds.thresholdByType).filter(
    (e): e is [MemoryType, number] => typeof e[1] === 'number',
  );
  return repos.memory.findDecayCandidateIds({
    scope: scope.scope,
    projectId: scope.projectId,
    nowMs: now.getTime(),
    thresholdByType,
    defaultThresholdMs: thresholds.defaultThresholdMs,
    confidenceFloor: thresholds.confidenceFloor,
  });
}
