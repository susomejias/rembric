import {
  AgentSessionsService,
  ConsolidationRunner,
  MemoryService,
  OAuthService,
  ProjectsService,
  RelationsService,
  TokensService,
  UsageCounters,
  embeddingQueryInput,
  loadEmbedder,
  type Embedder,
} from '@rembric/core';
import { createRepositories, type DbHandle, type Repositories } from '@rembric/db';

import { AuthLockout } from './auth-lockout';
import { getDb } from './db';

/**
 * The services the session-lifecycle HTTP API's handlers call, wired the way
 * `apps/server/src/server/bootstrap.ts` wires them for the same router. This
 * module is the web app's counterpart of that bootstrapper; it deliberately
 * wires NO background timers, no embedder drain worker and no admin-token
 * bootstrap, because during the transition `apps/server` keeps owning those
 * over the one shared database.
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
  usageCounters: UsageCounters;
  authLockout: AuthLockout;
  /** The `/api` access-token fallback, exactly as the server gates it: present iff `REMBRIC_PUBLIC_URL` is set. */
  oauth: OAuthService | null;
  /** Fire-and-forget consolidation sweep; never affects a response. */
  sweep: (projectId: string | null) => void;
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
    usageCounters,
    authLockout: new AuthLockout({
      maxFailures: envInt('AUTH_LOCKOUT_MAX_FAILURES', 10, { min: 1, max: 10_000 }),
      windowMs: envInt('AUTH_LOCKOUT_WINDOW_MS', 60_000, { min: 1_000, max: 3_600_000 }),
      lockoutMs: envInt('AUTH_LOCKOUT_MS', 60_000, { min: 1_000, max: 24 * 3_600_000 }),
    }),
    oauth: buildOAuthService(repos),
    sweep,
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
 * enabled iff `REMBRIC_PUBLIC_URL` is set. Only the access-token *lookup* is
 * reachable from `/api`; the authorization-server endpoints are a later slice.
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
