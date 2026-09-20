import { DomainError } from '@rembric/core';
import type { OAuthService } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { RequestContext } from '@rembric/core';
import type { ResolvedToken, TokenScope, TokensService } from '@rembric/core';
import { type Token } from '@rembric/db';

/**
 * Bearer authentication for the session-lifecycle HTTP API.
 *
 * Port of `apps/server/src/server/auth.ts` — same header parsing, same error
 * codes, same status codes, same ordering of the static-token lookup against
 * the OAuth access-token fallback. Duplicated rather than imported because
 * `apps/server` is not a dependency of this workspace.
 *
 * Project scope is resolved exclusively from the URL path slug. The
 * `X-Rembric-Project` header is intentionally NOT consulted.
 */

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

const BEARER_PREFIX = 'bearer ';

/**
 * Validate an `Authorization` header value and resolve the optional URL path
 * slug into a project row.
 *
 * The returned value is `@rembric/core`'s `RequestContext` — the same type
 * `apps/server`'s `authenticate` returns after the phase-4 extraction. The
 * `/api` surface never reads `mcpSessionId` (only the MCP transport establishes
 * one) so it is always `null` here, as it is for a non-MCP request there.
 *
 * A slug that does NOT exist returns `project = null` with `requestedSlug`
 * populated rather than throwing; the handler decides, exactly as the
 * Hono router's middleware/handler split does.
 */
export async function authenticate(input: {
  authorization: string | undefined;
  /** Slug from the URL path, or undefined for an un-scoped path. */
  pathSlug: string | undefined;
  tokens: TokensService;
  projects: ProjectsService;
  /** When set, OAuth-minted access tokens are accepted as a fallback. */
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

/**
 * Resolve a bearer secret to a token + scope. The static `tokens` table is
 * consulted first; only a genuine no-match falls through to the OAuth
 * access-token lookup. A static revoked/expired token is a definitive match
 * and is NOT retried against OAuth.
 */
async function resolveToken(
  plaintext: string,
  tokens: TokensService,
  oauth: OAuthService | null,
): Promise<ResolvedToken> {
  try {
    return await tokens.authenticate(plaintext);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    if (err.code === 'token_revoked') {
      throw new AuthError('token_revoked', 'token has been revoked', 401);
    }
    if (err.code === 'token_expired') {
      throw new AuthError('token_expired', 'token has expired', 401);
    }
    // token_not_found / token_invalid → try OAuth before rejecting.
    if (oauth) {
      const oa = oauth.authenticateAccessToken(plaintext);
      if (oa) {
        return {
          token: syntheticOAuthToken(oa.clientId, oa.scope, oa.projectId),
          scope: oa.scope,
          // An OAuth grant is bound to the one project it was consented for
          // (RFC 8707 `resource` is a single URL), and `oauth:<clientId>` is no
          // `tokens` row, so there is no membership to read.
          memberProjectIds: [],
        };
      }
    }
    throw new AuthError('token_invalid', 'token not recognized', 401);
  }
}

/**
 * A `Token`-shaped value for an OAuth-authenticated connection. Keyed on the
 * client id (stable across refresh rotations and per-connector) so session
 * ownership and rate-limit bucketing stay continuous. The `hash` is never read
 * after authentication.
 */
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
