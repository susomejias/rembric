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
 * Embedding provider model:
 *
 *   EMBEDDING_PROVIDER=openai    ← selects the embedding provider
 *
 *   When provider=openai, configuration is read from the OPENAI_* namespace
 *   (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL). The
 *   OPENAI_BASE_URL must include the `/v1` path segment; local Ollama
 *   exposes the compatible API at `http://localhost:11434/v1`.
 *
 * There is no chat-LLM configuration: the server performs no LLM reasoning
 * (see the `remove-llm-consolidation` change). Stale chat/cron vars from
 * pre-0.21 deployments are ignored with a boot warning, never an error.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LLM_PROVIDERS = ['openai'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Env vars removed by `remove-llm-consolidation`; ignored with a warning. */
export const REMOVED_ENV_VARS = [
  'LLM_PROVIDER',
  'OPENAI_MODEL',
  'CONSOLIDATION_ENABLED',
  'CONSOLIDATION_CRON',
  'CONSOLIDATION_BATCH_SIZE',
] as const;

/** Names from `REMOVED_ENV_VARS` still present in `env`, for the boot warning. */
export function findStaleEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return REMOVED_ENV_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
}

const envSchema = z.object({
  REMBRIC_HOST: z.string().default('127.0.0.1'),
  REMBRIC_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  REMBRIC_DATA_DIR: z.string().default(join(homedir(), '.rembric')),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  REMBRIC_ADMIN_TOKEN: z.string().min(16).optional(),
  REMBRIC_SESSION_SECRET: z.string().min(16).optional(),

  // Embedding provider selection (chat-LLM config was removed; see header)
  EMBEDDING_PROVIDER: z.enum(LLM_PROVIDERS).default('openai'),

  // OpenAI-compatible provider settings (consumed by embeddings only)
  OPENAI_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  OPENAI_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

  EMBEDDING_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))
    .default(true),

  // Per-token MCP rate limiting. Disabled by default — single-user
  // localhost deployments do not need it. Set RATE_LIMIT_ENABLED=true
  // to turn on the token-bucket limiter.
  RATE_LIMIT_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))
    .default(false),
  RATE_LIMIT_RPS: z.coerce.number().positive().max(10_000).default(10),
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(10_000).default(30),

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
  // surfacing (the pending rows are still inserted for the consolidator
  // to pick up later); useful for batch/automation paths.
  CANDIDATES_PER_SAVE_MAX: z.coerce.number().int().min(0).max(25).default(5),
  CANDIDATE_VEC_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  CANDIDATE_FTS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),

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

export interface EmbeddingConfig {
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  enabled: boolean;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  adminToken: string | null;
  sessionSecret: string | null;
  embedding: EmbeddingConfig;
  rateLimit: {
    enabled: boolean;
    ratePerSecond: number;
    burst: number;
  };
  sessions: {
    abandonAfterMs: number;
  };
  candidates: {
    perSaveMax: number;
    vecThreshold: number;
    ftsThreshold: number;
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
    embedding: {
      provider: parsed.EMBEDDING_PROVIDER,
      baseUrl: parsed.OPENAI_BASE_URL,
      apiKey: parsed.OPENAI_API_KEY ?? null,
      model: parsed.OPENAI_EMBEDDING_MODEL,
      enabled: parsed.EMBEDDING_ENABLED,
    },
    rateLimit: {
      enabled: parsed.RATE_LIMIT_ENABLED,
      ratePerSecond: parsed.RATE_LIMIT_RPS,
      burst: parsed.RATE_LIMIT_BURST,
    },
    sessions: {
      abandonAfterMs: parsed.SESSION_ABANDON_AFTER_MS,
    },
    candidates: {
      perSaveMax: parsed.CANDIDATES_PER_SAVE_MAX,
      vecThreshold: parsed.CANDIDATE_VEC_THRESHOLD,
      ftsThreshold: parsed.CANDIDATE_FTS_THRESHOLD,
    },
    judgments: {
      orphanAfterMs: parsed.JUDGMENT_ORPHAN_AFTER_MS,
      orphanDeadlineMs: parsed.JUDGMENT_ORPHAN_DEADLINE_MS,
    },
  };
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
    embedding: {
      provider: config.embedding.provider,
      baseUrl: config.embedding.baseUrl,
      apiKey: config.embedding.apiKey ? '[set]' : '[unset]',
      model: config.embedding.model,
      enabled: config.embedding.enabled,
    },
    rateLimit: config.rateLimit,
    sessions: config.sessions,
    candidates: config.candidates,
    judgments: config.judgments,
  };
}
