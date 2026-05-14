import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to burst requests in immediate succession', () => {
    const now = 1_000_000;
    const limiter = new RateLimiter({ ratePerSecond: 1, burst: 5 }, () => now);

    for (let i = 0; i < 5; i++) {
      const d = limiter.check('tok-1');
      expect(d.allowed).toBe(true);
    }
    const sixth = limiter.check('tok-1');
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills tokens at the configured rate', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ ratePerSecond: 2, burst: 2 }, () => now);

    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false);

    // 1 token accrues in 500ms at 2 rps.
    now += 500;
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false);
  });

  it('isolates buckets per key', () => {
    const now = 1_000_000;
    const limiter = new RateLimiter({ ratePerSecond: 1, burst: 1 }, () => now);

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(false);
  });

  it('clamps refill at the configured burst', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ ratePerSecond: 5, burst: 3 }, () => now);

    expect(limiter.check('k').allowed).toBe(true);
    // Sleep 10 seconds; bucket should clamp at burst=3, not balloon to 50.
    now += 10_000;
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false);
  });

  it('reports retry-after >= 1 second when denied', () => {
    const now = 1_000_000;
    const limiter = new RateLimiter({ ratePerSecond: 0.1, burst: 1 }, () => now);
    limiter.check('k');
    const d = limiter.check('k');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid configuration', () => {
    expect(() => new RateLimiter({ ratePerSecond: 0, burst: 1 })).toThrow();
    expect(() => new RateLimiter({ ratePerSecond: 1, burst: 0 })).toThrow();
  });
});
