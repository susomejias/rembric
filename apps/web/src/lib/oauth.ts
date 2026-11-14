import { SUPPORTED_OAUTH_SCOPES } from '@rembric/core';

import { areqKey } from '../app/dashboard/oauth-consent/session';

import { createOAuthProvider, type OAuthProvider } from './oauth-provider';
import { createOAuthRouter, type OAuthRouter } from './oauth-router';
import { getServices } from './services';

export { rateLimitIdentity } from './oauth-rate-limit';

const OAUTH_EXACT_PATHS = new Set(['/authorize', '/token', '/register', '/revoke']);

export function isOAuthPath(pathname: string): boolean {
  return OAUTH_EXACT_PATHS.has(pathname) || pathname.startsWith('/.well-known/oauth-');
}

export function oauthIssuer(): string | null {
  const raw = process.env['REMBRIC_PUBLIC_URL'];
  if (raw === undefined || raw.length === 0) return null;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

const globalForOAuth = globalThis as typeof globalThis & {
  __rembricOAuthProvider?: OAuthProvider | null;
  __rembricOAuthRouter?: OAuthRouter | null;
};

export function getOAuthProvider(): OAuthProvider | null {
  const cached = globalForOAuth.__rembricOAuthProvider;
  if (cached !== undefined) return cached;

  const built = buildOAuthProvider();
  globalForOAuth.__rembricOAuthProvider = built;
  return built;
}

function buildOAuthProvider(): OAuthProvider | null {
  const { oauth, projects } = getServices();
  const issuer = oauthIssuer();
  const key = areqKey();
  if (oauth === null || issuer === null || key === null) return null;
  return createOAuthProvider({ oauth, projects, issuer, areqKey: key });
}

function getOAuthRouter(): OAuthRouter | null {
  const cached = globalForOAuth.__rembricOAuthRouter;
  if (cached !== undefined) return cached;

  const built = buildOAuthRouter(getOAuthProvider(), oauthIssuer());
  globalForOAuth.__rembricOAuthRouter = built;
  return built;
}

function buildOAuthRouter(
  provider: OAuthProvider | null,
  issuer: string | null,
): OAuthRouter | null {
  if (provider === null || issuer === null) return null;
  try {
    return createOAuthRouter({
      provider,
      issuerUrl: new URL(issuer),
      scopesSupported: [...SUPPORTED_OAUTH_SCOPES],
      resourceName: 'Rembric',
    });
  } catch (err) {
    console.error('[oauth] refusing to serve a misconfigured authorization server', err);
    return null;
  }
}

export async function handleOAuthRequest(request: Request, pathname: string): Promise<Response> {
  const router = getOAuthRouter();
  if (router === null) return notFoundResponse(pathname);

  let response;
  try {
    response = await router.handle(request);
  } catch (err) {
    console.error('[oauth] authorization-server request failed', err);
    return Response.json({ ok: false, code: 'internal_error' }, { status: 500 });
  }
  return response ?? notFoundResponse(pathname);
}

function notFoundResponse(path: string): Response {
  return Response.json({ ok: false, code: 'not_found', path }, { status: 404 });
}
