/**
 * Token-bucket rate limiter, keyed by token id (not IP).
 *
 * Why per-token: rembric is bound to localhost or a trusted reverse
 * proxy, so the meaningful denial-of-service threat surface is a
 * misbehaving agent, not anonymous traffic. Bucketing by token also
 * means a noisy agent on one project cannot drain a quieter agent on
 * another.
 *
 * Why a bucket (not a fixed window): the burst tolerance is what makes
 * the limiter feel natural for MCP tool calls, which arrive in spikes
 * (an agent doing memory.search → memory.get → memory.save in quick
 * succession). A fixed-window limiter would either reject the burst or
 * be set high enough to be useless.
 */

export interface RateLimitConfig {
  /** Maximum requests per second per token (sustained rate). */
  ratePerSecond: number;
  /** Maximum burst size (bucket capacity). */
  burst: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens remaining in the bucket (clamped at 0 when denied). */
  remaining: number;
  /** Seconds until the bucket has at least one token again. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (config.ratePerSecond <= 0 || config.burst <= 0) {
      throw new Error('RateLimiter: rate and burst must both be > 0');
    }
  }

  check(key: string): RateLimitDecision {
    const ts = this.now();
    const bucket = this.refill(key, ts);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    }

    // Compute how long until a single token will accrue.
    const needed = 1 - bucket.tokens;
    const seconds = needed / this.config.ratePerSecond;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(seconds)),
    };
  }

  /** Test-only helper. */
  reset(): void {
    this.buckets.clear();
  }

  private refill(key: string, ts: number): Bucket {
    const existing = this.buckets.get(key);
    if (!existing) {
      const fresh: Bucket = { tokens: this.config.burst - 0, lastRefill: ts };
      this.buckets.set(key, fresh);
      return fresh;
    }
    const elapsedSec = (ts - existing.lastRefill) / 1000;
    if (elapsedSec > 0) {
      existing.tokens = Math.min(
        this.config.burst,
        existing.tokens + elapsedSec * this.config.ratePerSecond,
      );
      existing.lastRefill = ts;
    }
    return existing;
  }
}
