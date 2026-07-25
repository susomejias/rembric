import type { MemoryStatus, MemoryType } from '../db/schema/memory.js';

/**
 * Time-based review (affirmation) axis — orthogonal to decay.
 *
 * Decay (consolidation/decay.ts) asks "is this an untrusted memory nobody
 * touches?" keyed on `last_seen_at` (advanced by dereferencing via
 * `memory.get`, NOT by being returned from a search). Review asks "has this
 * been re-affirmed within its shelf life?" keyed on the affirmation baseline
 * = max(created_at, latest AFFIRMING confirmation event_ts). Reading is
 * access, not affirmation, so `last_seen_at` is deliberately NOT used here.
 *
 * The state is derived at read time only — never persisted, no sweep, no
 * cron. Re-affirming is the existing `memory.confirm` (it records a
 * confirmation event that advances the baseline), so no new mutation verb
 * exists. See openspec/specs/memory/spec.md "derived review state".
 */

export type ReviewState = 'fresh' | 'needs_review';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const months = (n: number): number => n * MONTH_MS;

/**
 * Per-type shelf life. A type absent here never needs review. Values are
 * soft re-verification nudges, not hard expiries, and treat a "month" as a
 * fixed 30-day span (approximate by design — this is a hint, not a calendar
 * computation). Single source of truth: the SQL `findNeedsReview` ladder
 * is generated from this map so the numbers live in exactly one place.
 */
export const REVIEW_TTL_MS: Partial<Record<MemoryType, number>> = {
  // Shortest TTL of any type: a runbook describes a process that changes on
  // its own schedule, not the agent's, and a stale one silently gives wrong
  // operational steps in a way a stale decision record does not.
  procedural: months(2),
  project: months(3),
  feedback: months(6),
  user: months(12),
  // `reference` intentionally has NO TTL: a reference is a pointer (URL,
  // dashboard, ticket id) whose staleness surfaces as a broken link when
  // used, not on a clock — periodic "re-verify this bookmark" nags are
  // low value. Absent here => always `fresh`.
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

/**
 * Multiples of its own TTL a memory may sit `needs_review` before decay stops
 * requiring a stale `last_seen_at` — closing the "read regularly, never
 * re-affirmed, un-archivable" case. Types without a TTL never escalate.
 */
export const ESCALATION_MULTIPLIER = 2;

/**
 * How long a refutation keeps a memory at the head of the review queue.
 * Refuted rows lead because refutation deliberately does not advance the
 * affirmation baseline, so baseline ordering alone would bury a just-refuted
 * memory. The lead cannot be permanent: `memory.context` shows three rows, so
 * an unattended handful of refuted memories would otherwise starve every
 * TTL-expired row for good. Past the window the row still needs review — it
 * just queues by baseline like the rest. Matches the two weeks a pending
 * judgment gets before the sweep orphans it.
 */
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
  /**
   * Unaffirmed long enough that the deterministic sweep will now archive it,
   * which distinguishes a row a day overdue from one the queue has given up
   * on. Never true for a type without a TTL.
   */
  reviewEscalated: boolean;
}

/**
 * Pure derivation used by both the read projections (get/search) and the
 * `needsReview` context list, so they agree by construction.
 *
 * Non-active memories carry no review state. Types without a TTL are always
 * `fresh` with a null `reviewAfter` — UNLESS refuted more recently than the
 * last affirmation, which forces `needs_review` immediately regardless of
 * type or TTL: an explicit "this was wrong" outranks a clock that hasn't
 * finished counting down, and a `reference` memory (no TTL) is not exempt
 * from that just because it's never nagged on a schedule.
 */
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
