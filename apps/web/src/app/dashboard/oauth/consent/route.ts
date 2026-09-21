import { grantedOAuthScope, verifyAuthRequest } from '@rembric/core';
import { NextResponse, type NextRequest } from 'next/server';

import { getServices } from '../../../../lib/services';
import { resolveDashboardSession } from '../../../../lib/session';
import { areqKey, CONSENT_FORM } from '../../oauth-consent/session';

/**
 * The OAuth authorization endpoint's consent half — the exact path
 * `provider.authorize` redirects to (`CONSENT_PATH` in
 * `apps/server/src/server/oauth-provider.ts`), and the form target the consent
 * card posts its decision to.
 *
 * GET delegates to the dashboard-hosted consent page at
 * `/dashboard/oauth-consent` with a same-origin 302, preserving `?areq=`. A
 * Route Handler cannot return JSX, cannot `NextResponse.rewrite` (Next throws
 * on it in an app route handler), and a standalone `renderToStaticMarkup`
 * document would drop the app's stylesheet — so the styled, shared card is
 * served by the page, and this handler owns only the protocol POST.
 *
 * POST is `apps/server/src/dashboard/oauth-consent.ts`'s handler, unchanged in
 * ordering: the session is resolved and the CSRF token verified first (403
 * before anything else is read, exactly as `readFormAndVerifyCsrf` did), then
 * the signed `areq` is verified (400 when invalid or expired), then a non-approve
 * decision redirects `access_denied` back to the client, and an approval mints
 * the code and redirects it with the state. Nothing here logs a secret.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): NextResponse {
  const target = new URL(`/dashboard/oauth-consent${request.nextUrl.search}`, request.url);
  // 302, not `NextResponse.redirect`'s 307 default: the operator follows it with
  // a GET, and a 307 would preserve the method for no reason.
  return NextResponse.redirect(target, 302);
}

export async function POST(request: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // An unparseable body carries no token, so it fails CSRF by definition.
    return csrfRejection();
  }

  const resolved = await resolveDashboardSession(request.cookies);
  const submitted = form.get('csrf');
  const candidate = typeof submitted === 'string' ? submitted : '';
  if (
    resolved === null ||
    candidate.length === 0 ||
    !resolved.sessions.verifyCsrf(resolved.session.session, CONSENT_FORM, candidate)
  ) {
    return csrfRejection();
  }

  const blob = strField(form, 'areq');
  const key = areqKey();
  const areq = key === null ? null : verifyAuthRequest(blob, key, Date.now());
  if (!areq) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request' },
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  if (strField(form, 'decision') !== 'approve') {
    const denied = buildRedirect(areq.redirectUri, { error: 'access_denied', state: areq.state });
    return denied === null ? invalidRedirect() : redirectTo(denied);
  }

  const oauth = getServices().oauth;
  if (oauth === null) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request' },
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const code = oauth.issueCode({
    clientId: areq.clientId,
    redirectUri: areq.redirectUri,
    codeChallenge: areq.codeChallenge,
    scope: grantedOAuthScope(areq.scope),
    subject: resolved.session.tokenId,
    projectId: areq.projectId ?? null,
  });
  const granted = buildRedirect(areq.redirectUri, { code, state: areq.state });
  return granted === null ? invalidRedirect() : redirectTo(granted);
}

/** `csrf.ts`'s rejection: `{ ok: false, code: 'csrf_invalid' }` at 403. */
function csrfRejection(): NextResponse {
  return NextResponse.json({ ok: false, code: 'csrf_invalid' }, { status: 403 });
}

/**
 * A `redirect_uri` that cannot be parsed as a URL. The SDK validated it before
 * the hand-off and the blob is HMAC-signed, so this is unreachable from a
 * legitimate flow; answering 400 keeps a malformed value from reaching the
 * redirect instead of letting `new URL` throw a 500.
 */
function invalidRedirect(): NextResponse {
  return NextResponse.json(
    { ok: false, code: 'invalid_request' },
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function redirectTo(url: string): NextResponse {
  // `c.redirect()` answered 302; `NextResponse.redirect` defaults to 307.
  return NextResponse.redirect(url, 302);
}

function strField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * `oauth-consent.ts`'s `buildRedirect`: set only what the client supplied, or
 * `null` when the URI is not parseable (see `invalidRedirect`).
 */
function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.href;
}
