import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Db } from '../client.js';
import { projects, type Project } from '../schema/projects.js';
import {
  tokenProjects,
  type NewTokenProject,
  type TokenProject,
} from '../schema/token-projects.js';
import { tokens, type NewToken, type Token } from '../schema/tokens.js';

/** One `token_projects` membership, as the dashboard renders it: slug, never id. */
export type AdminTokenProjectSlug = Pick<TokenProject, 'tokenId'> & Pick<Project, 'slug'>;

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

  /**
   * The projects a set-scoped token reaches. Not scope-parameterised because it
   * PRODUCES reach rather than filtering by it: this is the read the
   * authorization decision is made from, and it must run per authenticated
   * request (`services/tokens.ts::authorizeRow`).
   */
  listProjectIds(tokenId: Token['id']): TokenProject['projectId'][] {
    return this.db
      .select({ projectId: tokenProjects.projectId })
      .from(tokenProjects)
      .where(eq(tokenProjects.tokenId, tokenId))
      .all()
      .map((r) => r.projectId);
  }

  /** Membership rows for one token. Called inside the service's transaction. */
  insertProjects(values: NewTokenProject[]): void {
    if (values.length === 0) return;
    this.db.insert(tokenProjects).values(values).run();
  }

  /** Every token's membership, slug-resolved. Ordered so a render needs no sort. */
  adminListProjectSlugs(): AdminTokenProjectSlug[] {
    return this.db
      .select({ tokenId: tokenProjects.tokenId, slug: projects.slug })
      .from(tokenProjects)
      .innerJoin(projects, eq(projects.id, tokenProjects.projectId))
      .orderBy(asc(tokenProjects.tokenId), asc(projects.slug))
      .all();
  }
}
