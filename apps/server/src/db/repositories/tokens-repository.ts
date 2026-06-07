import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import { tokens, type NewToken, type Token } from '../schema/tokens.js';

export class TokensRepository {
  constructor(private readonly db: Db) {}

  count(): number {
    return this.db.select({ id: tokens.id }).from(tokens).limit(1).all().length;
  }

  insert(values: NewToken): Token | undefined {
    return this.db.insert(tokens).values(values).returning().get();
  }

  listAll(): Token[] {
    return this.db.select().from(tokens).all();
  }

  findByName(name: string): Token | undefined {
    return this.db.select().from(tokens).where(eq(tokens.name, name)).get();
  }

  findById(id: string): Token | undefined {
    return this.db.select().from(tokens).where(eq(tokens.id, id)).get();
  }

  /** Revoke an active token by name. Returns rows changed (0 if missing/already revoked). */
  revokeByName(name: string, revokedAt: Date): number {
    const result = this.db
      .update(tokens)
      .set({ revokedAt })
      .where(and(eq(tokens.name, name), isNull(tokens.revokedAt)))
      .run();
    return result.changes;
  }
}
