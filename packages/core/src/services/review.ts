import { type MemoryStatus, type MemoryType } from '@rembric/db';

export type ReviewState = 'fresh' | 'needs_review';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const months = (n: number): number => n * MONTH_MS;

export const REVIEW_TTL_MS: Partial<Record<MemoryType, number>> = {
  procedural: months(2),
  project: months(3),
  feedback: months(6),
  user: months(12),
};

export function ttlForType(type: MemoryType): number | undefined {
  return REVIEW_TTL_MS[type];
}

/** `REVIEW_TTL_MS` as tuples, for the SQL layer's per-type CASE ladders. */
export function reviewTtlEntries(): ReadonlyArray<readonly [MemoryType, number]> {
  return Object.entries(REVIEW_TTL_MS).filter(
    (e): e is [MemoryType, number] => typeof e[1] === 'number',
  );
}

export const ESCALATION_MULTIPLIER = 2;

export const REFUTED_PRIORITY_MS = 14 * 24 * 60 * 60 * 1000;

export interface DeriveReviewInput {
  type: MemoryType;
  createdAt: Date;
  status: MemoryStatus;
  /** event_ts of the most recent AFFIRMING confirmation, if any. */
  lastConfirmedAt: Date | null;
  /** event_ts of the most recent REFUTING confirmation, if any. */
  lastRefutedAt: Date | null;
}

export interface DerivedReview {
  reviewState: ReviewState | null;
  reviewAfter: Date | null;
  /** max(createdAt, lastConfirmedAt) — null for non-active memories. */
  reviewBaseline: Date | null;
  reviewEscalated: boolean;
}

export function deriveReviewState(input: DeriveReviewInput, now: Date): DerivedReview {
  if (input.status !== 'active') {
    return { reviewState: null, reviewAfter: null, reviewBaseline: null, reviewEscalated: false };
  }
  const baselineMs = Math.max(
    input.createdAt.getTime(),
    input.lastConfirmedAt?.getTime() ?? input.createdAt.getTime(),
  );
  const reviewBaseline = new Date(baselineMs);
  const ttl = ttlForType(input.type);
  const escalated =
    ttl !== undefined && baselineMs + ttl * (1 + ESCALATION_MULTIPLIER) <= now.getTime();

  const refutedSinceBaseline =
    input.lastRefutedAt !== null && input.lastRefutedAt.getTime() > baselineMs;
  if (refutedSinceBaseline) {
    return {
      reviewState: 'needs_review',
      reviewAfter: input.lastRefutedAt,
      reviewBaseline,
      reviewEscalated: escalated,
    };
  }

  if (ttl === undefined) {
    return { reviewState: 'fresh', reviewAfter: null, reviewBaseline, reviewEscalated: false };
  }
  const reviewAfter = new Date(baselineMs + ttl);
  const reviewState: ReviewState =
    reviewAfter.getTime() <= now.getTime() ? 'needs_review' : 'fresh';
  return { reviewState, reviewAfter, reviewBaseline, reviewEscalated: escalated };
}
