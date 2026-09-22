import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { RequestContext, ResolvedToken, TokenScope } from '@rembric/core';
import { type Token } from '@rembric/db';

import type { Services } from './services';

const NO_EXPIRY_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

export type McpAuthOutcome =
  | { ok: true; authInfo: AuthInfo; requestContext: RequestContext }
  | { ok: false; response: Response };

export async function verifyMcpBearerToken(input: {
  authorization: string | null;
  slug: string | null;
  identity: string;
  services: Services;
}): Promise<McpAuthOutcome> {
  const { authorization, slug, identity, services } = input;
  const lockout = services.authLockout;

  const locked = lockout.check(identity);
  if (locked.locked) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, code: 'rate_limited', message: 'too many failed authentication attempts' },
        { status: 429, headers: { 'Retry-After': String(locked.retryAfterSeconds) } },
      ),
    };
  }

  const resourceMetadataUrl = protectedResourceMetadataUrl(services);

  let domainRefusal: Response | null = null;
  let requestContext: RequestContext | null = null;

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const resolved = await resolveGrant(token, services);
      if (resolved === null) {
        return fail(new OAuthError(OAuthErrorCode.InvalidToken, 'token not recognized'));
      }

      const project = slug === null ? null : (services.projects.findBySlug(slug) ?? null);
      if (project?.archivedAt) {
        domainRefusal = Response.json(
          {
            ok: false,
            code: 'project_archived',
            message: `project '${project.slug}' is archived; new writes are rejected`,
          },
          { status: 403 },
        );
        return fail(
          new OAuthError(
            OAuthErrorCode.InvalidToken,
            `project '${project.slug}' is archived; new writes are rejected`,
          ),
        );
      }

      lockout.recordSuccess(identity);
      requestContext = {
        token: resolved.token,
        scope: resolved.scope,
        memberProjectIds: resolved.memberProjectIds,
        project,
        requestedSlug: slug,
        mcpSessionId: null,
      };
      return {
        token,
        clientId: resolved.token.id,
        scopes: [resolved.scope],
        expiresAt:
          resolved.token.expiresAt === null
            ? NO_EXPIRY_EPOCH_SECONDS
            : Math.floor(resolved.token.expiresAt.getTime() / 1000),
      };
    },
  };

  let authInfo: AuthInfo;
  try {
    authInfo = await verifyBearerToken(authorization, { verifier, resourceMetadataUrl });
  } catch (err) {
    if (domainRefusal !== null) return { ok: false, response: domainRefusal };
    return { ok: false, response: bearerAuthChallengeResponse(err, { resourceMetadataUrl }) };
  }

  if (requestContext === null) {
    throw new Error('bearer verification completed without resolving a request context');
  }
  return { ok: true, authInfo, requestContext };
}

async function resolveGrant(plaintext: string, services: Services): Promise<ResolvedToken | null> {
  try {
    return await services.tokens.authenticate(plaintext);
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'token_revoked') {
      return fail(new OAuthError(OAuthErrorCode.InvalidToken, 'token has been revoked'));
    }
    if (code === 'token_expired') {
      return fail(new OAuthError(OAuthErrorCode.InvalidToken, 'token has expired'));
    }
    if (code !== 'token_not_found' && code !== 'token_invalid') throw err;
  }

  const grant = services.oauth?.authenticateAccessToken(plaintext) ?? null;
  if (grant === null) return null;
  return {
    token: syntheticOAuthToken(grant.clientId, grant.scope, grant.projectId),
    scope: grant.scope,
    memberProjectIds: [],
  };
}

function fail(error: OAuthError): never {
  throw error;
}

function errorCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function syntheticOAuthToken(clientId: string, scope: TokenScope, projectId: string | null): Token {
  return {
    id: `oauth:${clientId}`,
    name: `oauth:${clientId}`,
    hash: '',
    scope,
    projectId,
    createdAt: new Date(0),
    expiresAt: null,
    revokedAt: null,
  };
}

function protectedResourceMetadataUrl(services: Services): string | undefined {
  const issuer = process.env['REMBRIC_PUBLIC_URL'];
  if (services.oauth === null || issuer === undefined || issuer.length === 0) return undefined;
  try {
    return getOAuthProtectedResourceMetadataUrl(new URL(issuer));
  } catch {
    return undefined;
  }
}
