import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../client.js';
import { confirmations } from '../schema/confirmations.js';
import {
  memory,
  type Memory,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from '../schema/memory.js';

export interface FindActiveByScopeOpts {
  scope: MemoryScope;
  projectId?: string | null;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
}

export interface AdminListMemoriesOpts {
  status: MemoryStatus;
  type?: MemoryType;
  project?: { kind: 'global' } | { kind: 'project'; projectId: string };
  limit: number;
  offset: number;
}

export class MemoryRepository {
  constructor(private readonly db: Db) {}

  findById(id: string): Memory | undefined {
    return this.db.select().from(memory).where(eq(memory.id, id)).get();
  }

  findActiveByScope(opts: FindActiveByScopeOpts): Memory[] {
    const projectFilter =
      opts.scope === 'project' && opts.projectId
        ? eq(memory.projectId, opts.projectId)
        : isNull(memory.projectId);

    const scopeFilter =
      opts.scope === 'project' && opts.includeGlobal
        ? or(
            and(eq(memory.scope, 'project'), projectFilter),
            and(eq(memory.scope, 'global'), isNull(memory.projectId)),
          )
        : and(eq(memory.scope, opts.scope), projectFilter);

    let query = this.db
      .select()
      .from(memory)
      .where(and(scopeFilter, eq(memory.status, 'active')))
      .orderBy(desc(memory.createdAt))
      .$dynamic();

    if (opts.limit !== undefined) query = query.limit(opts.limit);
    if (opts.offset !== undefined) query = query.offset(opts.offset);

    return query.all();
  }

  findByIds(ids: readonly string[]): Memory[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(memory)
      .where(inArray(memory.id, [...ids]))
      .all();
  }

  countByStatus(status: MemoryStatus): number {
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(eq(memory.status, status))
      .get();
    return row?.value ?? 0;
  }

  // ── admin* — unscoped dashboard reads ──────────────────────────────

  /**
   * FTS5 keyword search across ALL scopes, hydrated rows. Rank-ordered id
   * selection; hydration order follows the IN-list scan, matching the
   * previous inline dashboard query.
   */
  adminSearchFts(query: string, limit: number, offset: number): Memory[] {
    const ids = this.db
      .all<{ id: string }>(
        sql`
          SELECT m.id
          FROM memory m
          JOIN memory_fts f ON f.rowid = m.rowid
          WHERE memory_fts MATCH ${query}
          ORDER BY rank, m.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
      )
      .map((r) => r.id);
    return this.findByIds(ids);
  }

  adminList(opts: AdminListMemoriesOpts): Memory[] {
    const conditions: SQL[] = [eq(memory.status, opts.status)];
    if (opts.type) conditions.push(eq(memory.type, opts.type));
    if (opts.project?.kind === 'global') {
      conditions.push(eq(memory.scope, 'global'), isNull(memory.projectId));
    } else if (opts.project?.kind === 'project') {
      conditions.push(eq(memory.scope, 'project'), eq(memory.projectId, opts.project.projectId));
    }
    return this.db
      .select()
      .from(memory)
      .where(and(...conditions))
      .orderBy(desc(memory.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
  }

  adminGetByIds(ids: readonly string[]): Memory[] {
    return this.findByIds(ids);
  }

  /** Memory count per agent session, keyed by session id. */
  adminCountBySession(): Record<string, number> {
    const rows = this.db
      .select({ sessionId: memory.sessionId, n: count() })
      .from(memory)
      .where(isNotNull(memory.sessionId))
      .groupBy(memory.sessionId)
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.sessionId) out[r.sessionId] = r.n;
    }
    return out;
  }

  adminListBySession(sessionId: string): Memory[] {
    return this.db
      .select()
      .from(memory)
      .where(eq(memory.sessionId, sessionId))
      .orderBy(memory.createdAt)
      .all();
  }

  /** Memories created per UTC day bucket (epoch-ms / 86400000) since `since`. */
  adminCountCreatedByDay(since: Date): { day: number; n: number }[] {
    const day = sql<number>`(created_at / 86400000)`;
    return this.db
      .select({ day, n: count() })
      .from(memory)
      .where(gte(memory.createdAt, since))
      .groupBy(day)
      .orderBy(day)
      .all();
  }

  adminCountConfirmations(memoryId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(confirmations)
      .where(eq(confirmations.memoryId, memoryId))
      .get();
    return row?.value ?? 0;
  }
}
