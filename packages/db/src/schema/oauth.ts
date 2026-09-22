import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const oauthClients = sqliteTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name'),
  /** JSON array of registered redirect URIs. */
  redirectUris: text('redirect_uris').notNull(),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const oauthAuthorizationCodes = sqliteTable(
  'oauth_authorization_codes',
  {
    id: text('id').primaryKey(),
    /** Hash of the single-use authorization code secret. */
    hash: text('hash').notNull(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    /** PKCE S256 challenge bound at /authorize, verified at /token. */
    codeChallenge: text('code_challenge').notNull(),
    scope: text('scope').notNull(),
    subject: text('subject').notNull(),
    /** Consented project (from the RFC 8707 resource path); null = global grant. */
    projectId: text('project_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    hashIdx: index('oauth_authorization_codes_hash_idx').on(table.hash),
  }),
);

export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    /** `access` | `refresh`. */
    kind: text('kind').notNull(),
    /** Hash of the bearer secret. */
    hash: text('hash').notNull(),
    clientId: text('client_id').notNull(),
    /** Groups an access/refresh lineage for refresh-reuse family revocation. */
    familyId: text('family_id').notNull(),
    scope: text('scope').notNull(),
    subject: text('subject').notNull(),
    /** Consented project (inherited from the grant); null = global grant. */
    projectId: text('project_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    /** Set when a refresh token is consumed by rotation. */
    rotatedAt: integer('rotated_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    hashIdx: index('oauth_tokens_hash_idx').on(table.hash),
    familyIdx: index('oauth_tokens_family_idx').on(table.familyId),
  }),
);

export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type OAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type NewOAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;

export type OAuthTokenKind = 'access' | 'refresh';
