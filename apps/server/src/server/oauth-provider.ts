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
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';

import { signAuthRequest, type AuthRequest } from '../services/oauth-areq.js';
import { OAuthError, type OAuthService, type TokenPair } from '../services/oauth.js';

/**
 * Implements the MCP SDK's `OAuthServerProvider` so the vetted SDK
 * authorization server (`mcpAuthRouter`) owns the protocol surface
 * (PKCE validation, redirect/CSRF/state handling, metadata, DCR, rate
 * limiting) while our audited `OAuthService` owns persistence and logic.
 *
 * `authorize()` only receives the response object, so it cannot read the
 * operator session — it signs the SDK-validated request and redirects to the
 * dashboard consent screen (which has session + CSRF), which finishes the
 * flow by issuing a code.
 */

export interface OAuthProviderOptions {
  oauth: OAuthService;
  /** OAuth issuer / external base URL (no trailing slash). */
  issuer: string;
  /** HMAC key for signing the consent hand-off (derived from session secret). */
  areqKey: Buffer;
  /** Seconds an unconsented authorization request stays valid. */
  consentTtlSeconds?: number;
  now?: () => Date;
}

const CONSENT_PATH = '/dashboard/oauth/consent';

export function createOAuthProvider(opts: OAuthProviderOptions): OAuthServerProvider {
  const { oauth, issuer, areqKey } = opts;
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

    authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response,
    ): Promise<void> {
      const req: AuthRequest = {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scope: (params.scopes ?? []).join(' '),
        state: params.state,
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
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      oauth.revokeByToken(request.token);
      return Promise.resolve();
    },
  };
}

/**
 * Run a synchronous provider operation, mapping our `OAuthError` to the SDK's
 * error classes so the token handler renders the right 400-class response
 * (rather than a generic 500). Returns a rejected promise on failure.
 */
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
