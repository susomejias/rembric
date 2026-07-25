import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * 12-factor environment-variable configuration.
 *
 * Single source of truth for all runtime settings. Defaults are baked in;
 * only `REMBRIC_ADMIN_TOKEN` is required on the very first start (when no
 * admin token row exists in the DB yet).
 *
 * Engine-vs-deployment rule: env vars configure the DEPLOYMENT (ports,
 * tokens, data dir, time windows) — never the engine. The server performs
 * no LLM reasoning (`remove-llm-consolidation`) and embeds its embedding
 * model in-process (`embed-embeddings-in-process`); stale vars from older
 * deployments are ignored with a boot warning, never an error.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Env vars removed by past changes; ignored with a warning. */
export const REMOVED_ENV_VARS = [
  // remove-llm-consolidation
  'LLM_PROVIDER',
  'OPENAI_MODEL',
  'CONSOLIDATION_ENABLED',
  'CONSOLIDATION_CRON',
  'CONSOLIDATION_BATCH_SIZE',
  // embed-embeddings-in-process
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_EMBEDDING_MODEL',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_ENABLED',
  'CANDIDATE_VEC_THRESHOLD',
  'CANDIDATE_FTS_THRESHOLD',
] as const;

/** Names from `REMOVED_ENV_VARS` still present in `env`, for the boot warning. */
export function findStaleEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return REMOVED_ENV_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
}

/** Default for `CANDIDATES_PER_SAVE_MAX` — exported so non-bootstrap callers (e.g. the eval harness) don't hand-copy it. */
export const CANDIDATES_PER_SAVE_MAX_DEFAULT = 5;

const envSchema = z.object({
  REMBRIC_HOST: z.string().default('127.0.0.1'),
  REMBRIC_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  REMBRIC_DATA_DIR: z.string().default(join(homedir(), '.rembric')),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  REMBRIC_ADMIN_TOKEN: z.string().min(16).optional(),
  REMBRIC_SESSION_SECRET: z.string().min(16).optional(),

  // OAuth 2.1 authorization server. The feature is enabled iff
  // REMBRIC_PUBLIC_URL is set; it is the OAuth `issuer` and the base for
  // every absolute metadata URL, so it MUST be the externally-reachable
  // origin (a proxy/tunnel front, not the internal HOST:PORT). HTTPS is
  // required, with an http exception ONLY for loopback hosts (localhost /
  // 127.0.0.1) — the RFC 8414 testing exemption the MCP SDK also applies.
  REMBRIC_PUBLIC_URL: z
    .string()
    .url()
    .refine(isAllowedIssuerUrl, {
      message: 'REMBRIC_PUBLIC_URL must be https:// (http allowed only for localhost / 127.0.0.1)',
    })
    .optional(),
  REMBRIC_OAUTH_ACCESS_TTL: z.coerce.number().int().min(60).max(86_400).default(3600),
  REMBRIC_OAUTH_REFRESH_TTL: z.coerce
    .number()
    .int()
    .min(3600)
    .max(365 * 86_400)
    .default(30 * 86_400),

  // Per-token MCP rate limiting. Disabled by default — single-user
  // localhost deployments do not need it. Set RATE_LIMIT_ENABLED=true
  // to turn on the token-bucket limiter.
  RATE_LIMIT_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))
    .default(false),
  RATE_LIMIT_RPS: z.coerce.number().positive().max(10_000).default(10),
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(10_000).default(30),

  // Pre-auth failed-attempt lockout. Always on — it only ever penalises
  // repeated authentication FAILURES from one network identity, and is
  // consulted before the token-hash scan so bogus bearers cannot exhaust
  // CPU. A successful auth clears the identity's record.
  AUTH_LOCKOUT_MAX_FAILURES: z.coerce.number().int().min(1).max(10_000).default(10),
  AUTH_LOCKOUT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  AUTH_LOCKOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(24 * 3_600_000)
    .default(60_000),
  // Maximum raw request body (bytes) accepted on the authenticated HTTP
  // surface (`/mcp`, `/api`). Over-large bodies are rejected with 413.
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(256 * 1024 * 1024)
    .default(4 * 1024 * 1024),

  // DNS-rebinding defense-in-depth for the MCP transport (opt-in). Comma-
  // separated allow-lists; when EITHER is set the SDK transport enables
  // protection. Left unset by default because the strict Host check can
  // reject legitimate reverse-proxy setups, and the mandatory bearer token
  // is the primary control. Host values include the port (e.g.
  // "rembric.example.com:443"); origins are full origins (scheme+host[:port]).
  REMBRIC_MCP_ALLOWED_HOSTS: z.string().optional(),
  REMBRIC_MCP_ALLOWED_ORIGINS: z.string().optional(),

  // Sessions sweep: status='active' rows whose started_at is older than
  // this threshold are flipped to 'abandoned' at server startup. Default
  // 24h. Operators that run very long-lived agents can extend the window.
  SESSION_ABANDON_AFTER_MS: z.coerce
    .number()
    .int()
    .min(60_000) // 1 minute floor
    .max(30 * 86_400_000) // 30-day ceiling
    .default(86_400_000),

  // Save-time candidate detection. Controls how many similar memories
  // `memory.save` surfaces to the agent for judgment. 0 disables
  // surfacing; useful for batch/automation paths. Similarity thresholds
  // are engine constants in `save-time-candidates.ts`, not configuration.
  CANDIDATES_PER_SAVE_MAX: z.coerce
    .number()
    .int()
    .min(0)
    .max(25)
    .default(CANDIDATES_PER_SAVE_MAX_DEFAULT),

  // Relations stuck in 'pending' longer than this are re-exposed to
  // agents via memory.context (pendingJudgments[]) for fresh-context
  // judgment via memory.judge.
  JUDGMENT_ORPHAN_AFTER_MS: z.coerce
    .number()
    .int()
    .min(60_000) // 1 minute floor
    .max(30 * 86_400_000) // 30-day ceiling
    .default(86_400_000),

  // Pending relations no agent judged within this window are marked
  // 'orphaned' by the deterministic sweep (journaled, undoable).
  JUDGMENT_ORPHAN_DEADLINE_MS: z.coerce
    .number()
    .int()
    .min(3_600_000) // 1 hour floor
    .max(365 * 86_400_000) // 1-year ceiling
    .default(14 * 86_400_000),
});

