import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { ensureEntityExtractor, entityMarkerPath } from '@rembric/core';

import type { Services } from './services';
import { getServices } from './services';

/**
 * The web app's process-level responsibilities — the part of
 * `apps/server/src/server/bootstrap.ts` that belongs to the running process
 * rather than to a listener: the eager database open, the admin-token
 * bootstrap, the stale-session reaper, the embedder drain worker and the
 * resumable entity-extraction backfill.
 *
 * `instrumentation.ts`'s `register()` is the only caller. `register()` may not
 * throw (Next treats a throwing hook as a fatal boot error), so every timer
 * below owns its own error handling and this module never propagates.
 */

/** `apps/server/src/config.ts` requires at least this much entropy. */
const ADMIN_TOKEN_MIN_LENGTH = 16;

/** `bootstrap.ts`: reap every 30 min, hourly forced embedding pass, 30 s tick. */
const REAP_INTERVAL_MS = 30 * 60_000;
const EMBED_TICK_MS = 30_000;
const EMBED_FALLBACK_MS = 60 * 60_000;

/**
 * `bootstrap.ts`: the entity backfill self-schedules — 500 ms between batches
 * while a backlog drains, 30 s when idle, plus an hourly forced pass.
 */
const ENTITY_DRAIN_DELAY_MS = 500;
const ENTITY_IDLE_DELAY_MS = 30_000;
const ENTITY_FALLBACK_MS = 60 * 60_000;

/**
 * `register()` is documented as once per server instance, but Next re-evaluates
 * modules on an HMR edit, so a module-level flag alone lets a reload start a
 * second reaper and a second drain over the same database. The flag lives on
 * `globalThis` for the same reason `lib/db.ts` caches the handle there.
 */
const globalForProcess = globalThis as typeof globalThis & {
  __rembricProcessStarted?: boolean;
};

export function startProcess(): void {
  if (globalForProcess.__rembricProcessStarted === true) {
    // Loud on purpose: this is the only evidence that a re-invocation of
    // `register()` was absorbed instead of starting a second reaper.
    console.error('[process] already started in this process → skipping re-entry');
    return;
  }
  globalForProcess.__rembricProcessStarted = true;

  // Eager `getServices()` is what opens the SQLite file: `createDb` runs the
  // migrations and narrates the resolved absolute path (data-safety DS1) before
  // this returns. Called lazily on the first request instead, that line moves
  // past the point where a mistyped `REMBRIC_DATA_DIR` could still be caught.
  const services = getServices();

  bootstrapAdminToken(services);
  startSessionReaper(services);
  startEmbeddingDrain(services);
  startEntityBackfill(services);
}

/**
 * Port of `bootstrap.ts`'s `tokens.bootstrapAdmin(config.adminToken)` call,
 * which is a no-op once any token row exists (the env var is authoritative
 * only at first run).
 *
 * One deliberate divergence: the server refuses to boot (exit 78) when
 * `REMBRIC_ADMIN_TOKEN` is unset on first run, while `register()` may not
 * terminate the process. An operator who never set the variable would then own
 * a database nobody can sign in to, so the token is minted and printed once
 * instead — and the log says where it went.
 */
