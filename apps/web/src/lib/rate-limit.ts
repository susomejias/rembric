import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

const MAX_RATE_LIMIT_WINDOW_MS = 2_147_483_647;
const MAX_RATE_PER_SECOND = 10_000;
const MAX_BURST = 10_000;

export interface RateLimitConfig {
  enabled: boolean;
  ratePerSecond: number;
  burst: number;
  windowMs: number;
  durationSeconds: number;
}

type GlobalRateLimiter = typeof globalThis & {
  __rembricMcpRateLimiter?: {
    signature: string;
    limiter: RateLimiterMemory;
  };
};

const globalForRateLimit = globalThis as GlobalRateLimiter;

export function getRateLimitConfig(env: Partial<NodeJS.ProcessEnv> = process.env): RateLimitConfig {
  const ratePerSecond = parseRatePerSecond(env['RATE_LIMIT_RPS']);
  const burst = parseBurst(env['RATE_LIMIT_BURST']);
  const enabled = env['RATE_LIMIT_ENABLED']?.toLowerCase() === 'true';
  const derivedWindowMs = (burst * 1000) / ratePerSecond;
  const windowMs = Math.max(1, Math.ceil(derivedWindowMs));

  if (
    !Number.isFinite(derivedWindowMs) ||
    !Number.isSafeInteger(windowMs) ||
    windowMs > MAX_RATE_LIMIT_WINDOW_MS
  ) {
    throw new Error(
      `RATE_LIMIT_RPS and RATE_LIMIT_BURST produce windowMs outside 1..${MAX_RATE_LIMIT_WINDOW_MS}`,
    );
  }

  return {
    enabled,
    ratePerSecond,
    burst,
    windowMs,
    durationSeconds: windowMs / 1000,
  };
}

function parseRatePerSecond(raw: string | undefined): number {
  const value = raw === undefined ? 10 : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_RATE_PER_SECOND) {
    throw new Error(`RATE_LIMIT_RPS must be a finite number in (0, ${MAX_RATE_PER_SECOND}]`);
  }
  return value;
}

function parseBurst(raw: string | undefined): number {
  const value = raw === undefined ? 30 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BURST) {
    throw new Error(`RATE_LIMIT_BURST must be an integer in [1, ${MAX_BURST}]`);
  }
  return value;
}

export function getMcpRateLimiter(): RateLimiterMemory | null {
  const config = getRateLimitConfig();
  if (!config.enabled) return null;

  const signature = `${config.ratePerSecond}:${config.burst}:${config.windowMs}`;
  const cached = globalForRateLimit.__rembricMcpRateLimiter;
  if (cached?.signature === signature) return cached.limiter;

  const limiter = new RateLimiterMemory({ points: config.burst, duration: config.durationSeconds });
  globalForRateLimit.__rembricMcpRateLimiter = { signature, limiter };
  return limiter;
}

export async function applyMcpRateLimit(
  tokenId: string,
  tokenName: string,
): Promise<Response | null> {
  const limiter = getMcpRateLimiter();
  if (limiter === null) return null;

  try {
    await limiter.consume(tokenId);
    return null;
  } catch (error) {
    if (!(error instanceof RateLimiterRes)) throw error;
    const retryAfterSeconds = Math.max(1, Math.ceil(error.msBeforeNext / 1000));
    return Response.json(
      {
        ok: false,
        code: 'rate_limited',
        message: `token '${tokenName}' exceeded its rate limit; retry in ${retryAfterSeconds}s`,
        retryAfterSeconds,
      },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
    );
  }
}

export function resetMcpRateLimiterForTests(): void {
  delete globalForRateLimit.__rembricMcpRateLimiter;
}
