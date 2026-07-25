import { describe, expect, it } from 'vitest';

import { deriveReviewState, ESCALATION_MULTIPLIER, REVIEW_TTL_MS } from './review.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

describe('deriveReviewState', () => {
  it('a freshly created memory of a TTL type is fresh', () => {
    const r = deriveReviewState(
      {
        type: 'project',
        createdAt: NOW,
        status: 'active',
        lastConfirmedAt: null,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(r.reviewState).toBe('fresh');
    expect(r.reviewBaseline?.getTime()).toBe(NOW.getTime());
    expect(r.reviewAfter?.getTime()).toBe(NOW.getTime() + REVIEW_TTL_MS.project!);
  });

  it('an unaffirmed memory past its shelf life needs review', () => {
    const created = new Date(NOW.getTime() - 4 * MONTH_MS); // project TTL is 3mo
    const r = deriveReviewState(
      {
        type: 'project',
        createdAt: created,
        status: 'active',
        lastConfirmedAt: null,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(r.reviewState).toBe('needs_review');
    expect(r.reviewBaseline?.getTime()).toBe(created.getTime());
  });

  it('a recent confirmation advances the baseline and clears needs_review', () => {
    const created = new Date(NOW.getTime() - 4 * MONTH_MS);
    const confirmed = new Date(NOW.getTime() - 1 * MONTH_MS);
    const r = deriveReviewState(
      {
        type: 'project',
        createdAt: created,
        status: 'active',
        lastConfirmedAt: confirmed,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(r.reviewState).toBe('fresh');
    expect(r.reviewBaseline?.getTime()).toBe(confirmed.getTime());
    expect(r.reviewAfter?.getTime()).toBe(confirmed.getTime() + REVIEW_TTL_MS.project!);
  });

  it('exactly at the deadline counts as needs_review', () => {
    const created = new Date(NOW.getTime() - REVIEW_TTL_MS.project!);
    const r = deriveReviewState(
      {
        type: 'project',
        createdAt: created,
        status: 'active',
        lastConfirmedAt: null,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(r.reviewState).toBe('needs_review');
  });

  it('a type without a TTL is always fresh with a null reviewAfter', () => {
    const created = new Date(NOW.getTime() - 100 * MONTH_MS);
    const r = deriveReviewState(
      {
        type: 'reference',
        createdAt: created,
        status: 'active',
        lastConfirmedAt: null,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(r.reviewState).toBe('fresh');
    expect(r.reviewAfter).toBeNull();
    expect(r.reviewBaseline?.getTime()).toBe(created.getTime());
  });

  it('procedural needs review on its own (shortest) schedule, distinct from project', () => {
    expect(REVIEW_TTL_MS.procedural!).toBeLessThan(REVIEW_TTL_MS.project!);
    const created = new Date(NOW.getTime() - REVIEW_TTL_MS.procedural! - 1);
    const r = deriveReviewState(
      {
        type: 'procedural',
        createdAt: created,
        status: 'active',
        lastConfirmedAt: null,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(r.reviewState).toBe('needs_review');

    // The same age would still be fresh under project's longer TTL.
    const stillFresh = deriveReviewState(
      {
        type: 'project',
        createdAt: created,
        status: 'active',
        lastConfirmedAt: null,
        lastRefutedAt: null,
      },
      NOW,
    );
    expect(stillFresh.reviewState).toBe('fresh');
  });

  it('non-active memories carry no review state', () => {
    const created = new Date(NOW.getTime() - 100 * MONTH_MS);
    for (const status of ['superseded', 'archived'] as const) {
      const r = deriveReviewState(
        { type: 'project', createdAt: created, status, lastConfirmedAt: null, lastRefutedAt: null },
        NOW,
      );
      expect(r.reviewState).toBeNull();
      expect(r.reviewAfter).toBeNull();
      expect(r.reviewBaseline).toBeNull();
    }
  });

  describe('refutation (separate-access-from-usefulness)', () => {
    it('a refutation more recent than the affirmation baseline forces needs_review immediately, even within TTL', () => {
      const r = deriveReviewState(
        {
          type: 'project',
          createdAt: NOW,
          status: 'active',
          lastConfirmedAt: null,
          lastRefutedAt: new Date(NOW.getTime() + 1000),
        },
        new Date(NOW.getTime() + 2000),
      );
      expect(r.reviewState).toBe('needs_review');
      expect(r.reviewAfter?.getTime()).toBe(NOW.getTime() + 1000);
    });

    it('forces needs_review even for a type with NO TTL (reference)', () => {
      const r = deriveReviewState(
        {
          type: 'reference',
          createdAt: NOW,
          status: 'active',
          lastConfirmedAt: null,
          lastRefutedAt: new Date(NOW.getTime() + 1000),
        },
        new Date(NOW.getTime() + 2000),
      );
      expect(r.reviewState).toBe('needs_review');
    });

    it('a later affirmation clears a prior refutation (re-affirming advances the baseline past it)', () => {
      const refuted = new Date(NOW.getTime() + 1000);
      const reaffirmed = new Date(NOW.getTime() + 2000);
      const r = deriveReviewState(
        {
          type: 'project',
          createdAt: NOW,
          status: 'active',
          lastConfirmedAt: reaffirmed,
          lastRefutedAt: refuted,
        },
        new Date(NOW.getTime() + 3000),
      );
      expect(r.reviewState).toBe('fresh');
      expect(r.reviewBaseline?.getTime()).toBe(reaffirmed.getTime());
    });

    it('a refutation OLDER than the affirmation baseline does not force needs_review', () => {
      const refuted = new Date(NOW.getTime());
      const affirmed = new Date(NOW.getTime() + 1000);
      const r = deriveReviewState(
        {
          type: 'project',
          createdAt: NOW,
          status: 'active',
          lastConfirmedAt: affirmed,
          lastRefutedAt: refuted,
        },
        new Date(NOW.getTime() + 2000),
      );
      expect(r.reviewState).toBe('fresh');
    });
  });

  describe('escalation', () => {
    const PROJECT_TTL = REVIEW_TTL_MS.project!;
    const derive = (agedMs: number) =>
      deriveReviewState(
        {
          type: 'project',
          createdAt: new Date(NOW.getTime() - agedMs),
          status: 'active',
          lastConfirmedAt: null,
          lastRefutedAt: null,
        },
        NOW,
      );

    it('is greater than 1 (escalation threshold must exceed the base TTL)', () => {
      expect(ESCALATION_MULTIPLIER).toBeGreaterThan(1);
    });

    it('is not escalated while merely needs_review', () => {
      const r = derive(PROJECT_TTL + 1);
      expect(r.reviewState).toBe('needs_review');
      expect(r.reviewEscalated).toBe(false);
    });

    // needs_review starts at 1x TTL, so N further multiples land at 1 + N.
    it('escalates only after ESCALATION_MULTIPLIER further multiples in the queue', () => {
      expect(derive(PROJECT_TTL * (1 + ESCALATION_MULTIPLIER) - 1).reviewEscalated).toBe(false);
      expect(derive(PROJECT_TTL * (1 + ESCALATION_MULTIPLIER) + 1).reviewEscalated).toBe(true);
    });

    it('a no-TTL type never escalates', () => {
      const r = deriveReviewState(
        {
          type: 'reference',
          createdAt: new Date(0),
          status: 'active',
          lastConfirmedAt: null,
          lastRefutedAt: null,
        },
        NOW,
      );
      expect(r.reviewEscalated).toBe(false);
    });
  });
});
