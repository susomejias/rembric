import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from '@modelcontextprotocol/server';
import {
  signAuthRequest,
  type AuthRequest,
  type OAuthErrorCode as DomainOAuthErrorCode,
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

export interface AuthorizationParams {
  state?: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge: string;
  resource?: URL;
}

export interface OAuthClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined;
  registerClient(metadata: OAuthClientMetadata): OAuthClientInformationFull;
}

export interface OAuthProvider {
  readonly clientsStore: OAuthClientsStore;
  authorize(client: OAuthClientInformationFull, params: AuthorizationParams): string;
  challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): string;
  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    redirectUri?: string,
  ): OAuthTokens;
  exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): OAuthTokens;
  verifyAccessToken(token: string): Promise<AuthInfo>;
  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): void;
  connectorResource(slug: string): URL | null;
}

const CONSENT_PATH = '/dashboard/oauth/consent';

const DOMAIN_ERROR_CODES: Record<DomainOAuthErrorCode, OAuthErrorCode> = {
  invalid_request: OAuthErrorCode.InvalidRequest,
  invalid_client: OAuthErrorCode.InvalidClient,
  invalid_grant: OAuthErrorCode.InvalidGrant,
  invalid_scope: OAuthErrorCode.InvalidScope,
  unsupported_grant_type: OAuthErrorCode.UnsupportedGrantType,
  access_denied: OAuthErrorCode.AccessDenied,
};

function boundProjectId(
  resource: URL | undefined,
  origin: string,
  projects: ProjectsService,
): string | null {
  if (!resource) return null;
  if (
    resource.origin !== origin ||
    resource.username !== '' ||
    resource.password !== '' ||
    resource.search !== '' ||
    resource.hash !== ''
  ) {
    throw invalidTarget(resource);
  }
  const path = resource.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/mcp') return null;
  const project = path.startsWith('/mcp/')
    ? projects.findBySlug(path.slice('/mcp/'.length))
    : undefined;
  if (!project) throw invalidTarget(resource);
  return project.id;
}

function invalidTarget(resource: URL): OAuthError {
  return new OAuthError(
    OAuthErrorCode.InvalidTarget,
    `resource '${resource.href}' is not an MCP connector of this server`,
  );
}

export function createOAuthProvider(opts: OAuthProviderOptions): OAuthProvider {
  const { oauth, projects, issuer, areqKey } = opts;
  const origin = new URL(issuer).origin;
  const now = opts.now ?? (() => new Date());
  const consentTtl = opts.consentTtlSeconds ?? 600;

  const clientsStore: OAuthClientsStore = {
    getClient(clientId) {
      const client = oauth.findClient(clientId);
      return client
        ? toClientInfo(client.clientId, oauth.redirectUrisFor(client), client.clientName)
        : undefined;
    },
    registerClient(metadata) {
      const created = settled(() =>
        oauth.registerClient({
          clientName: metadata.client_name ?? null,
          redirectUris: metadata.redirect_uris,
          tokenEndpointAuthMethod: metadata.token_endpoint_auth_method,
        }),
      );
      return toClientInfo(created.clientId, oauth.redirectUrisFor(created), created.clientName);
    },
  };

  return {
    clientsStore,

    authorize(client, params) {
      const req: AuthRequest = {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scope: params.scopes.join(' '),
        state: params.state,
        projectId: boundProjectId(params.resource, origin, projects),
        exp: Math.floor(now().getTime() / 1000) + consentTtl,
      };
      const blob = signAuthRequest(req, areqKey);
      return `${issuer}${CONSENT_PATH}?areq=${encodeURIComponent(blob)}`;
    },

    challengeForAuthorizationCode(_client, code) {
      return settled(() => oauth.challengeForCode(code));
    },

    exchangeAuthorizationCode(client, code, redirectUri) {
      return settled(() =>
        toOAuthTokens(oauth.redeemCode({ code, clientId: client.client_id, redirectUri })),
      );
    },

    exchangeRefreshToken(client, refreshToken) {
      return settled(() =>
        toOAuthTokens(oauth.refresh({ refreshToken, clientId: client.client_id })),
      );
    },

    verifyAccessToken(token) {
      const resolved = oauth.authenticateAccessToken(token);
      if (!resolved) {
        return Promise.reject(
          new OAuthError(OAuthErrorCode.InvalidToken, 'access token is invalid or expired'),
        );
      }
      return Promise.resolve({
        token,
        clientId: resolved.clientId,
        scopes: [resolved.scope],
        expiresAt: resolved.expiresAtSeconds,
      });
    },

    revokeToken(client, request) {
      oauth.revokeByToken(request.token, client.client_id);
    },

    connectorResource(slug) {
      if (projects.findBySlug(slug) === undefined) return null;
      return new URL(`/mcp/${slug}`, origin);
    },
  };
}

function settled<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toOAuthError(err);
  }
}

function isDomainErrorCode(code: unknown): code is DomainOAuthErrorCode {
  return typeof code === 'string' && Object.hasOwn(DOMAIN_ERROR_CODES, code);
}

export function toOAuthError(err: unknown): OAuthError {
  if (err instanceof Error && err.name === 'OAuthError' && 'code' in err) {
    if (isDomainErrorCode(err.code))
      return new OAuthError(DOMAIN_ERROR_CODES[err.code], err.message);
  }
  return new OAuthError(
    OAuthErrorCode.ServerError,
    err instanceof Error ? err.message : 'internal error',
  );
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
