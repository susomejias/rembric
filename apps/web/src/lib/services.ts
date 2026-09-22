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

/**
 * The services the session-lifecycle HTTP API's handlers call. This module owns
 * the service graph, the embedder memo and the two background workers (embedding
 * drain, entity backfill), while `lib/process.ts` owns the process-level pieces
 * that need timers or the boot-time admin-token bootstrap.
 *
 * Construction is lazy: `getDb()` and everything below it open the SQLite file,
 * which must never happen while `next build` imports these modules. The result
 * is cached on `globalThis` for the same reason `lib/db.ts` caches the handle —
 * Next re-evaluates modules on every HMR edit, and a second `TokensService`
 * over the same file would be a second writer.
 */

export interface Services {
  db: DbHandle;
  repos: Repositories;
  tokens: TokensService;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
  memory: MemoryService;
  /**
   * The judgment graph (`memory_relations`). The maintenance sweep already
   * needed this instance; the dashboard's orphan verb is why it is exposed.
   */
  relations: RelationsService;
  /**
   * Prompt rows and their purge. `maintenance/data.ts` builds its own
   * stateless instance over the same repositories because these reads predate
   * this graph; the mutations read the counts and purge through this one.
   */
  prompts: PromptsService;
  usageCounters: UsageCounters;
  authLockout: AuthLockout;
  /**
   * `SESSION_ABANDON_AFTER_MS` at the server's bounds and default — read by
   * `lib/process.ts` for the boot sweep and the periodic reaper.
   */
  sessionAbandonAfterMs: number;
  /**
   * The drain's worker, memoized. Constructing it pulls the embedder, so a
   * caller that only wants to know whether there is work must use
   * `hasEmbeddingBacklog()` instead.
   */
  embeddingWorker: () => Promise<EmbeddingWorker>;
  /** The worker's own anti-join query, without the model: does the drain have anything to do? */
  hasEmbeddingBacklog: () => boolean;
  /**
   * The entity-extraction backfill's worker. Extraction is pure and synchronous
   * (no model, no network), so unlike `embeddingWorker` this is constructed with
   * the rest of the graph instead of being memoized behind a promise.
   */
  entityBackfillWorker: EntityBackfillWorker;
  /** The `/api` access-token fallback, exactly as the server gates it: present iff `REMBRIC_PUBLIC_URL` is set. */
  oauth: OAuthService | null;
  /** Fire-and-forget consolidation sweep; never affects a response. */
  sweep: (projectId: string | null) => void;
  /**
   * The forced sweep the dashboard's "Run sweep now" control drives —
   * `bootstrap.ts`'s `triggerSweep: () => runner.runAll({ force: true })`,
   * returning the summary so the action can flash the purged-session count.
   */
  forcedSweep: () => ConsolidationRunSummary;
  /** `bootstrap.ts`'s bound undo lambdas, over the same repositories and transaction runner. */
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

  // Memoized on the Services object, so the transformer model is loaded once
  // per process and only when a request actually reaches the dense branch of
  // `memory.search`. A failed load stays failed for the process: the server
  // treats the embedder as required at boot, so a request that needs it must
  // not silently degrade to FTS-only with a 200.
  let embedderPromise: Promise<Embedder> | null = null;
  const getEmbedder = (): Promise<Embedder> => (embedderPromise ??= loadEmbedder());

  const memory = new MemoryService(repos, db.db, undefined, (text) =>
    getEmbedder().then((embedder) => embedder.embed(embeddingQueryInput(text))),
  );

  // Memoized on the same embedder promise: whichever comes first, the MCP
  // save path's inline `embedNow` or `lib/process.ts`'s drain, pays for exactly
  // one model load. A failed load stays failed for the process, exactly as the
  // memory service's `getEmbedder` above documents.
  let embeddingWorkerPromise: Promise<EmbeddingWorker> | null = null;
  const embeddingWorker = (): Promise<EmbeddingWorker> =>
    (embeddingWorkerPromise ??= getEmbedder().then(
      (embedder) => new EmbeddingWorker({ repos, embedder }),
    ));

  // `bootstrap.ts` passes neither `batchSize` nor `now`, so the worker's own
  // defaults (100 rows per batch) are the contract here too.
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

/**
 * The OAuth access-token fallback's service. `zod` is how the server validates
 * these env values; here an unset or unparseable value falls back to the same
 * default and an out-of-range one is clamped to the same bound, so a valid
 * deployment cannot drift between the two processes.
 */
function envInt(name: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, bounds.min), bounds.max);
}

/**
 * `OAuthService` construction mirrors the server's gate exactly: the feature is
 * enabled iff `REMBRIC_PUBLIC_URL` is set. This one instance backs both surfaces
 * — the `/api` access-token lookup, and the authorization server itself
 * (`lib/oauth.ts`, which builds the SDK's router and the provider over it).
 */
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
