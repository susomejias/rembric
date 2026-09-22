import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AccessDeniedError,
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
  ServerError,
  UnsupportedGrantTypeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  OAuthError,
  signAuthRequest,
  type AuthRequest,
  type OAuthService,
  type ProjectsService,
  type TokenPair,
} from '@rembric/core';

export interface OAuthProviderOptions {
  oauth: OAuthService;
  projects: ProjectsService;
  issuer: string;
  areqKey: Buffer;
  consentTtlSeconds?: number;
  now?: () => Date;
}

const CONSENT_PATH = '/dashboard/oauth/consent';
const SLUG_RE = /^[a-zA-Z0-9_.-]+$/;

function projectIdFromResource(
  resource: URL | undefined,
  projects: ProjectsService,
): string | null {
  if (!resource) return null;
  const path = resource.pathname.replace(/\/+$/, '');
  if (!path.startsWith('/mcp/')) return null;
  const slug = path.slice('/mcp/'.length).split('/')[0];
  if (!slug || slug.length > 128 || !SLUG_RE.test(slug)) return null;
  return projects.findBySlug(slug)?.id ?? null;
}

export function createOAuthProvider(opts: OAuthProviderOptions): OAuthServerProvider {
  const { oauth, projects, issuer, areqKey } = opts;
  const now = opts.now ?? (() => new Date());
  const consentTtl = opts.consentTtlSeconds ?? 600;

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient(clientId) {
      const client = oauth.findClient(clientId);
      return client
        ? toClientInfo(client.clientId, oauth.redirectUrisFor(client), client.clientName)
        : undefined;
    },
    registerClient(client) {
      const created = oauth.registerClient({
        clientName: client.client_name ?? null,
        redirectUris: client.redirect_uris,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method,
      });
      return toClientInfo(created.clientId, oauth.redirectUrisFor(created), created.clientName);
    },
  };

  return {
    get clientsStore() {
      return clientsStore;
    },

    authorize(client, params, res): Promise<void> {
      const req: AuthRequest = {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scope: (params.scopes ?? []).join(' '),
        state: params.state,
        projectId: projectIdFromResource(params.resource, projects),
        exp: Math.floor(now().getTime() / 1000) + consentTtl,
      };
      const blob = signAuthRequest(req, areqKey);
      res.redirect(302, `${issuer}${CONSENT_PATH}?areq=${encodeURIComponent(blob)}`);
      return Promise.resolve();
    },

    challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      return settled(() => oauth.challengeForCode(authorizationCode));
    },

    exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string,
    ): Promise<OAuthTokens> {
      return settled(() =>
        toOAuthTokens(
          oauth.redeemCode({ code: authorizationCode, clientId: client.client_id, redirectUri }),
        ),
      );
    },

    exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
    ): Promise<OAuthTokens> {
      return settled(() =>
        toOAuthTokens(oauth.refresh({ refreshToken, clientId: client.client_id })),
      );
    },

    verifyAccessToken(token: string): Promise<AuthInfo> {
      const resolved = oauth.authenticateAccessToken(token);
      if (!resolved) {
        return Promise.reject(new InvalidTokenError('access token is invalid or expired'));
      }
      return Promise.resolve({
        token,
        clientId: resolved.clientId,
        scopes: [resolved.scope],
        expiresAt: resolved.expiresAtSeconds,
      });
    },

    revokeToken(
      client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      oauth.revokeByToken(request.token, client.client_id);
      return Promise.resolve();
    },
  };
}

function settled<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(toSdkError(err));
  }
}

function toClientInfo(
  clientId: string,
  redirectUris: string[],
  clientName: string | null,
): OAuthClientInformationFull {
  return {
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: clientName ?? undefined,
  };
}

function toOAuthTokens(pair: TokenPair): OAuthTokens {
  return {
    access_token: pair.accessToken,
    token_type: 'Bearer',
    expires_in: pair.expiresInSeconds,
    refresh_token: pair.refreshToken,
    scope: pair.scope,
  };
}

function toSdkError(err: unknown): Error {
  if (err instanceof OAuthError) {
    switch (err.code) {
      case 'invalid_request':
        return new InvalidRequestError(err.message);
      case 'invalid_client':
        return new InvalidClientError(err.message);
      case 'invalid_grant':
        return new InvalidGrantError(err.message);
      case 'invalid_scope':
        return new InvalidScopeError(err.message);
      case 'unsupported_grant_type':
        return new UnsupportedGrantTypeError(err.message);
      case 'access_denied':
        return new AccessDeniedError(err.message);
    }
  }
  return new ServerError(err instanceof Error ? err.message : 'internal error');
}
