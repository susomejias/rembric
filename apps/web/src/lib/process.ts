import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import {
  ensureEntityExtractor,
  entityMarkerPath,
  reconcileArchivedProjectJudgments,
  RERANK_DEADLINE_MS,
  RERANK_WINDOW,
} from '@rembric/core';
import {
  assertDataLossGuard,
  createDiagnostics,
  DataLossGuardError,
  queryCounts,
  writeStateMarker,
} from '@rembric/db';

import type { Services } from './services';
import { getServices } from './services';

const ADMIN_TOKEN_MIN_LENGTH = 16;

const REAP_INTERVAL_MS = 30 * 60_000;
const EMBED_TICK_MS = 30_000;
export const EMBED_DRAIN_DELAY_MS = 1_000;
const EMBED_FALLBACK_MS = 60 * 60_000;

const ENTITY_DRAIN_DELAY_MS = 500;
const ENTITY_IDLE_DELAY_MS = 30_000;
const ENTITY_FALLBACK_MS = 60 * 60_000;

const MARKER_REFRESH_MS = 60_000;

const globalForProcess = globalThis as typeof globalThis & {
  __rembricProcessStarted?: boolean;
};

export function startProcess(): void {
  if (globalForProcess.__rembricProcessStarted === true) {
    console.error('[process] already started in this process → skipping re-entry');
    return;
  }
  globalForProcess.__rembricProcessStarted = true;

  const services = getServices();

  const dataDir = dirname(services.db.raw.name);
  const diagnostics = createDiagnostics(services.db);

  try {
    assertDataLossGuard({ dataDir, diagnostics, env: process.env });
  } catch (err) {
    if (err instanceof DataLossGuardError) {
      console.error('[process] data-loss guard refused startup');
      process.exit(78);
    }
    throw err;
  }

  const counts = queryCounts(diagnostics);
  console.error(
    `[bootstrap] counts: memory=${counts.memory} projects=${counts.projects} sessions=${counts.sessions} tokens=${counts.tokens} prompts=${counts.prompts}`,
  );

  const markerTimer = setInterval(() => {
    try {
      writeStateMarker(dataDir, queryCounts(diagnostics));
    } catch (err) {
      console.error('[process] state marker refresh failed', message(err));
    }
  }, MARKER_REFRESH_MS);
  markerTimer.unref?.();

  bootstrapAdminToken(services);
  startSessionReaper(services);
  startEmbeddingDrain(services);
  startEntityBackfill(services);
  void closeArchivedProjectJudgments(services);
  void warmEmbedder(services).then(() => warmReranker(services));
}

export async function closeArchivedProjectJudgments(
  services: Pick<Services, 'repos' | 'db'>,
  reconcile: typeof reconcileArchivedProjectJudgments = reconcileArchivedProjectJudgments,
): Promise<void> {
  const started = performance.now();
  try {
    const { closed, projects } = await reconcile(services.repos, services.db.db);
    if (closed > 0) {
      const ms = Math.round(performance.now() - started);
      console.error(
        `[process] archived-project judgments: closed ${closed} in ${projects} projects (${ms} ms)`,
      );
    }
  } catch (err) {
    console.error('[process] archived-project judgment reconciliation failed', message(err));
  }
}

async function warmEmbedder(services: Services): Promise<void> {
  try {
    const warmed = await services.warmEmbedder();
    if (warmed) {
      console.error(
        '[process] embedder warmed (pipeline + first inferences ran off the turn path)',
      );
    } else {
      console.error(
        '[process] embedder warmup skipped (no local model cache; the first save loads it)',
      );
    }
  } catch (err) {
    console.error('[process] embedder warmup failed', message(err));
  }
}

export async function warmReranker(services: Pick<Services, 'reranker'>): Promise<void> {
  if (!services.reranker) {
    console.error('[process] reranking disabled (REMBRIC_RERANK=off)');
    return;
  }
  const started = performance.now();
  const ready = await services.reranker.start();
  const ms = Math.round(performance.now() - started);
  if (!ready) {
    console.error('[process] reranker unavailable; searches serve the unreranked order');
    return;
  }
  console.error(`[process] reranker ready in its worker thread (${ms} ms)`);
  const window = Array.from(
    { length: RERANK_WINDOW },
    (_, i) =>
      `Warm-up ${i}\n\n${'the reranker reads this text to time a full window. '.repeat(24)}`,
  );
  await services.reranker.score('reranker warm-up', window);
  const timed = performance.now();
  const scored = await services.reranker.score('reranker warm-up', window);
  const windowMs = Math.round(performance.now() - timed);
  console.error(
    scored
      ? `[process] reranker full window ${windowMs} ms (deadline ${RERANK_DEADLINE_MS} ms)`
      : `[process] reranker full window missed its ${RERANK_DEADLINE_MS} ms deadline: this CPU is too slow for reranking to apply, so searches fall back to the unreranked order; set REMBRIC_RERANK=off to free its memory`,
  );
}

