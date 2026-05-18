import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import type { TokensService } from '../services/tokens.js';

import type { RequestContext } from './request-context.js';

/**
 * HTTP-agnostic authentication helpers. The MCP and dashboard layers use
 * these to convert raw header values into a `RequestContext` or to reject
 * the request with a typed `AuthError`.
 *
 * Project scope is resolved exclusively from the URL path slug
 * (`/mcp/<slug>`). The `X-Rembric-Project` header is intentionally NOT
 * consulted — it was removed in change `add-sessions-and-research-tools`
 * along with path-based project identity.
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
 * Validate an `Authorization` header value and resolve the optional URL
 * path slug into a project row. Returns the full request context.
 *
 * If the URL path carried a slug that does NOT exist, the request
 * context is returned with `project = null` and `requestedSlug` populated;
 * tool calls that require a real project SHALL respond with
 * `project_not_found`. The `initialize` handshake itself succeeds.
 */
export function authenticate(input: {
  authorization: string | undefined;
  /** Slug from the URL path `/mcp/<slug>`, or undefined for `/mcp`. */
  pathSlug: string | undefined;
  tokens: TokensService;
  projects: ProjectsService;
}): RequestContext {
  const { authorization, pathSlug, tokens, projects } = input;

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

  let resolved: ReturnType<TokensService['authenticate']>;
  try {
    resolved = tokens.authenticate(plaintext);
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === 'token_revoked') {
        throw new AuthError('token_revoked', 'token has been revoked', 401);
      }
      if (err.code === 'token_expired') {
        throw new AuthError('token_expired', 'token has expired', 401);
      }
      throw new AuthError('token_invalid', 'token not recognized', 401);
    }
    throw err;
  }

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
    project,
    requestedSlug: pathSlug && pathSlug.length > 0 ? pathSlug : null,
    mcpSessionId: null,
  };
}
