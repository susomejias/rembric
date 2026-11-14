import { createHash, timingSafeEqual } from 'node:crypto';

import {
  buildOAuthProtectedResourceMetadata,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  type AuthMetadataOptions,
  type OAuthClientInformationFull,
  type OAuthMetadata,
} from '@modelcontextprotocol/server';

import {
  corsPreflight,
  jsonReply,
  oauthErrorReply,
  queryParams,
  readBody,
  redirectReply,
  refuseMethod,
  toResponse,
  type OAuthReply,
  type ReplyHeaders,
} from './oauth-http';
import type { OAuthProvider } from './oauth-provider';
import { createRateLimiter, rateLimitIdentity, type RateLimiter } from './oauth-rate-limit';
import {
  AuthorizationCodeGrantSchema,
  ClientAuthenticatedRequestSchema,
  ClientAuthorizationParamsSchema,
  OAuthClientMetadataSchema,
  OAuthTokenRevocationRequestSchema,
  RefreshTokenGrantSchema,
  RequestAuthorizationParamsSchema,
  TokenRequestSchema,
} from './oauth-schemas';

export interface OAuthRouterOptions {
  provider: OAuthProvider;
  issuerUrl: URL;
  scopesSupported: string[];
  resourceName: string;
}

export interface OAuthRouter {
  handle(request: Request): Promise<Response | null>;
}

type Serve = (request: Request) => Promise<OAuthReply>;

const MINUTE_MS = 60 * 1000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createOAuthRouter(options: OAuthRouterOptions): OAuthRouter {
  const { provider, issuerUrl } = options;

  const endpoint = (path: string): URL => new URL(path, issuerUrl);
  const asMetadata: OAuthMetadata = {
    issuer: issuerUrl.href,
    authorization_endpoint: endpoint('/authorize').href,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint: endpoint('/token').href,
    token_endpoint_auth_methods_supported: ['none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: options.scopesSupported,
    revocation_endpoint: endpoint('/revoke').href,
    revocation_endpoint_auth_methods_supported: ['none'],
    registration_endpoint: endpoint('/register').href,
  };
  const metadata: AuthMetadataOptions = {
    oauthMetadata: asMetadata,
    resourceServerUrl: new URL(asMetadata.issuer),
    scopesSupported: options.scopesSupported,
    resourceName: options.resourceName,
    dangerouslyAllowInsecureIssuerUrl: ['true', '1'].includes(
      process.env['MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL'] ?? '',
    ),
  };
  buildOAuthProtectedResourceMetadata(metadata);

  const limiters = {
    authorize: createRateLimiter({
      windowMs: 15 * MINUTE_MS,
      limit: 100,
      message: 'You have exceeded the rate limit for authorization requests',
    }),
    token: createRateLimiter({
      windowMs: 15 * MINUTE_MS,
      limit: 50,
      message: 'You have exceeded the rate limit for token requests',
    }),
    register: createRateLimiter({
      windowMs: 60 * MINUTE_MS,
      limit: 20,
      message: 'You have exceeded the rate limit for client registration requests',
    }),
    revoke: createRateLimiter({
      windowMs: 15 * MINUTE_MS,
      limit: 50,
      message: 'You have exceeded the rate limit for token revocation requests',
    }),
  };

  const routes = new Map<string, Serve>([
    ['/authorize', (request) => serveAuthorize(provider, limiters.authorize, request)],
    ['/token', (request) => serveToken(provider, limiters.token, request)],
    ['/register', (request) => serveRegister(provider, limiters.register, request)],
    ['/revoke', (request) => serveRevoke(provider, limiters.revoke, request)],
  ]);

  return {
    async handle(request) {
      const document = oauthMetadataResponse(request, metadata);
      if (document !== undefined) return document;
      const serve = routes.get(new URL(request.url).pathname);
      return serve === undefined ? null : toResponse(request, await serve(request));
    },
  };
}

async function serveAuthorize(
  provider: OAuthProvider,
  limiter: RateLimiter,
  request: Request,
): Promise<OAuthReply> {
  const headers: ReplyHeaders = new Map();
  const refused = refuseMethod(request, headers, ['GET', 'POST']);
  if (refused !== null) return refused;
  const body = await readBody(request, 'form');
  const limited = await limiter.consume(rateLimitIdentity(request), headers);
  if (limited !== null) return limited;

  headers.set('cache-control', 'no-store');
  const params = request.method === 'POST' ? body : queryParams(new URL(request.url));

  let client: OAuthClientInformationFull;
  let redirectUri: string;
  try {
    const result = ClientAuthorizationParamsSchema.safeParse(params);
    if (!result.success) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, result.error.message);
    }
    const found = provider.clientsStore.getClient(result.data.client_id);
    if (!found) throw new OAuthError(OAuthErrorCode.InvalidClient, 'Invalid client_id');
    client = found;
    redirectUri = resolveRedirectUri(result.data.redirect_uri, client.redirect_uris);
  } catch (err) {
    return oauthErrorReply(headers, err);
  }

  let state: string | undefined;
  try {
    const result = RequestAuthorizationParamsSchema.safeParse(params);
    if (!result.success) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, result.error.message);
    }
    const { scope, code_challenge, resource } = result.data;
    state = result.data.state;
    const location = provider.authorize(client, {
      state,
      scopes: scope === undefined ? [] : scope.split(' '),
      redirectUri,
      codeChallenge: code_challenge,
      resource: resource ? new URL(resource) : undefined,
    });
    return redirectReply(headers, location);
  } catch (err) {
    const error = OAuthError.isInstance(err)
      ? err
      : new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
    return redirectReply(headers, errorRedirect(redirectUri, error, state));
  }
}

