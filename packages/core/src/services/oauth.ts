import { createHash, randomBytes } from 'node:crypto';

import {
  type OAuthAuthorizationCode,
  type OAuthClient,
  type OAuthRepository,
  type OAuthToken,
} from '@rembric/db';
import { ulid } from 'ulid';

import { projectScopedGrant, type TokenScope } from './tokens.js';

const SECRET_BYTES = 32;
const CODE_TTL_MS = 120_000;

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unsupported_grant_type'
  | 'access_denied';

export class OAuthError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface RegisterClientInput {
  clientName?: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod?: string;
}

export interface IssueCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** OAuth scope string in the advertised vocabulary (e.g. "mcp read"). */
  scope: string;
  subject: string;
  /** Consented project id (from the RFC 8707 resource path); null = global grant. */
  projectId?: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  /** Granted OAuth scope string, echoed back to the client in /token. */
  scope: string;
}

export interface ResolvedAccessToken {
  scope: TokenScope;
  subject: string;
  clientId: string;
  /** Consented project id, or null for a global grant. */
  projectId: string | null;
  /** Expiry as seconds since epoch (for AuthInfo). */
  expiresAtSeconds: number;
}

export interface OAuthServiceOptions {
  accessTtlMs: number;
  refreshTtlMs: number;
}

export class OAuthService {
  constructor(
    private readonly repos: { oauth: OAuthRepository },
    private readonly opts: OAuthServiceOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  registerClient(input: RegisterClientInput): OAuthClient {
    if (input.redirectUris.length === 0) {
      throw new OAuthError('invalid_request', 'at least one redirect_uri is required');
    }
    for (const uri of input.redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        throw new OAuthError(
          'invalid_request',
          `redirect_uri '${uri}' must be https (or http loopback)`,
        );
      }
    }
    const authMethod = input.tokenEndpointAuthMethod ?? 'none';
    if (authMethod !== 'none') {
      throw new OAuthError(
        'invalid_request',
        'only public clients (token_endpoint_auth_method=none) are supported',
      );
    }
    const ts = this.now();
    const row = this.repos.oauth.insertClient({
      clientId: `oauthc_${ulid(ts.getTime())}`,
      clientName: input.clientName ?? null,
      redirectUris: JSON.stringify(input.redirectUris),
      tokenEndpointAuthMethod: authMethod,
      createdAt: ts,
    });
    if (!row) throw new OAuthError('invalid_request', 'client registration failed');
    return row;
  }

  findClient(clientId: string): OAuthClient | undefined {
    return this.repos.oauth.findClient(clientId);
  }

  redirectUrisFor(client: OAuthClient): string[] {
    try {
      const parsed: unknown = JSON.parse(client.redirectUris);
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Issue a single-use authorization code; returns the plaintext code. */
  issueCode(input: IssueCodeInput): string {
    const ts = this.now();
    const secret = generateSecret();
    const row = this.repos.oauth.insertCode({
      id: ulid(ts.getTime()),
      hash: hashSecret(secret),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope,
      subject: input.subject,
      projectId: input.projectId ?? null,
      expiresAt: new Date(ts.getTime() + CODE_TTL_MS),
      consumedAt: null,
      createdAt: ts,
    });
    if (!row) throw new OAuthError('invalid_request', 'failed to issue authorization code');
    return secret;
  }

  challengeForCode(code: string): string {
    return this.findValidCode(code).codeChallenge;
  }

  redeemCode(input: { code: string; clientId: string; redirectUri?: string }): TokenPair {
    const code = this.findValidCode(input.code);
    if (code.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'client_id does not match the authorization code');
    }
    if (input.redirectUri === undefined || code.redirectUri !== input.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization code');
    }
    // Atomic single-use: only the first redemption flips consumed_at.
    if (this.repos.oauth.consumeCode(code.id, this.now()) === 0) {
      throw new OAuthError('invalid_grant', 'authorization code already used');
    }
    return this.issueTokenPair({
      clientId: code.clientId,
      familyId: `oauthf_${ulid(this.now().getTime())}`,
      scope: code.scope,
      subject: code.subject,
      projectId: code.projectId,
    });
  }

  private findValidCode(code: string): OAuthAuthorizationCode {
    const row = this.repos.oauth.findCodeByHash(hashSecret(code));
    if (!row) throw new OAuthError('invalid_grant', 'authorization code not recognized');
    if (row.consumedAt) throw new OAuthError('invalid_grant', 'authorization code already used');
    if (row.expiresAt.getTime() <= this.now().getTime()) {
      throw new OAuthError('invalid_grant', 'authorization code expired');
    }
    return row;
  }

  refresh(input: { refreshToken: string; clientId: string }): TokenPair {
    const refresh = this.repos.oauth.findTokenByHash(hashSecret(input.refreshToken), 'refresh');
    if (!refresh) throw new OAuthError('invalid_grant', 'refresh token not recognized');
    if (refresh.revokedAt) {
      throw new OAuthError('invalid_grant', 'refresh token revoked');
    }
    if (refresh.rotatedAt) {
      // Reuse of an already-rotated refresh token ⇒ treat as compromise.
      this.repos.oauth.revokeFamily(refresh.familyId, this.now());
      throw new OAuthError('invalid_grant', 'refresh token reuse detected; token family revoked');
    }
    if (refresh.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'client_id does not match the refresh token');
    }
    if (refresh.expiresAt.getTime() <= this.now().getTime()) {
      throw new OAuthError('invalid_grant', 'refresh token expired');
    }
    if (this.repos.oauth.markRefreshRotated(refresh.id, this.now()) === 0) {
      // Lost the race to another concurrent refresh of the same token.
      this.repos.oauth.revokeFamily(refresh.familyId, this.now());
      throw new OAuthError('invalid_grant', 'refresh token reuse detected; token family revoked');
    }
    return this.issueTokenPair({
      clientId: refresh.clientId,
      familyId: refresh.familyId,
      scope: refresh.scope,
      subject: refresh.subject,
      projectId: refresh.projectId,
    });
  }

