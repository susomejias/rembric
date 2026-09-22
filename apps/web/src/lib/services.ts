import {
  AgentSessionsService,
  ConsolidationRunner,
  EmbeddingWorker,
  EntityBackfillWorker,
  MemoryService,
  OAuthService,
  ProjectsService,
  PromptsService,
  RelationsService,
  TokensService,
  UsageCounters,
  embeddingQueryInput,
  loadEmbedder,
  undoOp as coreUndoOp,
  undoRun as coreUndoRun,
  type ConsolidationRunSummary,
  type Embedder,
  type SkippedRow,
  type UndoResult,
} from '@rembric/core';
import { createRepositories, type DbHandle, type Repositories } from '@rembric/db';

import { AuthLockout } from './auth-lockout';
import { getDb } from './db';

export interface Services {
  db: DbHandle;
  repos: Repositories;
  tokens: TokensService;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
  memory: MemoryService;
  relations: RelationsService;
  prompts: PromptsService;
  usageCounters: UsageCounters;
  authLockout: AuthLockout;
  sessionAbandonAfterMs: number;
  embeddingWorker: () => Promise<EmbeddingWorker>;
  hasEmbeddingBacklog: () => boolean;
  entityBackfillWorker: EntityBackfillWorker;
  oauth: OAuthService | null;
  sweep: (projectId: string | null) => void;
  forcedSweep: () => ConsolidationRunSummary;
  undoRun: (runId: string) => { reverted: string[]; skipped: SkippedRow[] };
  undoOp: (opId: string) => UndoResult;
}

const globalForServices = globalThis as typeof globalThis & { __rembricServices?: Services };

export function getServices(): Services {
  const cached = globalForServices.__rembricServices;
  if (cached !== undefined) return cached;

  const built = buildServices();
  globalForServices.__rembricServices = built;
  return built;
}

function buildServices(): Services {
  const db = getDb();
  const repos = createRepositories(db.db);
  const tokens = new TokensService(repos, db.db);
  const projects = new ProjectsService(repos);
  const agentSessions = new AgentSessionsService(repos, db.db);
  const relations = new RelationsService(repos, db.db);
  const prompts = new PromptsService(repos, db.db);
  const usageCounters = new UsageCounters();

  let embedderPromise: Promise<Embedder> | null = null;
  const getEmbedder = (): Promise<Embedder> => (embedderPromise ??= loadEmbedder());

  const memory = new MemoryService(repos, db.db, undefined, (text) =>
    getEmbedder().then((embedder) => embedder.embed(embeddingQueryInput(text))),
  );

  let embeddingWorkerPromise: Promise<EmbeddingWorker> | null = null;
  const embeddingWorker = (): Promise<EmbeddingWorker> =>
    (embeddingWorkerPromise ??= getEmbedder().then(
      (embedder) => new EmbeddingWorker({ repos, embedder }),
    ));

  const entityBackfillWorker = new EntityBackfillWorker({ repos, tx: db.db });

  const runner = new ConsolidationRunner({
    repos,
    tx: db.db,
    relations,
    projects,
    agentSessions,
    orphanDeadlineMs: envInt('JUDGMENT_ORPHAN_DEADLINE_MS', 14 * 86_400_000, {
      min: 3_600_000,
      max: 365 * 86_400_000,
    }),
  });
  const sweep = (projectId: string | null): void => {
    setImmediate(() => {
      try {
        runner.sweepFor(projectId);
      } catch (err) {
        console.error('[api] consolidation sweep failed', err);
      }
    });
  };

  return {
    db,
    repos,
    tokens,
    projects,
    agentSessions,
    memory,
    relations,
    prompts,
    usageCounters,
    authLockout: new AuthLockout({
      maxFailures: envInt('AUTH_LOCKOUT_MAX_FAILURES', 10, { min: 1, max: 10_000 }),
      windowMs: envInt('AUTH_LOCKOUT_WINDOW_MS', 60_000, { min: 1_000, max: 3_600_000 }),
      lockoutMs: envInt('AUTH_LOCKOUT_MS', 60_000, { min: 1_000, max: 24 * 3_600_000 }),
    }),
    sessionAbandonAfterMs: envInt('SESSION_ABANDON_AFTER_MS', 86_400_000, {
      min: 60_000,
      max: 30 * 86_400_000,
    }),
    embeddingWorker,
    hasEmbeddingBacklog: () => repos.vectors.findMissingEmbeddings(1).length > 0,
    entityBackfillWorker,
    oauth: buildOAuthService(repos),
    sweep,
    forcedSweep: () => runner.runAll({ force: true }),
    undoRun: (runId) => coreUndoRun(repos, db.db, runId),
    undoOp: (opId) => coreUndoOp(repos, db.db, opId),
  };
}

function envInt(name: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, bounds.min), bounds.max);
}

function buildOAuthService(repos: Repositories): OAuthService | null {
  const issuer = process.env['REMBRIC_PUBLIC_URL'];
  if (issuer === undefined || issuer.length === 0) return null;
  return new OAuthService(
    { oauth: repos.oauth },
    {
      accessTtlMs: envInt('REMBRIC_OAUTH_ACCESS_TTL', 3600, { min: 60, max: 86_400 }) * 1000,
      refreshTtlMs:
        envInt('REMBRIC_OAUTH_REFRESH_TTL', 30 * 86_400, { min: 3600, max: 365 * 86_400 }) * 1000,
    },
  );
}
