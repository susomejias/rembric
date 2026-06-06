import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { findStaleEnvVars, loadConfig, redactConfig, type Config } from '../config.js';
import { ConsolidationRunner } from '../consolidation/index.js';
import { createDb, type DbHandle } from '../db/index.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { projects as projectsTable } from '../db/schema/projects.js';
import { EMBEDDING_MODEL_ID, loadEmbedder, type Embedder } from '../embeddings/embedder.js';
import { ensureVectorModel, logSimilarityDistribution } from '../embeddings/state.js';
import { createMcpServer, McpTransportManager } from '../mcp/index.js';
import type { DoctorReport } from '../mcp/sessions-tools.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { DomainError } from '../services/errors.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { CapabilityDetector } from '../services/self-update/capability.js';
import { DockerEngineApi } from '../services/self-update/engine-api.js';
import {
  createPreUpdateBackup,
  SelfUpdateOrchestrator,
} from '../services/self-update/orchestrator.js';
import { SessionsService } from '../services/sessions.js';
import { deriveSessionKey, TokensService } from '../services/tokens.js';
import { UpdateCheckService } from '../services/update-check.js';
import { REMBRIC_VERSION } from '../version.js';

import type { DashboardStats } from './dashboard-router.js';
import {
  assertDataLossGuard,
  DataLossGuardError,
  queryCounts,
  writeStateMarker,
  type DataCounts,
} from './data-loss-guard.js';
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

export interface BootstrapOverrides {
  /** Test-only seam: replace the in-process embedder (never operator config). */
  embedder?: Embedder;
  /** Test-only seam: replace the release update check. */
  updates?: UpdateCheckService;
  /** Test-only seam: replace the self-update orchestrator. */
  selfUpdate?: SelfUpdateOrchestrator;
}

