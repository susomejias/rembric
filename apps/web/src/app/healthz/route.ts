import { ping } from '@rembric/db';

import { AuthError, authenticate } from '../../lib/auth';
import { getServices } from '../../lib/services';
import { REMBRIC_VERSION } from '../../lib/version';

export const dynamic = 'force-dynamic';

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
    return Response.json({ ok: false, code: 'db_unavailable' }, { status: 503 });
  }
}

function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
