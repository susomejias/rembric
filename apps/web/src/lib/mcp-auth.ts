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

/**
 * Bearer authentication for the MCP HTTP surface.
 *
 * The gate is SDK v2's `verifyBearerToken`: the SDK owns the `Authorization`
 * header syntax, the `WWW-Authenticate` challenge (RFC 6750 / RFC 9728) and the
 * status mapping, and this module supplies the one thing it cannot know — who
 * Rembric's tokens are — through the `OAuthTokenVerifier` adapter below. That
 * adapter is a thin shell over the same *services* the `/api` surface resolves
 * through (`TokensService` first, `OAuthService.authenticateAccessToken` as the
 * fallback), so both surfaces agree on who a secret is and on which one wins.
 *
 * `verifyBearerToken` hands the verifier nothing but the raw secret, so the URL
 * path slug cannot travel through it. The verifier is therefore built per
 * request and closes over the slug, and the resolved `RequestContext` is
 * returned alongside the `AuthInfo` for the route to install with
 * `runWithContext` — the tools read it from there, never from `AuthInfo`.
 *
 * ## Why the resolution is not delegated to `lib/auth.ts::authenticate`
 *
 * It was, and the OAuth path could not work: `lib/auth.ts` discriminates its
 * failures with `err instanceof DomainError` / `err instanceof AuthError`, and
 * the production bundle carries **two** copies of `@rembric/core` in two
 * chunks (measured: `name="DomainError"` is defined once in
 * `.next/server/chunks/_15ofch3._.js` AND once in `_1x4esjj._.js`, each also
 * holding `TokensService`/`MemoryService`). A class from one copy never matches
 * `instanceof` the other, so `TokensService.authenticate`'s `DomainError` is
 * rethrown unclassified, the OAuth fallback below it is never reached, and the
 * raw error escapes as a 500 — which is what a bogus bearer still does on
 * `/api` today (control: `POST /api/default/memory/recall` with
 * `Bearer not-a-real-token` → 500 `internal_error`, log
 * `DomainError: token not recognized`).
 *
 * So this module discriminates on the `code` **string**, which survives
 * bundling, and resolves the token itself. The root fix is a bundle-level one
 * (stop duplicating `@rembric/core`, or drop `instanceof` there); until it
 * lands, `lib/auth.ts` stays the convergence target and this is its documented
 * divergence.
 */

/**
 * `AuthInfo.expiresAt` is mandatory in the v2 gate: `verifyBearerToken` refuses
 * a token whose expiry is unset ("Token has no expiration time"). A Rembric
 * static token with `tokens.expires_at IS NULL` never expires — a documented,
 * deliberate state — so it is reported as expiring at the end of the century
 * rather than being refused. OAuth access tokens always carry a real expiry and
 * are reported verbatim.
 */
const NO_EXPIRY_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

export type McpAuthOutcome =
  | { ok: true; authInfo: AuthInfo; requestContext: RequestContext }
  | { ok: false; response: Response };

/**
 * Authenticate one `/mcp` request.
 *
 * `identity` is the pre-auth lockout key (see the route's `clientIdentity`), and
 * the lockout is consulted BEFORE the token lookup and before the SDK gate, so
 * a flood of bogus bearers cannot spend the single Node thread hashing secrets.
 */
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

  // `project_archived` is a domain refusal (403), not an authentication
  // failure: the v2 gate can only answer 401/403 as an OAuth error object, so
  // the refusal is captured here and answered verbatim in the caller's own shape.
  let domainRefusal: Response | null = null;
  let requestContext: RequestContext | null = null;

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const resolved = await resolveGrant(token, services);
      if (resolved === null) {
        return fail(new OAuthError(OAuthErrorCode.InvalidToken, 'token not recognized'));
      }

      // Resolved only after the secret is accepted, exactly as `lib/auth.ts`
      // does: an unauthenticated caller must not be able to probe which slugs
      // exist and are archived.
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
        // The transport's session id is the route's to read off the request;
        // it is not a credential.
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

/**
 * Resolve a bearer secret to a token + scope, and count the failure against the
 * lockout. The static `tokens` table is consulted first; only a genuine no-match
 * falls through to the OAuth access-token lookup. A static revoked or expired
 * token is a definitive match and is NOT retried against OAuth — the precedence
 * `lib/auth.ts::resolveToken` documents and this module must not change.
 */
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
    // `token_not_found`/`token_invalid` is a genuine no-match and falls through
    // to OAuth; anything else is a fault Rembric did not anticipate and must
    // not be laundered into a 401.
    if (code !== 'token_not_found' && code !== 'token_invalid') throw err;
  }

  const grant = services.oauth?.authenticateAccessToken(plaintext) ?? null;
  if (grant === null) return null;
  return {
    token: syntheticOAuthToken(grant.clientId, grant.scope, grant.projectId),
    scope: grant.scope,
    // An OAuth grant is bound to the one project it was consented for (RFC 8707
    // `resource` is a single URL), and `oauth:<clientId>` is no `tokens` row, so
    // there is no membership to read.
    memberProjectIds: [],
  };
}

/**
 * Throw the refusal the SDK gate turns into a 401 challenge. Typed `never` so a
 * `return fail(...)` reads as the early exit it is.
 */
function fail(error: OAuthError): never {
  throw error;
}

/**
 * A `DomainError`'s `code`, read structurally so it survives a duplicated class
 * (see the module docs). Deliberately not an `instanceof` test.
 */
function errorCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * A `Token`-shaped value for an OAuth-authenticated connection. Keyed on the
 * client id (stable across refresh rotations and per-connector — DCR runs once
 * per connector instance) so session ownership, the `SessionRouter` key and
 * rate-limit bucketing stay continuous. The `hash` is never read after
 * authentication.
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

/**
 * The RFC 9728 protected-resource metadata URL advertised on a 401, so an OAuth
 * client can discover the authorization server. Emitted only when OAuth is
 * enabled (i.e. `REMBRIC_PUBLIC_URL` is set — the same gate `lib/services.ts`
 * builds `OAuthService` behind).
 */
function protectedResourceMetadataUrl(services: Services): string | undefined {
  const issuer = process.env['REMBRIC_PUBLIC_URL'];
  if (services.oauth === null || issuer === undefined || issuer.length === 0) return undefined;
  try {
    return getOAuthProtectedResourceMetadataUrl(new URL(issuer));
  } catch {
    return undefined;
  }
}
