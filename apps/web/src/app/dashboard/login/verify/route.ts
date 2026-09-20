import { NextResponse, type NextRequest } from 'next/server';

import { safeNext, type LoginErrorCode } from '../clients';

import { isDomainError } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { createSessionCookie } from '@/lib/session';

/**
 * The token sign-in — `dashboard-router.ts`'s `POST /dashboard/login`, as a
 * route handler.
 *
 * Why this lives one segment down (`/dashboard/login/verify`) instead of beside
 * the page: the App Router refuses `page.tsx` and `route.ts` in the same
 * segment. Measured, not assumed — with the handler at `login/route.ts` the dev
 * server answered every `/dashboard/login` request with a 500 whose payload was
 * `Conflicting route and page at /dashboard/login: route at
 * /dashboard/login/route and page at /dashboard/login/page`. `middleware.ts`
 * therefore forwards an incoming `POST /dashboard/login` to this path with
 * `NextResponse.rewrite`, which keeps the public URL — the one the retired form
 * posts to, and the one the dashboard spec names — byte-identical while the
 * handler sits where the framework allows it.
 *
 * The token is validated by the same call the retired handler made
 * (`tokens.authenticate`) and refused by the same rule: only `scope === '*'`
 * opens the dashboard, and a valid-but-non-admin token earns the *same* answer
 * as an invalid one so the endpoint is not a token-validity oracle. The
 * `DomainError` check goes through `isDomainError`'s shape test rather than
 * `instanceof`, because Turbopack hands the service and this module two class
 * identities for `@rembric/core` (see `lib/auth.ts`).
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  const services = getServices();
  const form = await readForm(request);
  const tokenPlain = stringField(form.get('token'));
  const next = safeNext(stringField(form.get('next')));

  // Same pre-auth lockout as the retired handler, keyed on the closest thing a
  // route handler has to `getConnInfo(c).remote.address` — see `networkIdentity`.
  const identity = networkIdentity(request);
  const locked = services.authLockout.check(identity);
  if (locked.locked) return backToLogin(request, 'locked', next);

  if (tokenPlain.length === 0) return backToLogin(request, 'missing', next);

  let resolved: Awaited<ReturnType<typeof services.tokens.authenticate>>;
  try {
    resolved = await services.tokens.authenticate(tokenPlain);
  } catch (err) {
    if (!isDomainError(err)) throw err;
    services.authLockout.recordFailure(identity);
    return backToLogin(request, 'invalid', next);
  }

  // A valid-but-non-admin token gets the SAME response as an invalid one,
  // so the endpoint is not a token-validity oracle.
  if (resolved.scope !== '*') {
    services.authLockout.recordFailure(identity);
    return backToLogin(request, 'invalid', next);
  }
  services.authLockout.recordSuccess(identity);

  const cookie = createSessionCookie(resolved.token.id);
  if (cookie === null) return backToLogin(request, 'unavailable', next);

  // 302, not the 307 `NextResponse.redirect` defaults to: the browser must
  // follow up with a GET, not a second POST of the token.
  const response = NextResponse.redirect(new URL(next ?? '/dashboard', request.url), 302);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

/**
 * The form body, or an empty one. A body that is not `multipart/form-data` or
 * `application/x-www-form-urlencoded` (a stray JSON POST, say) makes
 * `request.formData()` throw; carrying no token is the accurate reading of that,
 * and it is the same answer the missing-field path gives.
 */
async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/** A submitted field as a string. A `File` in that slot is not a token. */
function stringField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The failure response: back to the login page carrying the reason, and the
 * requested destination when the consent hand-off supplied one, so the form can
 * be resubmitted with both intact.
 */
function backToLogin(
  request: NextRequest,
  code: LoginErrorCode,
  next: string | null,
): NextResponse {
  const url = new URL('/dashboard/login', request.url);
  url.searchParams.set('error', code);
  if (next !== null) url.searchParams.set('next', next);
  return NextResponse.redirect(url, 302);
}

/**
 * Pre-auth identity for the lockout. `apps/server` reads
 * `getConnInfo(c).remote.address`; a Next route handler cannot reach the socket,
 * so the first `x-forwarded-for` hop is the substitute — the same one
 * `lib/api.ts::networkIdentity` uses for the `/api` paths. Absent on a direct
 * loopback request, so those share the `'unknown'` bucket rather than one bucket
 * per client.
 */
function networkIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
