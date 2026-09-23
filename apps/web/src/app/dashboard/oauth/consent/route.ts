import { grantedOAuthScope, verifyAuthRequest } from '@rembric/core';
import { NextResponse, type NextRequest } from 'next/server';

import { relativeRedirect } from '../../../../lib/http-redirect';
import { getServices } from '../../../../lib/services';
import { resolveDashboardSession } from '../../../../lib/session';
import { areqKey, CONSENT_FORM } from '../../oauth-consent/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): NextResponse {
  return relativeRedirect(`/dashboard/oauth-consent${request.nextUrl.search}`, request);
}

export async function POST(request: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
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

function csrfRejection(): NextResponse {
  return NextResponse.json({ ok: false, code: 'csrf_invalid' }, { status: 403 });
}

function invalidRedirect(): NextResponse {
  return NextResponse.json(
    { ok: false, code: 'invalid_request' },
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function redirectTo(url: string): NextResponse {
  return NextResponse.redirect(url, 302);
}

function strField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

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