export type ParsedEnv = z.infer<typeof envSchema>;

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  adminToken: string | null;
  sessionSecret: string | null;
  oauth: {
    enabled: boolean;
    /** OAuth issuer / external base URL; null when the feature is off. */
    issuer: string | null;
    accessTtlMs: number;
    refreshTtlMs: number;
  };
  rateLimit: {
    enabled: boolean;
    ratePerSecond: number;
    burst: number;
  };
  authLockout: {
    maxFailures: number;
    windowMs: number;
    lockoutMs: number;
  };
  maxBodyBytes: number;
  mcpTransport: {
    allowedHosts: string[];
    allowedOrigins: string[];
  };
  sessions: {
    abandonAfterMs: number;
  };
  candidates: {
    perSaveMax: number;
  };
  judgments: {
    orphanAfterMs: number;
    orphanDeadlineMs: number;
  };
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${summary}`, issues);
  }

  const parsed = result.data;

  return {
    host: parsed.REMBRIC_HOST,
    port: parsed.REMBRIC_PORT,
    dataDir: parsed.REMBRIC_DATA_DIR,
    logLevel: parsed.LOG_LEVEL,
    adminToken: parsed.REMBRIC_ADMIN_TOKEN ?? null,
    sessionSecret: parsed.REMBRIC_SESSION_SECRET ?? null,
    oauth: {
      enabled: parsed.REMBRIC_PUBLIC_URL !== undefined,
      issuer: parsed.REMBRIC_PUBLIC_URL ? stripTrailingSlash(parsed.REMBRIC_PUBLIC_URL) : null,
      accessTtlMs: parsed.REMBRIC_OAUTH_ACCESS_TTL * 1000,
      refreshTtlMs: parsed.REMBRIC_OAUTH_REFRESH_TTL * 1000,
    },
    rateLimit: {
      enabled: parsed.RATE_LIMIT_ENABLED,
      ratePerSecond: parsed.RATE_LIMIT_RPS,
      burst: parsed.RATE_LIMIT_BURST,
    },
    authLockout: {
      maxFailures: parsed.AUTH_LOCKOUT_MAX_FAILURES,
      windowMs: parsed.AUTH_LOCKOUT_WINDOW_MS,
      lockoutMs: parsed.AUTH_LOCKOUT_MS,
    },
    maxBodyBytes: parsed.MAX_BODY_BYTES,
    mcpTransport: {
      allowedHosts: splitCsv(parsed.REMBRIC_MCP_ALLOWED_HOSTS),
      allowedOrigins: splitCsv(parsed.REMBRIC_MCP_ALLOWED_ORIGINS),
    },
    sessions: {
      abandonAfterMs: parsed.SESSION_ABANDON_AFTER_MS,
    },
    candidates: {
      perSaveMax: parsed.CANDIDATES_PER_SAVE_MAX,
    },
    judgments: {
      orphanAfterMs: parsed.JUDGMENT_ORPHAN_AFTER_MS,
      orphanDeadlineMs: parsed.JUDGMENT_ORPHAN_DEADLINE_MS,
    },
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Split a comma-separated env value into a trimmed, non-empty list. */
function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isAllowedIssuerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Mirror the MCP SDK's checkIssuerUrl exactly: it rejects a query/fragment
  // and permits a non-https issuer only for localhost / 127.0.0.1. Validating
  // the same rules here turns a bad REMBRIC_PUBLIC_URL into a clean config
  // error instead of an unhandled crash inside the SDK router at boot.
  if (url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** Redact secrets from a config for safe logging. */
export function redactConfig(config: Config): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    logLevel: config.logLevel,
    adminToken: config.adminToken ? '[set]' : '[unset]',
    sessionSecret: config.sessionSecret ? '[set]' : '[derived from admin token]',
    oauth: {
      enabled: config.oauth.enabled,
      issuer: config.oauth.issuer ?? '[unset]',
      accessTtlMs: config.oauth.accessTtlMs,
      refreshTtlMs: config.oauth.refreshTtlMs,
    },
    rateLimit: config.rateLimit,
    authLockout: config.authLockout,
    maxBodyBytes: config.maxBodyBytes,
    mcpTransport: config.mcpTransport,
    sessions: config.sessions,
    candidates: config.candidates,
    judgments: config.judgments,
  };
}
