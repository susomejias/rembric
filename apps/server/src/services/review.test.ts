import { describe, expect, it } from 'vitest';

import { deriveReviewState, REVIEW_TTL_MS } from './review.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

describe('deriveReviewState', () => {
  it('a freshly created memory of a TTL type is fresh', () => {
    const r = deriveReviewState(
      { type: 'project', createdAt: NOW, status: 'active', lastConfirmedAt: null },
      NOW,
    );
    expect(r.reviewState).toBe('fresh');
    expect(r.reviewBaseline?.getTime()).toBe(NOW.getTime());
    expect(r.reviewAfter?.getTime()).toBe(NOW.getTime() + REVIEW_TTL_MS.project!);
  });

  it('an unaffirmed memory past its shelf life needs review', () => {
    const created = new Date(NOW.getTime() - 4 * MONTH_MS); // project TTL is 3mo
    const r = deriveReviewState(
      { type: 'project', createdAt: created, status: 'active', lastConfirmedAt: null },
      NOW,
    );
    expect(r.reviewState).toBe('needs_review');
    expect(r.reviewBaseline?.getTime()).toBe(created.getTime());
  });

  it('a recent confirmation advances the baseline and clears needs_review', () => {
    const created = new Date(NOW.getTime() - 4 * MONTH_MS);
    const confirmed = new Date(NOW.getTime() - 1 * MONTH_MS);
    const r = deriveReviewState(
      { type: 'project', createdAt: created, status: 'active', lastConfirmedAt: confirmed },
      NOW,
    );
    expect(r.reviewState).toBe('fresh');
    expect(r.reviewBaseline?.getTime()).toBe(confirmed.getTime());
    expect(r.reviewAfter?.getTime()).toBe(confirmed.getTime() + REVIEW_TTL_MS.project!);
  });

  it('exactly at the deadline counts as needs_review', () => {
    const created = new Date(NOW.getTime() - REVIEW_TTL_MS.project!);
    const r = deriveReviewState(
      { type: 'project', createdAt: created, status: 'active', lastConfirmedAt: null },
      NOW,
    );
    expect(r.reviewState).toBe('needs_review');
  });

  it('a type without a TTL is always fresh with a null reviewAfter', () => {
    const created = new Date(NOW.getTime() - 100 * MONTH_MS);
    const r = deriveReviewState(
      { type: 'reference', createdAt: created, status: 'active', lastConfirmedAt: null },
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
      { type: 'procedural', createdAt: created, status: 'active', lastConfirmedAt: null },
      NOW,
    );
    expect(r.reviewState).toBe('needs_review');

    // The same age would still be fresh under project's longer TTL.
    const stillFresh = deriveReviewState(
      { type: 'project', createdAt: created, status: 'active', lastConfirmedAt: null },
      NOW,
    );
    expect(stillFresh.reviewState).toBe('fresh');
  });

  it('non-active memories carry no review state', () => {
    const created = new Date(NOW.getTime() - 100 * MONTH_MS);
    for (const status of ['superseded', 'archived'] as const) {
      const r = deriveReviewState(
        { type: 'project', createdAt: created, status, lastConfirmedAt: null },
        NOW,
      );
      expect(r.reviewState).toBeNull();
      expect(r.reviewAfter).toBeNull();
      expect(r.reviewBaseline).toBeNull();
    }
  });
});
