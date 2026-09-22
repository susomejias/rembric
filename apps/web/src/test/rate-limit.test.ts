import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthLockout } from '../lib/auth-lockout';
import {
  applyMcpRateLimit,
  getMcpRateLimiter,
  getRateLimitConfig,
  resetMcpRateLimiterForTests,
} from '../lib/rate-limit';

const CFG = { maxFailures: 3, windowMs: 60_000, lockoutMs: 30_000 };

describe('MCP rate-limit direct library integration', () => {
  beforeEach(() => {
    resetMcpRateLimiterForTests();
    delete process.env['RATE_LIMIT_ENABLED'];
    delete process.env['RATE_LIMIT_RPS'];
    delete process.env['RATE_LIMIT_BURST'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMcpRateLimiterForTests();
    delete process.env['RATE_LIMIT_ENABLED'];
    delete process.env['RATE_LIMIT_RPS'];
    delete process.env['RATE_LIMIT_BURST'];
  });

  it('preserves disabled defaults and derives a fractional fixed window', () => {
    expect(getRateLimitConfig({})).toEqual({
      enabled: false,
      ratePerSecond: 10,
      burst: 30,
      windowMs: 3000,
      durationSeconds: 3,
    });
    expect(
      getRateLimitConfig({
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_RPS: '20',
        RATE_LIMIT_BURST: '1',
      }),
    ).toEqual({
      enabled: true,
      ratePerSecond: 20,
      burst: 1,
      windowMs: 50,
      durationSeconds: 0.05,
    });
  });

  it('rejects malformed and unsafe configuration', () => {
    expect(() => getRateLimitConfig({ RATE_LIMIT_RPS: 'nope' })).toThrow(/RATE_LIMIT_RPS/);
    expect(() => getRateLimitConfig({ RATE_LIMIT_BURST: '1.5' })).toThrow(/RATE_LIMIT_BURST/);
    expect(() => getRateLimitConfig({ RATE_LIMIT_RPS: '10001' })).toThrow(/RATE_LIMIT_RPS/);
    expect(() => getRateLimitConfig({ RATE_LIMIT_RPS: '0.00000000000000001' })).toThrow(
      /windowMs|window/,
    );
    expect(() => getRateLimitConfig({ RATE_LIMIT_RPS: '0.0000000001' })).toThrow(/windowMs|window/);
  });

  it('does not create a limiter when disabled and caches one per configuration', () => {
    expect(getMcpRateLimiter()).toBeNull();

    process.env['RATE_LIMIT_ENABLED'] = 'true';
    const first = getMcpRateLimiter();
    const second = getMcpRateLimiter();
    expect(first).toBeInstanceOf(RateLimiterMemory);
    expect(second).toBe(first);

    resetMcpRateLimiterForTests();
    expect(getMcpRateLimiter()).not.toBe(first);
  });

  it('enforces points per key and returns safe legacy 429 JSON metadata', async () => {
    process.env['RATE_LIMIT_ENABLED'] = 'true';
    process.env['RATE_LIMIT_RPS'] = '10';
    process.env['RATE_LIMIT_BURST'] = '2';

    expect(await applyMcpRateLimit('token-a', 'name-a')).toBeNull();
    expect(await applyMcpRateLimit('token-a', 'name-a')).toBeNull();
    const blocked = await applyMcpRateLimit('token-a', 'token "quoted"');
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    expect(await blocked?.json()).toEqual({
      ok: false,
      code: 'rate_limited',
      message: 'token \'token "quoted"\' exceeded its rate limit; retry in 1s',
      retryAfterSeconds: 1,
    });
    expect(await applyMcpRateLimit('token-b', 'name-b')).toBeNull();
  });

  it('throws unexpected consume errors instead of treating them as allowed', async () => {
    process.env['RATE_LIMIT_ENABLED'] = 'true';
    const limiter = getMcpRateLimiter();
    if (limiter === null) throw new Error('fixture: limiter is disabled');
    vi.spyOn(limiter, 'consume').mockRejectedValueOnce(new Error('store failure'));

    await expect(applyMcpRateLimit('token-a', 'token-a')).rejects.toThrow('store failure');
  });
});

describe('AuthLockout', () => {
  it('does not lock a fresh identity', () => {
    const lockout = new AuthLockout(CFG, () => 1_000_000);
    expect(lockout.check('1.2.3.4')).toEqual({ locked: false, retryAfterSeconds: 0 });
  });

  it('locks after maxFailures within the window and reports retry-after', () => {
    const now = 1_000_000;
    const lockout = new AuthLockout(CFG, () => now);
    lockout.recordFailure('1.2.3.4');
    lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4').locked).toBe(false);
    lockout.recordFailure('1.2.3.4'); // 3rd = threshold
    const decision = lockout.check('1.2.3.4');
    expect(decision.locked).toBe(true);
    expect(decision.retryAfterSeconds).toBe(30);
  });

  it('lifts the lockout once lockoutMs elapses', () => {
    let now = 1_000_000;
    const lockout = new AuthLockout(CFG, () => now);
    for (let i = 0; i < 3; i++) lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4').locked).toBe(true);
    now += 30_001;
    expect(lockout.check('1.2.3.4').locked).toBe(false);
  });

  it('reports a retry-after of at least one second while locked', () => {
    const now = 1_000_000;
    // Belt and braces: the `Math.max(1, …)` clamp is what stops a sub-second
    // remainder from advertising `Retry-After: 0`.
    const lockout = new AuthLockout({ ...CFG, lockoutMs: 1_000 }, () => now);
    for (let i = 0; i < 3; i++) lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4').retryAfterSeconds).toBe(1);
  });

  it('forgets failures that fall outside the window instead of accumulating them', () => {
    let now = 1_000_000;
    const lockout = new AuthLockout(CFG, () => now);
    lockout.recordFailure('1.2.3.4');
    lockout.recordFailure('1.2.3.4');
    now += CFG.windowMs + 1; // the window lapses; the counter restarts
    lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4').locked).toBe(false);
    lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4').locked).toBe(false);
    lockout.recordFailure('1.2.3.4'); // 3rd inside the new window
    expect(lockout.check('1.2.3.4').locked).toBe(true);
  });

  it('a success clears the failure record so the identity is never penalised', () => {
    const now = 1_000_000;
    const lockout = new AuthLockout(CFG, () => now);
    lockout.recordFailure('1.2.3.4');
    lockout.recordFailure('1.2.3.4');
    lockout.recordSuccess('1.2.3.4');
    lockout.recordFailure('1.2.3.4');
    lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4').locked).toBe(false); // counter restarted
  });

  it('keys identities independently', () => {
    const now = 1_000_000;
    const lockout = new AuthLockout(CFG, () => now);
    for (let i = 0; i < 3; i++) lockout.recordFailure('1.1.1.1');
    expect(lockout.check('1.1.1.1').locked).toBe(true);
    expect(lockout.check('2.2.2.2').locked).toBe(false);
    // A success on one identity must not clear another's failures.
    lockout.recordSuccess('2.2.2.2');
    expect(lockout.check('1.1.1.1').locked).toBe(true);
  });

  it('locks on the very first failure when maxFailures is 1', () => {
    const lockout = new AuthLockout({ ...CFG, maxFailures: 1 }, () => 1_000_000);
    lockout.recordFailure('1.2.3.4');
    expect(lockout.check('1.2.3.4')).toEqual({ locked: true, retryAfterSeconds: 30 });
  });

  it('rejects invalid configuration', () => {
    expect(() => new AuthLockout({ maxFailures: 0, windowMs: 1, lockoutMs: 1 })).toThrow();
    expect(() => new AuthLockout({ maxFailures: 1, windowMs: 0, lockoutMs: 1 })).toThrow();
    expect(() => new AuthLockout({ maxFailures: 1, windowMs: 1, lockoutMs: 0 })).toThrow();
  });
});