  /** Resolve an access token presented as a bearer; null if not a valid OAuth access token. */
  authenticateAccessToken(plaintext: string): ResolvedAccessToken | null {
    const token = this.repos.oauth.findTokenByHash(hashSecret(plaintext), 'access');
    if (!token) return null;
    if (token.revokedAt) return null;
    if (token.expiresAt.getTime() <= this.now().getTime()) return null;
    return {
      scope: projectScopedGrant(resolveGrantedScope(token.scope), token.projectId),
      subject: token.subject,
      clientId: token.clientId,
      projectId: token.projectId,
      expiresAtSeconds: Math.floor(token.expiresAt.getTime() / 1000),
    };
  }

  revokeByToken(plaintext: string, clientId?: string): void {
    const hash = hashSecret(plaintext);
    const token =
      this.repos.oauth.findTokenByHash(hash, 'access') ??
      this.repos.oauth.findTokenByHash(hash, 'refresh');
    if (!token) return;
    if (clientId !== undefined && token.clientId !== clientId) return;
    this.repos.oauth.revokeFamily(token.familyId, this.now());
  }

  private issueTokenPair(input: {
    clientId: string;
    familyId: string;
    scope: string;
    subject: string;
    projectId: string | null;
  }): TokenPair {
    const accessSecret = generateSecret();
    const refreshSecret = generateSecret();
    this.insertToken('access', accessSecret, input, this.opts.accessTtlMs);
    this.insertToken('refresh', refreshSecret, input, this.opts.refreshTtlMs);
    return {
      accessToken: accessSecret,
      refreshToken: refreshSecret,
      expiresInSeconds: Math.floor(this.opts.accessTtlMs / 1000),
      scope: input.scope,
    };
  }

  private insertToken(
    kind: 'access' | 'refresh',
    secret: string,
    grant: {
      clientId: string;
      familyId: string;
      scope: string;
      subject: string;
      projectId: string | null;
    },
    ttlMs: number,
  ): OAuthToken {
    const ts = this.now();
    const row = this.repos.oauth.insertToken({
      id: ulid(ts.getTime()),
      kind,
      hash: hashSecret(secret),
      clientId: grant.clientId,
      familyId: grant.familyId,
      scope: grant.scope,
      subject: grant.subject,
      projectId: grant.projectId,
      expiresAt: new Date(ts.getTime() + ttlMs),
      rotatedAt: null,
      revokedAt: null,
      createdAt: ts,
    });
    if (!row) throw new OAuthError('invalid_request', `failed to issue ${kind} token`);
    return row;
  }
}

export function resolveGrantedScope(requestedScope: string | undefined): TokenScope {
  const tokens = (requestedScope ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const wantsWrite = tokens.some(
    (t) => t === '*' || t === 'mcp' || t === 'mcp:write' || t.endsWith(':write'),
  );
  return wantsWrite ? '*' : 'read:*';
}

/** OAuth scopes advertised in the metadata and grantable at consent. */
export const SUPPORTED_OAUTH_SCOPES = ['mcp', 'read'] as const;

export function grantedOAuthScope(requestedScope: string | undefined): string {
  const supported = SUPPORTED_OAUTH_SCOPES as readonly string[];
  const kept = (requestedScope ?? '')
    .split(/\s+/)
    .filter((t) => supported.includes(t.toLowerCase()));
  return kept.length > 0 ? kept.join(' ') : 'read';
}

function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === 'localhost';
    }
    return false;
  } catch {
    return false;
  }
}