export async function bootstrap(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BootstrapOverrides = {},
): Promise<BootstrappedServer> {
  const config = loadConfig(env);
  printStartupBanner(config);

  const staleVars = findStaleEnvVars(env);
  if (staleVars.length > 0) {
    console.error(
      `  ⚠ ignoring removed env vars (chat LLM, consolidation cron and embedding provider were removed): ${staleVars.join(', ')}`,
    );
  }

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

  // In-process embedder + drain worker — fills memory_vec so save-time
  // candidate detection has vectors to kNN over. The model loads eagerly
  // and is REQUIRED: a load failure aborts the boot (fail fast) so a
  // listening server always has a warm model. A model change invalidates
  // stale vectors up front and the drain re-embeds them in resumable
  // batches.
  const embedStart = Date.now();
  const embedder = overrides.embedder ?? (await loadEmbedder());
  if (!overrides.embedder) {
    console.error(
      `  ✓ embedding model loaded in ${Date.now() - embedStart}ms (${embedder.modelId})`,
    );
  }
  const vectorReset = ensureVectorModel(dbHandle.db, config.dataDir);
  if (vectorReset.wiped > 0) {
    console.error(
      `  ↻ embedding model changed → ${vectorReset.wiped} stale vector(s) wiped; re-embedding in background`,
    );
  }
  const embeddingWorker = new EmbeddingWorker({
    db: dbHandle.db,
    embedder,
    onDrained: () => logSimilarityDistribution(dbHandle.db),
  });

  const embedTick = (): void => {
    embeddingWorker.processBatch().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('embedding worker error:', message);
    });
  };
  // First pass immediately to backfill anything pending from a prior run.
  embedTick();
  const embedTimer = setInterval(embedTick, 30_000);
  // Don't keep the event loop alive solely for this timer during shutdown.
  embedTimer.unref?.();

  // Doctor report builder — captures live services for `memory.doctor`.
  const buildDoctorReport = buildDoctorReportFactory({
    dbHandle,
    agentSessions: agentSessionsSvc,
  });

  // Deterministic consolidation sweep — decay + deadline orphaning, no
  // LLM, no cron. Triggered lazily on session start (throttled per scope)
  // and manually via POST /admin/consolidation/run.
  const runner = new ConsolidationRunner({
    db: dbHandle.db,
    relations: relationsSvc,
    orphanDeadlineMs: config.judgments.orphanDeadlineMs,
  });
  const sweepOnSessionStart = (projectId: string | null): void => {
    setImmediate(() => {
      try {
        runner.sweepFor(projectId);
      } catch (err) {
        console.error(
          'consolidation sweep failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  };

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
      },
      embedNow: (memoryId, content) => embeddingWorker.embedNow(memoryId, content),
      router: sessionRouter,
      db: dbHandle.db,
      doctor: buildDoctorReport,
      sweep: sweepOnSessionStart,
      orphanAfterMs: config.judgments.orphanAfterMs,
      requestedSlug: factoryCtx.requestedSlug,
    }),
  );

  const updates =
    overrides.updates ??
    new UpdateCheckService({
      enabled: env['REMBRIC_UPDATE_CHECK'] !== 'off',
      // Test/smoke seam: point the release feed at a stub (docs/updates.md).
      releasesUrl: env['REMBRIC_UPDATE_CHECK_URL'],
    });
  const selfUpdate =
    overrides.selfUpdate ??
    new SelfUpdateOrchestrator({
      capability: new CapabilityDetector({ env }),
      engineFactory: (socketPath) => new DockerEngineApi(socketPath),
      backup: createPreUpdateBackup({
        vacuumInto: (dest) => {
          dbHandle.raw.prepare('VACUUM INTO ?').run(dest);
        },
        backupsDir: join(config.dataDir, 'backups'),
      }),
    });

  const rateLimiter = config.rateLimit.enabled
    ? new RateLimiter({
        ratePerSecond: config.rateLimit.ratePerSecond,
        burst: config.rateLimit.burst,
      })
    : null;

  try {
    assertDataLossGuard({ dataDir: config.dataDir, db: dbHandle.db, env });
  } catch (err) {
    if (err instanceof DataLossGuardError) {
      dbHandle.close();
      process.exit(78);
    }
    throw err;
  }

  printBootstrapBanner(config, queryCounts(dbHandle.db));

  const markerTimer = setInterval(() => {
    try {
      writeStateMarker(config.dataDir, queryCounts(dbHandle.db));
    } catch (err) {
      console.error(
        'state marker refresh failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, 60_000);
  markerTimer.unref?.();

  const http = await startHttpServer({
    host: config.host,
    port: config.port,
    mcp: mcpManager,
    tokens,
    projects,
    agentSessions: agentSessionsSvc,
    db: dbHandle,
    rateLimiter,
    triggerConsolidation: () => Promise.resolve(runner.runAll({ force: true })),
    sweep: sweepOnSessionStart,
    dashboard: {
      db: dbHandle.db,
      tokens,
      sessions,
      agentSessions: agentSessionsSvc,
      projects,
      prompts: promptsSvc,
      memory: memorySvc,
      getStats: () => collectStats(dbHandle, agentSessionsSvc, relationsSvc),
      dataDir: config.dataDir,
      updates,
      selfUpdate,
    },
  });

  printReadyBanner(http.url, firstRun);

  return {
    config,
    http,
    dbHandle,
    shutdown: async () => {
      clearInterval(markerTimer);
      try {
        writeStateMarker(config.dataDir, queryCounts(dbHandle.db));
      } catch (err) {
        console.error(
          'state marker write on shutdown failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      clearInterval(embedTimer);
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

function printBootstrapBanner(config: Config, counts: DataCounts): void {
  console.error(`[bootstrap] rembric v${REMBRIC_VERSION} ready`);
  console.error(`[bootstrap] data_dir=${config.dataDir}`);
  console.error(
    `[bootstrap] counts: memory=${counts.memory} projects=${counts.projects} sessions=${counts.sessions} tokens=${counts.tokens} prompts=${counts.prompts}`,
  );
}

function printReadyBanner(url: string, firstRun: boolean): void {
  console.error(`[bootstrap] listening on ${url}`);
  console.error(`  ✓ MCP endpoint:  ${url}/mcp`);
  console.error(`  ✓ Dashboard:     ${url}/dashboard`);
  console.error(`  ✓ Healthcheck:   ${url}/healthz (bearer token required)`);
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
    if (backlog > 100) {
      warnings.push(`embeddings backlog: ${backlog}`);
    }

    const sessionsByStatus = deps.agentSessions.countByStatus();

    return {
      db: { open: true, journalMode, integrity, sizeBytes },
      embeddings: { model: EMBEDDING_MODEL_ID, backlog },
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
