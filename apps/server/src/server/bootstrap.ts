import { join } from 'node:path';

import { findStaleEnvVars, loadConfig, redactConfig, type Config } from '../config.js';
import { ConsolidationRunner } from '../consolidation/index.js';
import { undoOp, undoRun } from '../consolidation/operations.js';
import { createDiagnostics, type DbDiagnostics } from '../db/diagnostics.js';
import { createDb, createRepositories, type DbHandle, type Repositories } from '../db/index.js';
import {
  EMBEDDING_MODEL_ID,
  embeddingQueryInput,
  loadEmbedder,
  type Embedder,
} from '../embeddings/embedder.js';
import { ensureVectorModel } from '../embeddings/state.js';
import { logger, setLogLevel } from '../logger.js';
import { createMcpServer, McpTransportManager } from '../mcp/index.js';
import type { DoctorReport } from '../mcp/observability-tools.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { EntityBackfillWorker } from '../services/entity-backfill-worker.js';
import { ensureEntityExtractor } from '../services/entity-state.js';
import { DomainError } from '../services/errors.js';
import { MemoryService } from '../services/memory.js';
import { OAuthService, SUPPORTED_OAUTH_SCOPES } from '../services/oauth.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { reviewTtlEntries } from '../services/review.js';
import { CapabilityDetector } from '../services/self-update/capability.js';
import { DockerEngineApi } from '../services/self-update/engine-api.js';
import {
  createPreUpdateBackup,
  SelfUpdateOrchestrator,
} from '../services/self-update/orchestrator.js';
import { SessionsService } from '../services/sessions.js';
import { deriveOAuthAreqKey, deriveSessionKey, TokensService } from '../services/tokens.js';
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
import { createOAuthProvider } from './oauth-provider.js';
import { AuthLockout, RateLimiter } from './rate-limit.js';
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
  setLogLevel(config.logLevel);
  printStartupBanner(config);

  const staleVars = findStaleEnvVars(env);
  if (staleVars.length > 0) {
    logger.warn(
      `ignoring removed env vars (chat LLM, consolidation cron and embedding provider were removed): ${staleVars.join(', ')}`,
    );
  }

  const dbHandle = createDb({ dataDir: config.dataDir });
  const repos = createRepositories(dbHandle.db);
  const dbDiagnostics = createDiagnostics(dbHandle);

  const tokens = new TokensService(repos);
  const projects = new ProjectsService(repos);
  const agentSessionsSvc = new AgentSessionsService(repos, dbHandle.db);
  const promptsSvc = new PromptsService(repos, dbHandle.db);
  const relationsSvc = new RelationsService(repos, dbHandle.db);
  const sessionRouter = new SessionRouter();

  // Mark inflight sessions from a prior run as abandoned. The router is
  // an in-process map so a restart wipes routing state; sweeping the DB
  // keeps it consistent.
  const abandoned = agentSessionsSvc.abandonStale({
    olderThanMs: config.sessions.abandonAfterMs,
  });
  if (abandoned.abandoned > 0) {
    logger.info(`${abandoned.abandoned} stale session(s) marked abandoned`);
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
  const sessions = new SessionsService(repos, deriveSessionKey(sessionSecretBase));

  // OAuth 2.1 authorization server — enabled only when REMBRIC_PUBLIC_URL is
  // set (`config.oauth.issuer` is non-null iff enabled). The SDK router owns
  // the protocol; our service owns persistence/logic; consent lives in the
  // dashboard.
  const oauthIssuer = config.oauth.issuer;
  const oauthAreqKey = deriveOAuthAreqKey(sessionSecretBase);
  const oauthService = oauthIssuer
    ? new OAuthService(
        { oauth: repos.oauth },
        { accessTtlMs: config.oauth.accessTtlMs, refreshTtlMs: config.oauth.refreshTtlMs },
      )
    : null;
  const oauthProvider =
    oauthService && oauthIssuer
      ? createOAuthProvider({
          oauth: oauthService,
          projects,
          issuer: oauthIssuer,
          areqKey: oauthAreqKey,
        })
      : null;

  // In-process embedder + drain worker — fills memory_vec so save-time
  // candidate detection has vectors to kNN over. The model loads eagerly
  // and is REQUIRED: a load failure aborts the boot (fail fast) so a
  // listening server always has a warm model. A model change invalidates
  // stale vectors up front and the drain re-embeds them in resumable
  // batches.
  const embedStart = Date.now();
  const embedder = overrides.embedder ?? (await loadEmbedder());
  if (!overrides.embedder) {
    logger.info(`embedding model loaded in ${Date.now() - embedStart}ms (${embedder.modelId})`);
  }
  const vectorReset = ensureVectorModel(repos, config.dataDir);
  if (vectorReset.wiped > 0) {
    logger.warn(
      `embedding model changed → ${vectorReset.wiped} stale vector(s) wiped; re-embedding in background`,
    );
  }

  // Constructed after the embedder so the hybrid-search dense branch has a
  // live `embedQuery`; the embedder is REQUIRED at boot so this is non-lazy.
  const memorySvc = new MemoryService(repos, dbHandle.db, undefined, (text) =>
    embedder.embed(embeddingQueryInput(text)),
  );
  const embeddingWorker = new EmbeddingWorker({ repos, embedder });

  const embedTick = (force = false): void => {
    embeddingWorker.processBatch({ force }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('embedding worker error', { message });
    });
  };
  // First pass immediately to backfill anything pending from a prior run.
  embedTick(true);
  const embedTimer = setInterval(() => embedTick(), 30_000);
  // Don't keep the event loop alive solely for this timer during shutdown.
  embedTimer.unref?.();
  // Safety net: force a full backlog re-check periodically in case some
  // future insert path forgets to signal the worker's possiblyPending flag.
  const embedFallbackTimer = setInterval(() => embedTick(true), 60 * 60_000);
  embedFallbackTimer.unref?.();

  // Resumable entity-extraction backfill (add-entity-index) — same
  // in-process tick+timer shape as the embedding worker, but synchronous
  // (no model, no network) so the tick itself never needs a `.catch()`.
  try {
    if (ensureEntityExtractor(repos, config.dataDir).reset) {
      logger.warn('entity extractor recipe changed → index reset; re-scanning in background');
    }
  } catch (err) {
    logger.warn(`entity extractor identity check failed; leaving index as-is: ${String(err)}`);
  }
  const entityBackfillWorker = new EntityBackfillWorker({ repos });
  const entityBackfillTick = (force = false): void => {
    try {
      entityBackfillWorker.processBatch({ force });
    } catch (err) {
      logger.error('entity backfill worker error', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Self-scheduling: a recipe-change rebuild drains a whole corpus, and a fixed
  // 30s tick left `entity` lookups incomplete for ~100min on 10k memories.
  const ENTITY_DRAIN_DELAY_MS = 500;
  const ENTITY_IDLE_DELAY_MS = 30_000;
  let entityBackfillTimer: NodeJS.Timeout | undefined;
  let entityBackfillStopped = false;
  const scheduleEntityBackfill = (delayMs: number): void => {
    if (entityBackfillStopped) return;
    entityBackfillTimer = setTimeout(() => {
      entityBackfillTick();
      scheduleEntityBackfill(
        entityBackfillWorker.hasPendingWork ? ENTITY_DRAIN_DELAY_MS : ENTITY_IDLE_DELAY_MS,
      );
    }, delayMs);
    entityBackfillTimer.unref?.();
  };
  entityBackfillTick(true);
  scheduleEntityBackfill(
    entityBackfillWorker.hasPendingWork ? ENTITY_DRAIN_DELAY_MS : ENTITY_IDLE_DELAY_MS,
  );
  const entityBackfillFallbackTimer = setInterval(() => entityBackfillTick(true), 60 * 60_000);
  entityBackfillFallbackTimer.unref?.();

  // Periodic stale-session reaper — the boot-time sweep above only catches
  // rows leaked by a PRIOR process run; a client killed mid-session (SIGKILL,
  // OOM, closed terminal) while THIS process keeps running would otherwise
  // block `findActiveForTransport` for every subsequent session on the same
  // (token, project) for as long as the server stays up. See
  // openspec/changes/fix-audited-defects.
  const sessionReapTimer = setInterval(() => {
    try {
      const result = agentSessionsSvc.abandonStale({ olderThanMs: config.sessions.abandonAfterMs });
      if (result.abandoned > 0) {
        logger.info(`${result.abandoned} stale session(s) marked abandoned (periodic reap)`);
      }
    } catch (err) {
      logger.error('periodic session reap failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, 30 * 60_000);
  sessionReapTimer.unref?.();

  // Doctor report builder — captures live services for `memory.doctor`.
  const buildDoctorReport = buildDoctorReportFactory({
    diagnostics: dbDiagnostics,
    repos,
    agentSessions: agentSessionsSvc,
  });

  // Deterministic consolidation sweep — decay + deadline orphaning, no
  // LLM, no cron. Triggered lazily on session start (throttled per scope)
  // and manually via POST /admin/consolidation/run.
  const runner = new ConsolidationRunner({
    repos,
    tx: dbHandle.db,
    relations: relationsSvc,
    agentSessions: agentSessionsSvc,
    orphanDeadlineMs: config.judgments.orphanDeadlineMs,
  });
  const sweepOnSessionStart = (projectId: string | null): void => {
    setImmediate(() => {
      try {
        runner.sweepFor(projectId);
      } catch (err) {
        logger.error('consolidation sweep failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  // One McpServer per session (the SDK requires a fresh server per
  // connected transport). The factory receives the URL path slug so the
  // emitted instructions block matches the connection scope.
  const mcpManager = new McpTransportManager(
    (factoryCtx) =>
      createMcpServer({
        memory: memorySvc,
        projects,
        agentSessions: agentSessionsSvc,
        prompts: promptsSvc,
        relations: relationsSvc,
        candidates: {
          perSaveMax: config.candidates.perSaveMax,
        },
        embedNow: (memoryId, title, content, scope, projectId) =>
          embeddingWorker.embedNow(memoryId, title, content, scope, projectId),
        router: sessionRouter,
        repos,
        doctor: buildDoctorReport,
        sweep: sweepOnSessionStart,
        orphanAfterMs: config.judgments.orphanAfterMs,
        requestedSlug: factoryCtx.requestedSlug,
      }),
    {
      allowedHosts: config.mcpTransport.allowedHosts,
      allowedOrigins: config.mcpTransport.allowedOrigins,
    },
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
        vacuumInto: (dest) => dbDiagnostics.vacuumInto(dest),
        backupsDir: join(config.dataDir, 'backups'),
      }),
    });

  const rateLimiter = config.rateLimit.enabled
    ? new RateLimiter({
        ratePerSecond: config.rateLimit.ratePerSecond,
        burst: config.rateLimit.burst,
      })
    : null;

  // Always on: only ever penalises repeated authentication FAILURES from one
  // network identity, throttling them before the token-hash scan.
  const authLockout = new AuthLockout(config.authLockout);

  try {
    assertDataLossGuard({ dataDir: config.dataDir, diagnostics: dbDiagnostics, env });
  } catch (err) {
    if (err instanceof DataLossGuardError) {
      dbHandle.close();
      process.exit(78);
    }
    throw err;
  }

  printBootstrapBanner(config, queryCounts(dbDiagnostics));

  const markerTimer = setInterval(() => {
    try {
      writeStateMarker(config.dataDir, queryCounts(dbDiagnostics));
    } catch (err) {
      logger.error('state marker refresh failed', {
        message: err instanceof Error ? err.message : String(err),
      });
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
    diagnostics: dbDiagnostics,
    rateLimiter,
    authLockout,
    maxBodyBytes: config.maxBodyBytes,
    triggerConsolidation: () => Promise.resolve(runner.runAll({ force: true })),
    sweep: sweepOnSessionStart,
    oauth:
      oauthService && oauthProvider && oauthIssuer
        ? {
            provider: oauthProvider,
            service: oauthService,
            issuer: oauthIssuer,
            scopesSupported: [...SUPPORTED_OAUTH_SCOPES],
          }
        : null,
    dashboard: {
      repos,
      diagnostics: dbDiagnostics,
      tokens,
      sessions,
      agentSessions: agentSessionsSvc,
      projects,
      prompts: promptsSvc,
      memory: memorySvc,
      relations: relationsSvc,
      getStats: () => collectStats(repos, agentSessionsSvc, relationsSvc),
      dataDir: config.dataDir,
      updates,
      selfUpdate,
      triggerSweep: () => runner.runAll({ force: true }),
      entityBackfillWorker,
      undoRun: (runId) => undoRun(repos, dbHandle.db, runId),
      undoOp: (opId) => undoOp(repos, dbHandle.db, opId),
      orphanAfterMs: config.judgments.orphanAfterMs,
      orphanDeadlineMs: config.judgments.orphanDeadlineMs,
      oauth: oauthService,
      oauthAreqKey: oauthService ? oauthAreqKey : null,
      secureCookies: (oauthIssuer ?? '').startsWith('https:'),
      authLockout,
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
        writeStateMarker(config.dataDir, queryCounts(dbDiagnostics));
      } catch (err) {
        logger.error('state marker write on shutdown failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      clearInterval(embedTimer);
      clearInterval(embedFallbackTimer);
      entityBackfillStopped = true;
      if (entityBackfillTimer) clearTimeout(entityBackfillTimer);
      clearInterval(entityBackfillFallbackTimer);
      clearInterval(sessionReapTimer);
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
  if (config.oauth.enabled) {
    console.error(`[bootstrap] oauth: enabled, issuer=${config.oauth.issuer}`);
  }
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
  diagnostics: DbDiagnostics;
  repos: Repositories;
  agentSessions: AgentSessionsService;
}): () => DoctorReport {
  return () => {
    const warnings: string[] = [];

    let journalMode = 'unknown';
    let integrity = 'unknown';
    let sizeBytes = 0;
    try {
      journalMode = deps.diagnostics.readJournalMode();
      integrity = deps.diagnostics.quickCheck();
      sizeBytes = deps.diagnostics.readDbSize().totalBytes;
    } catch (err) {
      warnings.push(`db pragma read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (integrity !== 'ok') warnings.push(`db integrity: ${integrity}`);

    const lastConsolidation = deps.repos.consolidation.adminLatestRun();

    let lastRunOps: Record<string, number> = {};
    if (lastConsolidation?.summary) {
      try {
        lastRunOps = JSON.parse(lastConsolidation.summary) as Record<string, number>;
      } catch {
        // ignore malformed JSON; the journal stays the source of truth
      }
    }

    const backlog = deps.repos.vectors.adminBacklogCount();
    if (backlog > 100) {
      warnings.push(`embeddings backlog: ${backlog}`);
    }

    const entitiesBacklog = deps.repos.entities.adminBacklogCount();
    if (entitiesBacklog > 100) {
      warnings.push(`entities backlog: ${entitiesBacklog}`);
    }

    // Deliberate spec exception (mcp-api/spec.md): memory.doctor's session,
    // needsReview, and pendingJudgments counts are all server-wide, unlike
    // memory.stats's scoped ones — same precedent, applied consistently.
    const sessionsByStatus = deps.agentSessions.adminCountByStatus();
    const needsReview = deps.repos.memory.adminCountNeedsReview({
      nowMs: Date.now(),
      ttlByType: reviewTtlEntries(),
    });
    const pendingJudgments = deps.repos.relations.adminCountByStatus('pending');

    return {
      db: { open: true, journalMode, integrity, sizeBytes },
      embeddings: { model: EMBEDDING_MODEL_ID, backlog },
      entities: { backlog: entitiesBacklog },
      consolidation: {
        lastRunAt: lastConsolidation?.startedAt ? lastConsolidation.startedAt.toISOString() : null,
        lastRunOps,
      },
      sessions: { active: sessionsByStatus.active },
      review: { needsReview, pendingJudgments },
      warnings,
    };
  };
}

function collectStats(
  repos: Repositories,
  agentSessionsSvc: AgentSessionsService,
  relationsSvc: RelationsService,
): DashboardStats {
  const consolidationRow = repos.consolidation.adminLatestRun();
  const sessionsByStatus = agentSessionsSvc.adminCountByStatus();
  const relationsByStatus = relationsSvc.countByStatus();
  const memoriesByStatus = repos.memory.countRowsByStatus();

  return {
    totalMemories: memoriesByStatus.reduce((acc, r) => acc + r.count, 0),
    activeMemories: memoriesByStatus.find((r) => r.status === 'active')?.count ?? 0,
    archivedMemories: memoriesByStatus.find((r) => r.status === 'archived')?.count ?? 0,
    projects: repos.projects.count(),
    lastConsolidationAt: consolidationRow?.startedAt ?? null,
    activeSessions: sessionsByStatus.active,
    pendingJudgments: relationsByStatus.pending,
  };
}
