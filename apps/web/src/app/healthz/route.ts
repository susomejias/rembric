import { ping } from '@rembric/db';

import { AuthError, authenticate } from '../../lib/auth';
import { getServices } from '../../lib/services';
import { REMBRIC_VERSION } from '../../lib/version';

// A health probe must read the live process; a cached response would report a
// stale success forever.
export const dynamic = 'force-dynamic';

/**
 * `apps/server/src/server/http.ts::createHealthzHandler`, ported. The probe is
 * bearer-gated exactly as the server's is — same statuses, same codes, same
 * copy — because the container HEALTHCHECK (`apps/web/Dockerfile`), both compose
 * files and `install.sh`'s post-up poll all send
 * `Authorization: Bearer $REMBRIC_ADMIN_TOKEN`. An unauthenticated probe would
 * let any local process read the release identity, and made this endpoint the
 * one surface that diverged from the server's gate.
 *
 * Order matters and mirrors the server: pre-auth lockout before the token-hash
 * scan, so a bogus bearer cannot force repeated scrypt on the single thread.
 * The lockout key is the same request-derived identity `lib/api.ts` uses, so a
 * failure accrued here also counts against the `/api` surface.
 */
export async function GET(request: Request): Promise<Response> {
  const services = getServices();
  const identity = clientIdentity(request);

  const locked = services.authLockout.check(identity);
  if (locked.locked) {
    return Response.json(
      { ok: false, code: 'rate_limited', message: 'too many failed attempts' },
      { status: 429, headers: { 'Retry-After': String(locked.retryAfterSeconds) } },
    );
  }

  const authorization = request.headers.get('authorization');
  if (authorization === null) {
    return Response.json(
      { ok: false, code: 'missing_token', message: 'missing Authorization header' },
      { status: 401 },
    );
  }

  try {
    await authenticate({
      authorization,
      pathSlug: undefined,
      tokens: services.tokens,
      projects: services.projects,
      oauth: services.oauth,
    });
    services.authLockout.recordSuccess(identity);

    // Fails loudly if better-sqlite3's native binding did not load or the file
    // could not be opened — the SELECT never reaches a statement otherwise. The
    // statement itself lives in `packages/db` with every other one (data-access
    // confinement): this is `diagnostics.ts::ping`, the same call the maintenance
    // page reaches through `createDiagnostics`.
    ping(services.db);

    return Response.json({ ok: true, version: REMBRIC_VERSION });
  } catch (err) {
    if (err instanceof AuthError) {
      services.authLockout.recordFailure(identity);
      return Response.json(
        { ok: false, code: err.code, message: err.message },
        { status: err.status },
      );
    }
    // A non-auth failure here is the database: authentication already resolved
    // against it, so a throw from `ping` is the only other path. Answering 503
    // (rather than letting it bubble to Next's HTML 500) keeps the probe's
    // contract — the container reads `db_unavailable` and stays unhealthy.
    return Response.json({ ok: false, code: 'db_unavailable' }, { status: 503 });
  }
}

/**
 * Pre-auth lockout key. `apps/server` reads the socket address; a route handler
 * cannot reach it, so the first `x-forwarded-for` hop is the closest available
 * substitute and a direct request shares the `'unknown'` bucket — the same
 * decision `lib/api.ts::networkIdentity` and the `/mcp` route document.
 */
function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
