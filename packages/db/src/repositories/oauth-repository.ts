import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthTokens,
  type NewOAuthAuthorizationCode,
  type NewOAuthClient,
  type NewOAuthToken,
  type OAuthAuthorizationCode,
  type OAuthClient,
  type OAuthToken,
  type OAuthTokenKind,
} from '../schema/oauth.js';

export class OAuthRepository {
  constructor(private readonly db: Db) {}

  insertClient(values: NewOAuthClient): OAuthClient | undefined {
    return this.db.insert(oauthClients).values(values).returning().get();
  }

  findClient(clientId: string): OAuthClient | undefined {
    return this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get();
  }

  insertCode(values: NewOAuthAuthorizationCode): OAuthAuthorizationCode | undefined {
    return this.db.insert(oauthAuthorizationCodes).values(values).returning().get();
  }

  findCodeByHash(hash: string): OAuthAuthorizationCode | undefined {
    return this.db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.hash, hash))
      .get();
  }

  /** Mark a code consumed only if not already consumed; returns rows changed. */
  consumeCode(id: string, consumedAt: Date): number {
    return this.db
      .update(oauthAuthorizationCodes)
      .set({ consumedAt })
      .where(and(eq(oauthAuthorizationCodes.id, id), isNull(oauthAuthorizationCodes.consumedAt)))
      .run().changes;
  }

  insertToken(values: NewOAuthToken): OAuthToken | undefined {
    return this.db.insert(oauthTokens).values(values).returning().get();
  }

  findTokenByHash(hash: string, kind: OAuthTokenKind): OAuthToken | undefined {
    return this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.hash, hash), eq(oauthTokens.kind, kind)))
      .get();
  }

  /** Mark a refresh token rotated only if not already rotated; returns rows changed. */
  markRefreshRotated(id: string, rotatedAt: Date): number {
    return this.db
      .update(oauthTokens)
      .set({ rotatedAt })
      .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.rotatedAt)))
      .run().changes;
  }

  /** Revoke every still-active token in a family. Returns rows changed. */
  revokeFamily(familyId: string, revokedAt: Date): number {
    return this.db
      .update(oauthTokens)
      .set({ revokedAt })
      .where(and(eq(oauthTokens.familyId, familyId), isNull(oauthTokens.revokedAt)))
      .run().changes;
  }
}
