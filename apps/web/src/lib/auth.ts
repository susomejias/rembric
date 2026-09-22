import type { DomainError, OAuthService } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { RequestContext } from '@rembric/core';
import type { ResolvedToken, TokenScope, TokensService } from '@rembric/core';
import { type Token } from '@rembric/db';

export type AuthErrorCode =
  | 'missing_token'
  | 'malformed_authorization'
  | 'token_invalid'
  | 'token_revoked'
  | 'token_expired'
  | 'project_archived';

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status: 401 | 403,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return (
    err instanceof Error &&
    err.name === 'DomainError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

const BEARER_PREFIX = 'bearer ';

export async function authenticate(input: {
  authorization: string | undefined;
  pathSlug: string | undefined;
  tokens: TokensService;
  projects: ProjectsService;
  oauth?: OAuthService | null;
}): Promise<RequestContext> {
  const { authorization, pathSlug, tokens, projects, oauth } = input;

  if (!authorization) {
    throw new AuthError('missing_token', 'missing Authorization header', 401);
  }
  if (authorization.toLowerCase().slice(0, BEARER_PREFIX.length) !== BEARER_PREFIX) {
    throw new AuthError('malformed_authorization', 'expected "Bearer <token>"', 401);
  }
  const plaintext = authorization.slice(BEARER_PREFIX.length).trim();
  if (plaintext.length === 0) {
    throw new AuthError('malformed_authorization', 'empty bearer token', 401);
  }

  const resolved = await resolveToken(plaintext, tokens, oauth ?? null);

  const project = pathSlug && pathSlug.length > 0 ? (projects.findBySlug(pathSlug) ?? null) : null;

  if (project?.archivedAt) {
    throw new AuthError(
      'project_archived',
      `project '${project.slug}' is archived; new writes are rejected`,
      403,
    );
  }

  return {
    token: resolved.token,
    scope: resolved.scope,
    memberProjectIds: resolved.memberProjectIds,
    project,
    requestedSlug: pathSlug && pathSlug.length > 0 ? pathSlug : null,
    mcpSessionId: null,
  };
}

async function resolveToken(
  plaintext: string,
  tokens: TokensService,
  oauth: OAuthService | null,
): Promise<ResolvedToken> {
  try {
    return await tokens.authenticate(plaintext);
  } catch (err) {
    if (!isDomainError(err)) throw err;
    if (err.code === 'token_revoked') {
      throw new AuthError('token_revoked', 'token has been revoked', 401);
    }
    if (err.code === 'token_expired') {
      throw new AuthError('token_expired', 'token has expired', 401);
    }
    if (oauth) {
      const oa = oauth.authenticateAccessToken(plaintext);
      if (oa) {
        return {
          token: syntheticOAuthToken(oa.clientId, oa.scope, oa.projectId),
          scope: oa.scope,
          memberProjectIds: [],
        };
      }
    }
    throw new AuthError('token_invalid', 'token not recognized', 401);
  }
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
