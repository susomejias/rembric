import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { ensureEntityExtractor, entityMarkerPath } from '@rembric/core';
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

function startEmbeddingDrain(services: Services): void {
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
  const run = (force: boolean): void => {
    tick(force).catch((err) => console.error('[process] embedding worker error', message(err)));
  };

  const tickTimer = setInterval(() => run(false), EMBED_TICK_MS);
  const fallbackTimer = setInterval(() => run(true), EMBED_FALLBACK_MS);
  tickTimer.unref?.();
  fallbackTimer.unref?.();

  run(false);

  console.error(
    `[process] embedder drain started (every ${EMBED_TICK_MS / 1000} s, forced hourly; the model loads on the first pending row)`,
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