function resolveRedirectUri(requested: string | undefined, registered: string[]): string {
  if (requested !== undefined) {
    if (!registered.some((uri) => redirectUriMatches(requested, uri))) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Unregistered redirect_uri');
    }
    return requested;
  }
  const [only] = registered;
  if (registered.length === 1 && only !== undefined) return only;
  throw new OAuthError(
    OAuthErrorCode.InvalidRequest,
    'redirect_uri must be specified when client has multiple registered URIs',
  );
}

export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search
  );
}

function errorRedirect(redirectUri: string, error: OAuthError, state: string | undefined): string {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error.code);
  target.searchParams.set('error_description', error.message);
  if (error.errorUri) target.searchParams.set('error_uri', error.errorUri);
  if (state) target.searchParams.set('state', state);
  return target.href;
}

type ClientAuthentication =
  | { client: OAuthClientInformationFull; refusal?: never }
  | { client?: never; refusal: OAuthReply };

function authenticateClient(
  provider: OAuthProvider,
  body: unknown,
  headers: ReplyHeaders,
): ClientAuthentication {
  try {
    const result = ClientAuthenticatedRequestSchema.safeParse(body);
    if (!result.success) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, String(result.error));
    }
    const client = provider.clientsStore.getClient(result.data.client_id);
    if (!client) throw new OAuthError(OAuthErrorCode.InvalidClient, 'Invalid client_id');
    return { client };
  } catch (err) {
    return { refusal: oauthErrorReply(headers, err) };
  }
}

export function pkceVerifierMatches(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function serveToken(
  provider: OAuthProvider,
  limiter: RateLimiter,
  request: Request,
): Promise<OAuthReply> {
  const headers: ReplyHeaders = new Map();
  const preflight = corsPreflight(request, headers);
  if (preflight !== null) return preflight;
  const refused = refuseMethod(request, headers, ['POST']);
  if (refused !== null) return refused;
  const body = await readBody(request, 'form');
  const limited = await limiter.consume(rateLimitIdentity(request), headers);
  if (limited !== null) return limited;
  const { client, refusal } = authenticateClient(provider, body, headers);
  if (refusal !== undefined) return refusal;

  headers.set('cache-control', 'no-store');
  try {
    const parsed = TokenRequestSchema.safeParse(body);
    if (!parsed.success) throw new OAuthError(OAuthErrorCode.InvalidRequest, parsed.error.message);
    switch (parsed.data.grant_type) {
      case 'authorization_code': {
        const grant = AuthorizationCodeGrantSchema.safeParse(body);
        if (!grant.success) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, grant.error.message);
        }
        const { code, code_verifier, redirect_uri } = grant.data;
        const challenge = provider.challengeForAuthorizationCode(client, code);
        if (!pkceVerifierMatches(code_verifier, challenge)) {
          throw new OAuthError(
            OAuthErrorCode.InvalidGrant,
            'code_verifier does not match the challenge',
          );
        }
        const tokens = provider.exchangeAuthorizationCode(client, code, redirect_uri);
        return jsonReply(200, headers, tokens);
      }
      case 'refresh_token': {
        const grant = RefreshTokenGrantSchema.safeParse(body);
        if (!grant.success) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, grant.error.message);
        }
        const tokens = provider.exchangeRefreshToken(client, grant.data.refresh_token);
        return jsonReply(200, headers, tokens);
      }
      default:
        throw new OAuthError(
          OAuthErrorCode.UnsupportedGrantType,
          'The grant type is not supported by this authorization server.',
        );
    }
  } catch (err) {
    return oauthErrorReply(headers, err);
  }
}

async function serveRegister(
  provider: OAuthProvider,
  limiter: RateLimiter,
  request: Request,
): Promise<OAuthReply> {
  const headers: ReplyHeaders = new Map();
  const preflight = corsPreflight(request, headers);
  if (preflight !== null) return preflight;
  const refused = refuseMethod(request, headers, ['POST']);
  if (refused !== null) return refused;
  const body = await readBody(request, 'json');
  const limited = await limiter.consume(rateLimitIdentity(request), headers);
  if (limited !== null) return limited;

  headers.set('cache-control', 'no-store');
  try {
    const parsed = OAuthClientMetadataSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, parsed.error.message);
    }
    return jsonReply(201, headers, provider.clientsStore.registerClient(parsed.data));
  } catch (err) {
    return oauthErrorReply(headers, err);
  }
}

async function serveRevoke(
  provider: OAuthProvider,
  limiter: RateLimiter,
  request: Request,
): Promise<OAuthReply> {
  const headers: ReplyHeaders = new Map();
  const preflight = corsPreflight(request, headers);
  if (preflight !== null) return preflight;
  const refused = refuseMethod(request, headers, ['POST']);
  if (refused !== null) return refused;
  const body = await readBody(request, 'form');
  const limited = await limiter.consume(rateLimitIdentity(request), headers);
  if (limited !== null) return limited;
  const { client, refusal } = authenticateClient(provider, body, headers);
  if (refusal !== undefined) return refusal;

  headers.set('cache-control', 'no-store');
  try {
    const parsed = OAuthTokenRevocationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, parsed.error.message);
    }
    provider.revokeToken(client, parsed.data);
    return jsonReply(200, headers, {});
  } catch (err) {
    return oauthErrorReply(headers, err);
  }
}
