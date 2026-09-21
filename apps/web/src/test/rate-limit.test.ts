import { describe, expect, it } from 'vitest';

import { AuthLockout } from '../lib/auth-lockout';

/**
 * `lib/auth-lockout.ts::AuthLockout` — the pre-auth failed-attempt lockout both
 * HTTP surfaces consult before touching a token hash (`lib/api.ts` and
 * `lib/mcp-auth.ts`).
 *
 * The token-bucket `RateLimiter` the server module `rate-limit.ts` also exports
 * has NO counterpart in this workspace: the port kept the lockout only, and the
 * OAuth router's own per-endpoint limiter (`lib/oauth.ts`) is a different
 * instrument. Its cases are therefore not ported — see the batch report.
 */

const CFG = { maxFailures: 3, windowMs: 60_000, lockoutMs: 30_000 };

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
