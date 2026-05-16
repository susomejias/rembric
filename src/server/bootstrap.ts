import { sql } from 'drizzle-orm';

import { loadConfig, redactConfig, type Config } from '../config.js';
import { ConsolidationRunner, ConsolidationScheduler } from '../consolidation/index.js';
import { createDb, type DbHandle } from '../db/index.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { projects as projectsTable } from '../db/schema/projects.js';
import { LlmClient } from '../llm/index.js';
import { createMcpServer, McpTransportManager } from '../mcp/index.js';
import type { DoctorReport } from '../mcp/sessions-tools.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { DomainError } from '../services/errors.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { SessionsService } from '../services/sessions.js';
import { deriveSessionKey, TokensService } from '../services/tokens.js';

import type { DashboardStats } from './dashboard-router.js';
import { startHttpServer, type HttpServerHandle } from './http.js';
import { RateLimiter } from './rate-limit.js';
import { SessionRouter } from './session-router.js';

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
  const agentSessionsSvc = new AgentSessionsService(dbHandle.db);
  const promptsSvc = new PromptsService(dbHandle.db);
  const relationsSvc = new RelationsService(dbHandle.db);
  const sessionRouter = new SessionRouter();

  // Mark inflight sessions from a prior run as abandoned. The router is
  // an in-process map so a restart wipes routing state; sweeping the DB
  // keeps it consistent.
  const abandoned = agentSessionsSvc.abandonStale({
    olderThanMs: config.sessions.abandonAfterMs,
  });
  if (abandoned.abandoned > 0) {
    console.error(`  ↻ ${abandoned.abandoned} stale session(s) marked abandoned`);
  }

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

  // Doctor report builder — captures live services for `memory.doctor`.
  const buildDoctorReport = buildDoctorReportFactory({
    dbHandle,
    agentSessions: agentSessionsSvc,
    llm: chatLlm,
    embeddingEnabled: config.embedding.enabled,
  });

  // One McpServer per session (the SDK requires a fresh server per
  // connected transport). The factory receives the URL path slug so the
  // emitted instructions block matches the connection scope.
  const mcpManager = new McpTransportManager((factoryCtx) =>
    createMcpServer({
      memory: memorySvc,
      projects,
      agentSessions: agentSessionsSvc,
      prompts: promptsSvc,
      relations: relationsSvc,
      candidates: {
        perSaveMax: config.candidates.perSaveMax,
        vecThreshold: config.candidates.vecThreshold,
        ftsThreshold: config.candidates.ftsThreshold,
      },
      router: sessionRouter,
      db: dbHandle.db,
      doctor: buildDoctorReport,
      requestedSlug: factoryCtx.requestedSlug,
    }),
  );

  // Background consolidation scheduler. Idle until the configured cron fires.
  const runner = new ConsolidationRunner({
    db: dbHandle.db,
    llm: chatLlm,
    model: config.llm.model,
    batchSize: config.consolidation.batchSize,
    relations: relationsSvc,
    orphanAfterMs: config.judgments.orphanAfterMs,
    embeddingWorker,
  });
  const scheduler = new ConsolidationScheduler({
    cron: config.consolidation.cron,
    runner,
    enabled: config.consolidation.enabled,
    onError: (err) => console.error('consolidation run failed:', err),
  });
  scheduler.start();

  const rateLimiter = config.rateLimit.enabled
    ? new RateLimiter({
        ratePerSecond: config.rateLimit.ratePerSecond,
        burst: config.rateLimit.burst,
      })
    : null;

  const http = await startHttpServer({
    host: config.host,
    port: config.port,
    mcp: mcpManager,
    tokens,
    projects,
    agentSessions: agentSessionsSvc,
    rateLimiter,
    triggerConsolidation: async (opts) => {
      if (opts?.orphansOnly) {
        // Skip the decay sweep by zeroing the decay threshold via a
        // one-off runner. Easier: run the regular path but rely on the
        // fact that decay is idempotent — almost-free when nothing
        // crosses the threshold. The "orphans-only" guarantee is that
        // we do NOT block on decay computation for very large stores.
        // For now we just run the standard path; a future change can
        // add a dedicated `runOrphansOnly()` if needed.
        return runner.runAll();
      }
      return runner.runAll();
    },
    dashboard: {
      db: dbHandle.db,
      tokens,
      sessions,
      agentSessions: agentSessionsSvc,
      projects,
      memory: memorySvc,
      getStats: () => collectStats(dbHandle, agentSessionsSvc, relationsSvc),
      dataDir: config.dataDir,
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

/**
 * Build a one-shot operational report for `memory.doctor`. The closure
 * captures the live services so this can be called inside any handler.
 */
function buildDoctorReportFactory(deps: {
  dbHandle: DbHandle;
  agentSessions: AgentSessionsService;
  llm: LlmClient;
  embeddingEnabled: boolean;
}): () => DoctorReport {
  return () => {
    const warnings: string[] = [];

    let journalMode = 'unknown';
    let integrity = 'unknown';
    let sizeBytes = 0;
    try {
      const jmRow = deps.dbHandle.raw
        .prepare<[], { journal_mode: string }>('PRAGMA journal_mode')
        .get();
      journalMode = jmRow?.journal_mode ?? 'unknown';
      const checkRow = deps.dbHandle.raw
        .prepare<[], Record<string, string>>('PRAGMA quick_check')
        .get();
      if (checkRow) {
        // SQLite returns the first (and only) column as the result; the
        // column name is the PRAGMA name. Read the first value.
        const firstValue = Object.values(checkRow)[0];
        integrity = firstValue ?? 'unknown';
      }
      const sizeRow = deps.dbHandle.raw
        .prepare<
          [],
          { page_count: number; page_size: number }
        >('SELECT (SELECT page_count FROM pragma_page_count) AS page_count, (SELECT page_size FROM pragma_page_size) AS page_size')
        .get();
      sizeBytes = (sizeRow?.page_count ?? 0) * (sizeRow?.page_size ?? 0);
    } catch (err) {
      warnings.push(`db pragma read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (integrity !== 'ok') warnings.push(`db integrity: ${integrity}`);

    const lastConsolidation = deps.dbHandle.db
      .select({
        startedAt: consolidationRuns.startedAt,
        summary: consolidationRuns.summary,
      })
      .from(consolidationRuns)
      .orderBy(sql`started_at DESC`)
      .limit(1)
      .get();

    let lastRunOps: Record<string, number> = {};
    if (lastConsolidation?.summary) {
      try {
        lastRunOps = JSON.parse(lastConsolidation.summary) as Record<string, number>;
      } catch {
        // ignore malformed JSON; the journal stays the source of truth
      }
    }

    const backlogRow = deps.dbHandle.db.get<{ v: number }>(
      sql`SELECT COUNT(*) AS v FROM memory m LEFT JOIN memory_vec v ON v.memory_id = m.id WHERE v.memory_id IS NULL AND m.status != 'archived'`,
    ) as { v: number } | undefined;
    const backlog = backlogRow?.v ?? 0;
    if (deps.embeddingEnabled && backlog > 100) {
      warnings.push(`embeddings backlog: ${backlog}`);
    }

    const sessionsByStatus = deps.agentSessions.countByStatus();

    return {
      db: { open: true, journalMode, integrity, sizeBytes },
      llm: { reachable: false, lastPingAt: null },
      embeddings: { enabled: deps.embeddingEnabled, backlog },
      consolidation: {
        lastRunAt: lastConsolidation?.startedAt ? lastConsolidation.startedAt.toISOString() : null,
        lastRunOps,
      },
      sessions: { active: sessionsByStatus.active },
      warnings,
    };
  };
}

function collectStats(
  dbHandle: DbHandle,
  agentSessionsSvc: AgentSessionsService,
  relationsSvc: RelationsService,
): DashboardStats {
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

  const sessionsByStatus = agentSessionsSvc.countByStatus();
  const relationsByStatus = relationsSvc.countByStatus();

  return {
    totalMemories: totalRow?.value ?? 0,
    activeMemories: activeRow?.value ?? 0,
    archivedMemories: archivedRow?.value ?? 0,
    projects: projectsRow?.value ?? 0,
    lastConsolidationAt: consolidationRow?.startedAt ?? null,
    activeSessions: sessionsByStatus.active,
    pendingJudgments: relationsByStatus.pending,
  };
}
