/**
 * Failed-authentication lockout, keyed on a pre-auth identity (source IP or a
 * trusted-proxy forwarded hop).
 *
 * Consulted BEFORE token-hash verification so an unauthenticated caller cannot
 * force repeated expensive hashing (the scrypt scan blocks the single Node
 * thread). Only *failed* attempts accrue; a success clears the record, so
 * legitimate clients are never penalised.
 */

export interface AuthLockoutConfig {
  /** Failures within the window before the identity is locked out. */
  maxFailures: number;
  /** Window (ms) over which failures accumulate. */
  windowMs: number;
  /** How long (ms) a lockout lasts once tripped. */
  lockoutMs: number;
}

export interface LockoutDecision {
  locked: boolean;
  /** Seconds until the lockout lifts. 0 when not locked. */
  retryAfterSeconds: number;
}

interface FailureRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export class AuthLockout {
  private readonly records = new Map<string, FailureRecord>();

  constructor(
    private readonly config: AuthLockoutConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (config.maxFailures <= 0 || config.windowMs <= 0 || config.lockoutMs <= 0) {
      throw new Error('AuthLockout: maxFailures, windowMs and lockoutMs must all be > 0');
    }
  }

  /** Is this identity currently locked out? Cheap; it does no hashing. */
  check(key: string): LockoutDecision {
    const rec = this.records.get(key);
    if (!rec) return { locked: false, retryAfterSeconds: 0 };
    const ts = this.now();
    if (rec.lockedUntil > ts) {
      return {
        locked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((rec.lockedUntil - ts) / 1000)),
      };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  /** Record a failed authentication for this identity; trips lockout at the threshold. */
  recordFailure(key: string): void {
    const ts = this.now();
    const rec = this.records.get(key);
    if (!rec || ts - rec.windowStart > this.config.windowMs || rec.lockedUntil > 0) {
      const fresh: FailureRecord = { failures: 1, windowStart: ts, lockedUntil: 0 };
      if (this.config.maxFailures <= 1) fresh.lockedUntil = ts + this.config.lockoutMs;
      this.records.set(key, fresh);
      return;
    }
    rec.failures += 1;
    if (rec.failures >= this.config.maxFailures) {
      rec.lockedUntil = ts + this.config.lockoutMs;
    }
  }

  /** Clear the failure record for this identity after a successful auth. */
  recordSuccess(key: string): void {
    this.records.delete(key);
  }
}
