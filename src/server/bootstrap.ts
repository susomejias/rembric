import { sql } from 'drizzle-orm';

import { loadConfig, redactConfig, type Config } from '../config.js';
import { ConsolidationRunner, ConsolidationScheduler } from '../consolidation/index.js';
import { createDb, type DbHandle } from '../db/index.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { projects as projectsTable } from '../db/schema/projects.js';
import { LlmClient } from '../llm/index.js';
import { createMcpServer, McpTransportManager } from '../mcp/index.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { DomainError } from '../services/errors.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { SessionsService } from '../services/sessions.js';
import { deriveSessionKey, TokensService } from '../services/tokens.js';

import type { DashboardStats } from './dashboard-router.js';
import { startHttpServer, type HttpServerHandle } from './http.js';

/**
 * Wire dependencies, apply migrations, bootstrap the admin token, and
 * start the HTTP listener. Caller is responsible for signal handling
 * (which is provided by `startCli` in `./index.ts`).
 */

export interface BootstrappedServer {
  config: Config;
  http: HttpServerHandle;
  dbHandle: DbHandle;
  shutdown: () => Promise<void>;
}

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<BootstrappedServer> {
  const config = loadConfig(env);
  printStartupBanner(config);

  const dbHandle = createDb({ dataDir: config.dataDir });

  const tokens = new TokensService(dbHandle.db);
  const projects = new ProjectsService(dbHandle.db);
  const memorySvc = new MemoryService(dbHandle.db);

  const firstRun = tokens.count() === 0;
  try {
    tokens.bootstrapAdmin(config.adminToken);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'admin_token_required') {
      console.error('\n  ✗ ' + err.message);
      console.error('    Generate one with:  export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)');
      console.error('');
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const sessionSecretBase =
    config.sessionSecret ??
    config.adminToken ??
    process.env['REMBRIC_SESSION_SECRET'] ??
    process.env['REMBRIC_ADMIN_TOKEN'];
  if (!sessionSecretBase) {
    throw new Error('session secret is missing; set REMBRIC_SESSION_SECRET or REMBRIC_ADMIN_TOKEN');
  }
  const sessions = new SessionsService(dbHandle.db, deriveSessionKey(sessionSecretBase));

  // One McpServer per session (the SDK requires a fresh server per
  // connected transport). The manager lazily creates pairs on demand.
  const mcpManager = new McpTransportManager(() => createMcpServer({ memory: memorySvc }));

  // LLM clients. Chat and embedding may share a provider (typical
  // OpenAI/Ollama case) or differ; either way we instantiate one client
  // per role so future divergence is a config swap, not a refactor.
  const chatLlm = new LlmClient({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey });
  const embeddingLlm =
    config.embedding.baseUrl === config.llm.baseUrl && config.embedding.apiKey === config.llm.apiKey
      ? chatLlm
      : new LlmClient({
          baseUrl: config.embedding.baseUrl,
          apiKey: config.embedding.apiKey,
        });

  // Embedding worker — drains new memories into memory_vec so the
  // redundancy detector has something to kNN over. When EMBEDDING_ENABLED
  // is false we skip the worker entirely and the consolidation falls back to
  // drift / contradiction / decay (which don't need vectors).
  const embeddingWorker = config.embedding.enabled
    ? new EmbeddingWorker({
        db: dbHandle.db,
        client: embeddingLlm,
        model: config.embedding.model,
      })
    : null;

  let embedTimer: NodeJS.Timeout | null = null;
  if (embeddingWorker) {
    const tick = (): void => {
      embeddingWorker.processBatch().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('embedding worker error:', message);
      });
    };
    // First pass immediately to backfill anything pending from a prior run.
    tick();
    embedTimer = setInterval(tick, 30_000);
    // Don't keep the event loop alive solely for this timer during shutdown.
    embedTimer.unref?.();
  }

  // Background consolidation scheduler. Idle until the configured cron fires.
  const runner = new ConsolidationRunner({
    db: dbHandle.db,
    llm: chatLlm,
    model: config.llm.model,
    batchSize: config.consolidation.batchSize,
    embeddingWorker,
  });
  const scheduler = new ConsolidationScheduler({
    cron: config.consolidation.cron,
    runner,
    enabled: config.consolidation.enabled,
    onError: (err) => console.error('consolidation run failed:', err),
  });
  scheduler.start();

  const http = await startHttpServer({
    host: config.host,
    port: config.port,
    mcp: mcpManager,
    tokens,
    projects,
    dashboard: {
      db: dbHandle.db,
      tokens,
      sessions,
      projects,
      memory: memorySvc,
      getStats: () => collectStats(dbHandle),
    },
  });

  printReadyBanner(http.url, firstRun);

  return {
    config,
    http,
    dbHandle,
    shutdown: async () => {
      if (embedTimer) clearInterval(embedTimer);
      scheduler.stop();
      await http.close();
      dbHandle.close();
    },
  };
}

function printStartupBanner(config: Config): void {
  const lines = [
    '',
    '  Rembric · MCP memory server for AI agents',
    '  ──────────────────────────────────────────',
  ];
  const dump = JSON.stringify(redactConfig(config), null, 2);
  for (const line of dump.split('\n')) lines.push('    ' + line);
  lines.push('');
  console.error(lines.join('\n'));
}

function printReadyBanner(url: string, firstRun: boolean): void {
  console.error(`  ✓ MCP endpoint:  ${url}/mcp`);
  console.error(`  ✓ Dashboard:     ${url}/dashboard`);
  console.error(`  ✓ Healthcheck:   ${url}/healthz`);
  if (firstRun) {
    console.error('');
    console.error('  First run detected. Sign in to the dashboard with REMBRIC_ADMIN_TOKEN');
    console.error('  to create per-agent tokens and explore the data.');
  }
  console.error('');
}

function collectStats(dbHandle: DbHandle): DashboardStats {
  const totalRow = dbHandle.db
    .select({ value: sql<number>`count(*)` })
    .from(memory)
    .get();
  const activeRow = dbHandle.db
    .select({ value: sql<number>`count(*)` })
    .from(memory)
    .where(sql`status = 'active'`)
    .get();
  const archivedRow = dbHandle.db
    .select({ value: sql<number>`count(*)` })
    .from(memory)
    .where(sql`status = 'archived'`)
    .get();
  const projectsRow = dbHandle.db
    .select({ value: sql<number>`count(*)` })
    .from(projectsTable)
    .get();
  const consolidationRow = dbHandle.db
    .select({ startedAt: consolidationRuns.startedAt })
    .from(consolidationRuns)
    .orderBy(sql`started_at DESC`)
    .limit(1)
    .get();

  return {
    totalMemories: totalRow?.value ?? 0,
    activeMemories: activeRow?.value ?? 0,
    archivedMemories: archivedRow?.value ?? 0,
    projects: projectsRow?.value ?? 0,
    lastConsolidationAt: consolidationRow?.startedAt ?? null,
  };
}
