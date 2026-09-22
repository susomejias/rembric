import { type MemoryType, type Repositories } from '@rembric/db';

import type { ScopeKey } from './candidates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DecayThresholds {
  thresholdByType: Partial<Record<MemoryType, number>>;
  /** Fallback window for any type without an explicit per-type entry. */
  defaultThresholdMs: number;
  /** Minimum confirmation count below which decay applies. */
  confidenceFloor: number;
}

export const DEFAULT_DECAY: DecayThresholds = {
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
    projectId: scope.projectId,
    nowMs: now.getTime(),
    thresholdByType,
    defaultThresholdMs: thresholds.defaultThresholdMs,
    confidenceFloor: thresholds.confidenceFloor,
  });
}
