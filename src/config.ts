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
 * Provider model:
 *
 *   LLM_PROVIDER=openai          ← selects the chat provider
 *   EMBEDDING_PROVIDER=openai    ← selects the embedding provider
 *
 *   When provider=openai, configuration is read from the OPENAI_* namespace
 *   (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_EMBEDDING_MODEL).
 *   New providers add their own namespace (ANTHROPIC_*, GROQ_*, ...) without
 *   touching the generic LLM_PROVIDER / EMBEDDING_PROVIDER selection vars.
 *
 *   The OPENAI_BASE_URL must include the `/v1` path segment, matching the
 *   official OpenAI endpoint convention. Local Ollama exposes the
 *   compatible API at `http://localhost:11434/v1`.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LLM_PROVIDERS = ['openai'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

const envSchema = z.object({
  REMBRIC_HOST: z.string().default('127.0.0.1'),
  REMBRIC_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  REMBRIC_DATA_DIR: z.string().default(join(homedir(), '.rembric')),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  REMBRIC_ADMIN_TOKEN: z.string().min(16).optional(),
  REMBRIC_SESSION_SECRET: z.string().min(16).optional(),

  // Provider selection
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('openai'),
  EMBEDDING_PROVIDER: z.enum(LLM_PROVIDERS).default('openai'),

  // OpenAI-compatible provider settings
  OPENAI_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  OPENAI_MODEL: z.string().default('qwen2.5:7b'),
  OPENAI_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

  EMBEDDING_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))
    .default(true),

  CONSOLIDATION_ENABLED: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))
    .default(true),
  CONSOLIDATION_CRON: z.string().default('0 3 * * *'),
  CONSOLIDATION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(50),

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
});

export type ParsedEnv = z.infer<typeof envSchema>;

export interface ProviderConfig {
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

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
  llm: ProviderConfig;
  embedding: EmbeddingConfig;
  consolidation: {
    enabled: boolean;
    cron: string;
    batchSize: number;
  };
  rateLimit: {
    enabled: boolean;
    ratePerSecond: number;
    burst: number;
  };
  sessions: {
    abandonAfterMs: number;
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

  // Cross-field validation: when consolidation is enabled we will be making
  // LLM calls (and optionally embedding calls). Surface the missing knobs
  // up-front rather than at the first cron tick.
  const issues: { path: string; message: string }[] = [];
  if (parsed.CONSOLIDATION_ENABLED) {
    if (parsed.LLM_PROVIDER === 'openai') {
      if (!parsed.OPENAI_API_KEY) {
        issues.push({
          path: 'OPENAI_API_KEY',
          message:
            "is required when CONSOLIDATION_ENABLED=true and LLM_PROVIDER='openai' (use any non-empty string for Ollama; an sk-… key for OpenAI proper)",
        });
      }
      if (!parsed.OPENAI_MODEL || parsed.OPENAI_MODEL.trim().length === 0) {
        issues.push({
          path: 'OPENAI_MODEL',
          message: "is required when CONSOLIDATION_ENABLED=true and LLM_PROVIDER='openai'",
        });
      }
    }
    if (parsed.EMBEDDING_ENABLED && parsed.EMBEDDING_PROVIDER === 'openai') {
      if (!parsed.OPENAI_API_KEY) {
        issues.push({
          path: 'OPENAI_API_KEY',
          message:
            "is required when CONSOLIDATION_ENABLED=true, EMBEDDING_ENABLED=true and EMBEDDING_PROVIDER='openai'",
        });
      }
      if (!parsed.OPENAI_EMBEDDING_MODEL || parsed.OPENAI_EMBEDDING_MODEL.trim().length === 0) {
        issues.push({
          path: 'OPENAI_EMBEDDING_MODEL',
          message:
            "is required when CONSOLIDATION_ENABLED=true, EMBEDDING_ENABLED=true and EMBEDDING_PROVIDER='openai'",
        });
      }
    }
  }
  if (issues.length > 0) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${summary}`, issues);
  }

  // For now the only provider is 'openai'. The resolver below routes from
  // (provider, *) to (baseUrl, apiKey, model). When new providers are added
  // they slot in here with their own namespaced env-var reads.
  const resolveProvider = (
    name: LlmProviderName,
    modelField: 'OPENAI_MODEL' | 'OPENAI_EMBEDDING_MODEL',
  ): ProviderConfig => {
    switch (name) {
      case 'openai':
        return {
          provider: 'openai',
          baseUrl: parsed.OPENAI_BASE_URL,
          apiKey: parsed.OPENAI_API_KEY ?? null,
          model: parsed[modelField],
        };
    }
  };

  const llm = resolveProvider(parsed.LLM_PROVIDER, 'OPENAI_MODEL');
  const embeddingBase = resolveProvider(parsed.EMBEDDING_PROVIDER, 'OPENAI_EMBEDDING_MODEL');

  return {
    host: parsed.REMBRIC_HOST,
    port: parsed.REMBRIC_PORT,
    dataDir: parsed.REMBRIC_DATA_DIR,
    logLevel: parsed.LOG_LEVEL,
    adminToken: parsed.REMBRIC_ADMIN_TOKEN ?? null,
    sessionSecret: parsed.REMBRIC_SESSION_SECRET ?? null,
    llm,
    embedding: {
      provider: embeddingBase.provider,
      baseUrl: embeddingBase.baseUrl,
      apiKey: embeddingBase.apiKey,
      model: embeddingBase.model,
      enabled: parsed.EMBEDDING_ENABLED,
    },
    consolidation: {
      enabled: parsed.CONSOLIDATION_ENABLED,
      cron: parsed.CONSOLIDATION_CRON,
      batchSize: parsed.CONSOLIDATION_BATCH_SIZE,
    },
    rateLimit: {
      enabled: parsed.RATE_LIMIT_ENABLED,
      ratePerSecond: parsed.RATE_LIMIT_RPS,
      burst: parsed.RATE_LIMIT_BURST,
    },
    sessions: {
      abandonAfterMs: parsed.SESSION_ABANDON_AFTER_MS,
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
    llm: {
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey ? '[set]' : '[unset]',
      model: config.llm.model,
    },
    embedding: {
      provider: config.embedding.provider,
      baseUrl: config.embedding.baseUrl,
      apiKey: config.embedding.apiKey ? '[set]' : '[unset]',
      model: config.embedding.model,
      enabled: config.embedding.enabled,
    },
    consolidation: config.consolidation,
    rateLimit: config.rateLimit,
    sessions: config.sessions,
  };
}