function bootstrapAdminToken(services: Services): void {
  const configured = process.env['REMBRIC_ADMIN_TOKEN'];
  const threaded = threadSessionSecret(configured ?? null);

  const existing = services.tokens.count();
  if (existing > 0) {
    console.error(
      `[process] admin token present (${existing} token row(s)) → bootstrap is a no-op`,
    );
    if (!threaded) {
      console.error(
        '[process] no session secret: set REMBRIC_SESSION_SECRET or REMBRIC_ADMIN_TOKEN, otherwise `/dashboard` cannot sign anyone in',
      );
    }
    return;
  }

  let token: string;
  if (configured !== undefined && configured.length > 0) {
    if (configured.length < ADMIN_TOKEN_MIN_LENGTH) {
      console.error(
        `[process] REMBRIC_ADMIN_TOKEN is shorter than ${ADMIN_TOKEN_MIN_LENGTH} characters and was NOT used; no admin token created — set a strong random value (openssl rand -hex 32)`,
      );
      return;
    }
    token = configured;
  } else {
    token = randomBytes(32).toString('hex');
  }

  try {
    services.tokens.bootstrapAdmin(token);
  } catch (err) {
    console.error('[process] admin token bootstrap failed', message(err));
    return;
  }

  threadSessionSecret(token);

  if (token === configured) {
    console.error('[process] admin token bootstrapped from REMBRIC_ADMIN_TOKEN');
    return;
  }
  console.error(
    '[process] no admin token in the database and REMBRIC_ADMIN_TOKEN is unset → first-run bootstrap created one:',
  );
  console.error(`[process]   REMBRIC_ADMIN_TOKEN=${token}`);
  console.error(
    '[process] this value is now in this process log; set REMBRIC_ADMIN_TOKEN to keep it out of the logs',
  );
}

function threadSessionSecret(candidate: string | null): boolean {
  const explicit = process.env['REMBRIC_SESSION_SECRET'];
  if (explicit !== undefined && explicit.length > 0) return true;
  if (candidate === null || candidate.length < ADMIN_TOKEN_MIN_LENGTH) return false;
  process.env['REMBRIC_SESSION_SECRET'] = candidate;
  console.error('[process] session signing key set from the admin token');
  return true;
}

function startSessionReaper(services: Services): void {
  const { agentSessions, sessionAbandonAfterMs } = services;

  try {
    const boot = agentSessions.abandonStale({ olderThanMs: sessionAbandonAfterMs });
    if (boot.abandoned > 0) {
      console.error(`[process] ${boot.abandoned} stale session(s) marked abandoned`);
    }
  } catch (err) {
    console.error('[process] boot session sweep failed', message(err));
  }

  const reaper = setInterval(() => {
    try {
      const reaped = agentSessions.abandonStale({ olderThanMs: sessionAbandonAfterMs });
      if (reaped.abandoned > 0) {
        console.error(
          `[process] ${reaped.abandoned} stale session(s) marked abandoned (periodic reap)`,
        );
      }
    } catch (err) {
      console.error('[process] periodic session reap failed', message(err));
    }
  }, REAP_INTERVAL_MS);
  reaper.unref?.();

  console.error(
    `[process] session reaper started (every ${REAP_INTERVAL_MS / 60_000} min; abandon after ${sessionAbandonAfterMs} ms)`,
  );
}

export function startEmbeddingDrain(
  services: Pick<Services, 'embeddingWorker' | 'hasEmbeddingBacklog'>,
): void {
  let inFlight = false;

  const tick = async (force: boolean): Promise<void> => {
    if (inFlight) return;
    if (!force && !services.hasEmbeddingBacklog()) return;
    inFlight = true;
    try {
      const worker = await services.embeddingWorker();
      await worker.processBatch({ force });
    } finally {
      inFlight = false;
    }
  };
  const run = (force: boolean): Promise<void> =>
    tick(force).catch((err) => console.error('[process] embedding worker error', message(err)));

  const schedule = (delayMs: number): void => {
    const timer = setTimeout(() => {
      void run(false).then(() =>
        schedule(services.hasEmbeddingBacklog() ? EMBED_DRAIN_DELAY_MS : EMBED_TICK_MS),
      );
    }, delayMs);
    timer.unref?.();
  };
  const fallbackTimer = setInterval(() => void run(true), EMBED_FALLBACK_MS);
  fallbackTimer.unref?.();

  void run(false).then(() =>
    schedule(services.hasEmbeddingBacklog() ? EMBED_DRAIN_DELAY_MS : EMBED_TICK_MS),
  );

  console.error(
    `[process] embedder drain started (every ${EMBED_TICK_MS / 1000} s, ${EMBED_DRAIN_DELAY_MS} ms between batches while a backlog drains, forced hourly; the model loads on the first pending row)`,
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function startEntityBackfill(services: Services): void {
  const dataDir = dirname(services.db.raw.name);

  try {
    if (ensureEntityExtractor(services.repos, dataDir, services.db.db).reset) {
      console.error(
        '[process] entity extractor recipe changed → index reset; re-scanning in background',
      );
    }
  } catch (err) {
    console.error(
      `[process] entity extractor identity check failed; re-checking next boot (${entityMarkerPath(dataDir)}): ${message(err)}`,
    );
  }

  const worker = services.entityBackfillWorker;
  const tick = (force: boolean): void => {
    try {
      worker.processBatch({ force });
    } catch (err) {
      console.error('[process] entity backfill worker error', message(err));
    }
  };

  const nextDelay = (): number =>
    worker.hasPendingWork ? ENTITY_DRAIN_DELAY_MS : ENTITY_IDLE_DELAY_MS;

  const schedule = (delayMs: number): void => {
    const timer = setTimeout(() => {
      tick(false);
      schedule(nextDelay());
    }, delayMs);
    timer.unref?.();
  };

  tick(true);
  schedule(nextDelay());

  const fallbackTimer = setInterval(() => tick(true), ENTITY_FALLBACK_MS);
  fallbackTimer.unref?.();

  console.error(
    `[process] entity backfill worker started (idle every ${ENTITY_IDLE_DELAY_MS / 1000} s, ${ENTITY_DRAIN_DELAY_MS} ms while a backlog drains; forced hourly)`,
  );
}
