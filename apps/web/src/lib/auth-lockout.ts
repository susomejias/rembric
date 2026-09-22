export interface AuthLockoutConfig {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
}

export interface LockoutDecision {
  locked: boolean;
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

  recordSuccess(key: string): void {
    this.records.delete(key);
  }
}
