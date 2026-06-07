import { and, count, desc, eq, inArray, isNotNull, isNull, like, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../client.js';
import { prompts, type Prompt } from '../schema/prompts.js';

export interface AdminListPromptsOpts {
  includeDeleted: boolean;
  project?: { kind: 'global' } | { kind: 'project'; projectId: string };
  agent?: string;
  sessionIdPrefix?: string;
  limit: number;
  offset: number;
}

export class PromptsRepository {
  constructor(private readonly db: Db) {}

  // ── admin* — unscoped dashboard reads ──────────────────────────────

  /** FTS5 keyword search across all prompts (including soft-deleted). */
  adminSearchFts(query: string, limit: number, offset: number): Prompt[] {
    const ids = this.db
      .all<{ id: string }>(
        sql`
          SELECT p.id
          FROM prompts p
          JOIN prompts_fts f ON f.rowid = p.rowid
          WHERE prompts_fts MATCH ${query}
          ORDER BY rank, p.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
      )
      .map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db.select().from(prompts).where(inArray(prompts.id, ids)).all();
  }

  adminList(opts: AdminListPromptsOpts): Prompt[] {
    const conditions: SQL[] = [];
    if (!opts.includeDeleted) conditions.push(isNull(prompts.deletedAt));
    if (opts.project?.kind === 'global') {
      conditions.push(isNull(prompts.projectId));
    } else if (opts.project?.kind === 'project') {
      conditions.push(eq(prompts.projectId, opts.project.projectId));
    }
    if (opts.agent) conditions.push(eq(prompts.agent, opts.agent));
    if (opts.sessionIdPrefix) {
      conditions.push(like(prompts.sessionId, opts.sessionIdPrefix + '%'));
    }

    const query = this.db
      .select()
      .from(prompts)
      .orderBy(desc(prompts.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .$dynamic();
    return conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();
  }

  /** Non-deleted prompt count per agent session, keyed by session id. */
  adminCountBySession(): Record<string, number> {
    const rows = this.db
      .select({ sessionId: prompts.sessionId, n: count() })
      .from(prompts)
      .where(and(isNotNull(prompts.sessionId), isNull(prompts.deletedAt)))
      .groupBy(prompts.sessionId)
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.sessionId) out[r.sessionId] = r.n;
    }
    return out;
  }

  adminListBySession(sessionId: string): Prompt[] {
    return this.db
      .select()
      .from(prompts)
      .where(and(eq(prompts.sessionId, sessionId), isNull(prompts.deletedAt)))
      .orderBy(prompts.createdAt)
      .all();
  }
}