function bootstrapAdminToken(services: Services): void {
  const configured = process.env['REMBRIC_ADMIN_TOKEN'];
  // Resolved before the row check, not after: the signing key depends on the
  // secret alone, so a deployment that already owns token rows and passes the
  // token in the environment must still get a usable dashboard.
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
      // Same refusal as the server's `REMBRIC_ADMIN_TOKEN: z.string().min(16)`,
      // minus the exit: an operator who set a weak value is told why it was not
      // used, and no token is invented over their explicit intent.
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

  // Only after the row exists: a signing key for a token the database does not
  // hold would sign sessions nobody can authenticate against.
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

/**
 * Publish the admin token as this process's session-signing key.
 *
 * `bootstrap.ts` resolves `REMBRIC_SESSION_SECRET ?? REMBRIC_ADMIN_TOKEN` once at
 * boot; this process may have neither, because Next loads `.env` from
 * `apps/web/`, never from the repository root, while the server's config does.
 * `lib/session.ts` reads the same two variables, so writing the resolved value
 * back into the environment is what makes a session minted here verify there and
 * vice versa — the key is the only thing the two must agree on.
 *
 * An explicit `REMBRIC_SESSION_SECRET` is never overwritten: it is the operator's
 * override, and the server gives it the same precedence.
 *
 * Returns whether a usable key is now in the environment.
 */
function threadSessionSecret(candidate: string | null): boolean {
  const explicit = process.env['REMBRIC_SESSION_SECRET'];
  if (explicit !== undefined && explicit.length > 0) return true;
  if (candidate === null || candidate.length < ADMIN_TOKEN_MIN_LENGTH) return false;
  process.env['REMBRIC_SESSION_SECRET'] = candidate;
  console.error('[process] session signing key set from the admin token');
  return true;
}

/**
 * Port of `bootstrap.ts`'s boot sweep plus its periodic reaper. The boot sweep
 * catches rows leaked by a PRIOR run; the interval catches a client killed
 * mid-session while THIS process keeps running, which would otherwise block
 * `findActiveForTransport` for the next session on the same (token, project)
 * for as long as the server stays up.
 */
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

/**
 * Port of `bootstrap.ts`'s embedder drain: an immediate first pass, a 30 s
 * tick, and an hourly forced full re-scan in case some insert path forgets to
 * signal the worker.
 *
 * The one deliberate difference is the embedder. The server loads the model
 * eagerly at boot and treats a load failure as fatal; this app loads it lazily
 * (the recorded process-model decision for `apps/web`), so a pass with no
 * backlog returns before `embeddingWorker()` — an idle boot never pays for the
 * model, while the first pending row makes the drain behave exactly as the
 * server's.
 */
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

  // Matches the server's immediate first pass: whatever a prior run left
  // unembedded is picked up now rather than one tick from now.
  run(false);

  console.error(
    `[process] embedder drain started (every ${EMBED_TICK_MS / 1000} s, forced hourly; the model loads on the first pending row)`,
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Port of `bootstrap.ts`'s resumable entity-extraction backfill: the extractor
 * identity check, an immediate forced batch, and a self-scheduling drain.
 *
 * `ensureEntityExtractor` is boot work, not drain work, and it is what makes
 * `entityIndexResetWarning` resolvable: `lib/mcp-server.ts` reports "the next
 * restart" as the moment a recipe change is repaired, so a boot that skipped
 * the check would leave that warning in `memory.doctor` forever.
 *
 * `dataDir` comes from the open connection rather than from
 * `REMBRIC_DATA_DIR`, the same choice `lib/mcp-server.ts::buildDoctorReport`
 * documents (data-safety DS1): the marker must be read from the directory this
 * process actually opened, or a deployment whose env disagrees with the file it
 * is serving would reset a marker next to a database it never touches.
 *
 * One deliberate omission: `bootstrap.ts` also clears its pending `setTimeout`
 * on shutdown, but Next's `register()` has no teardown counterpart and the
 * process is killed rather than drained, so the timer is only ever `unref`'d.
 */
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

  // The worker never has to be awaited: a batch is synchronous, so a full
  // batch costs a stall rather than a promise, and a throw is caught here
  // instead of surfacing as an unhandled rejection.
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

  // Self-scheduling rather than a fixed tick: a recipe-change rebuild drains
  // the whole corpus, and a 30 s tick left entity lookups incomplete for ~100
  // minutes over 10k memories.
  const schedule = (delayMs: number): void => {
    const timer = setTimeout(() => {
      tick(false);
      schedule(nextDelay());
    }, delayMs);
    timer.unref?.();
  };

  // Matches the server's immediate forced first pass: whatever a prior run left
  // unscanned — and whatever the reset above just wiped — is picked up now.
  tick(true);
  schedule(nextDelay());

  const fallbackTimer = setInterval(() => tick(true), ENTITY_FALLBACK_MS);
  fallbackTimer.unref?.();

  console.error(
    `[process] entity backfill worker started (idle every ${ENTITY_IDLE_DELAY_MS / 1000} s, ${ENTITY_DRAIN_DELAY_MS} ms while a backlog drains; forced hourly)`,
  );
}
