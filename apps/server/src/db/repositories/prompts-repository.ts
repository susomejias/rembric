import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../client.js';
import { prompts, type NewPrompt, type Prompt } from '../schema/prompts.js';

import { idJsonSet } from './scope-clause.js';

export interface AdminPromptFilters {
  includeDeleted: boolean;
  project?: { kind: 'global' } | { kind: 'project'; projectId: string };
  agent?: string;
  sessionIdPrefix?: string;
}

export interface AdminListPromptsOpts extends AdminPromptFilters {
  limit: number;
  offset: number;
}

export interface SearchPromptsOpts {
  projectId: string | null;
  query?: string;
  sessionId?: string;
  agent?: string;
  includeDeleted?: boolean;
  limit: number;
  offset: number;
}

export class PromptsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewPrompt): Prompt | undefined {
    return this.db.insert(prompts).values(values).returning().get();
  }

  findById(id: string): Prompt | undefined {
    return this.db.select().from(prompts).where(eq(prompts.id, id)).get();
  }

  setDeletedAt(id: string, deletedAt: Date | null): Prompt | undefined {
    return this.db.update(prompts).set({ deletedAt }).where(eq(prompts.id, id)).returning().get();
  }

  /** N most recent non-deleted prompts in the given scope, newest first. */
  recentForContext(projectId: string | null, limit: number): Prompt[] {
    const scopeCondition =
      projectId === null ? isNull(prompts.projectId) : eq(prompts.projectId, projectId);
    return this.db
      .select()
      .from(prompts)
      .where(and(scopeCondition, isNull(prompts.deletedAt)))
      .orderBy(desc(prompts.createdAt))
      .limit(limit)
      .all();
  }

  /**
   * Scope-aware search. FTS5 (`prompts_fts MATCH`) when `query` is
   * non-empty, else recency. Returns rank-ordered (or newest-first) rows
   * plus the unpaginated total for the same predicate.
   */
  searchByScope(opts: SearchPromptsOpts): { prompts: Prompt[]; total: number } {
    const useFts = typeof opts.query === 'string' && opts.query.trim().length > 0;

    if (useFts) {
      const ftsFilters: SQL[] = [];
      ftsFilters.push(
        opts.projectId === null ? sql`p.project_id IS NULL` : sql`p.project_id = ${opts.projectId}`,
      );
      if (!opts.includeDeleted) ftsFilters.push(sql`p.deleted_at IS NULL`);
      if (opts.sessionId) ftsFilters.push(sql`p.session_id = ${opts.sessionId}`);
      if (opts.agent) ftsFilters.push(sql`p.agent = ${opts.agent}`);
      const ftsWhere = sql.join(ftsFilters, sql` AND `);

      // One row beyond the page, at offset 0 only: that is the only place an
      // unfull page proves the total, so elsewhere the extra row is waste.
      const lookahead = opts.offset === 0 ? opts.limit + 1 : opts.limit;
      const matched = this.db.all<{ id: string }>(
        sql`
            SELECT p.id FROM prompts p
              JOIN prompts_fts f ON f.rowid = p.rowid
             WHERE prompts_fts MATCH ${opts.query}
               AND ${ftsWhere}
             ORDER BY rank
             LIMIT ${lookahead} OFFSET ${opts.offset}
          `,
      );
      const matchedIds = matched.slice(0, opts.limit).map((r) => r.id);
      const total =
        opts.offset === 0 && matched.length <= opts.limit
          ? matched.length
          : ((
              this.db.get<{ v: number }>(sql`
                SELECT COUNT(*) AS v FROM prompts p
                  JOIN prompts_fts f ON f.rowid = p.rowid
                 WHERE prompts_fts MATCH ${opts.query}
                   AND ${ftsWhere}
              `) as { v: number } | undefined
            )?.v ?? 0);

      if (matchedIds.length === 0) return { prompts: [], total };

      const rows = this.db.select().from(prompts).where(inArray(prompts.id, matchedIds)).all();
      const rankOrder = new Map(matchedIds.map((id, idx) => [id, idx] as const));
      rows.sort((a, b) => (rankOrder.get(a.id) ?? 0) - (rankOrder.get(b.id) ?? 0));
      return { prompts: rows, total };
    }

    const conditions: SQL[] = [
      opts.projectId === null ? isNull(prompts.projectId) : eq(prompts.projectId, opts.projectId),
    ];
    if (!opts.includeDeleted) conditions.push(isNull(prompts.deletedAt));
    if (opts.sessionId) conditions.push(eq(prompts.sessionId, opts.sessionId));
    if (opts.agent) conditions.push(eq(prompts.agent, opts.agent));
    const wherePredicate = and(...conditions);

    const rows = this.db
      .select()
      .from(prompts)
      .where(wherePredicate)
      .orderBy(desc(prompts.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
    const totalRow = this.db.select({ v: count() }).from(prompts).where(wherePredicate).get();
    return { prompts: rows, total: totalRow?.v ?? 0 };
  }

  //  The ONE escape hatch in the otherwise append-only contract for the
  //  `prompts` table. The invariant test white-lists ONLY this file for
  //  `DELETE FROM prompts`.

  countDeleted(): number {
    const row = this.db
      .select({ v: count() })
      .from(prompts)
      .where(isNotNull(prompts.deletedAt))
      .get();
    return row?.v ?? 0;
  }

  findDeletedIds(): string[] {
    return this.db
      .select({ id: prompts.id })
      .from(prompts)
      .where(isNotNull(prompts.deletedAt))
      .all()
      .map((r) => r.id);
  }

  purgeByIds(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const placeholders = sql.join(
      ids.map((id) => sql`${id}`),
      sql.raw(', '),
    );
    this.db.run(sql`DELETE FROM prompts WHERE id IN (${placeholders})`);
  }

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

  private adminFilterConditions(opts: AdminPromptFilters): SQL[] {
    const conditions: SQL[] = [];
    if (!opts.includeDeleted) conditions.push(isNull(prompts.deletedAt));
    if (opts.project?.kind === 'global') {
      conditions.push(isNull(prompts.projectId));
    } else if (opts.project?.kind === 'project') {
      conditions.push(eq(prompts.projectId, opts.project.projectId));
    }
    if (opts.agent) conditions.push(eq(prompts.agent, opts.agent));
    if (opts.sessionIdPrefix) {
      // Range, not LIKE: LIKE needs NOCASE and this column collates BINARY.
      // Upper-cased because LIKE was ASCII-case-insensitive and session ids are
      // ULIDs — without this, a lowercase prefix silently matches nothing.
      const prefix = opts.sessionIdPrefix.toUpperCase();
      conditions.push(and(gte(prompts.sessionId, prefix), lt(prompts.sessionId, prefix + '￿'))!);
    }
    return conditions;
  }

  adminList(opts: AdminListPromptsOpts): Prompt[] {
    const conditions = this.adminFilterConditions(opts);
    const query = this.db
      .select()
      .from(prompts)
      .orderBy(desc(prompts.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .$dynamic();
    return conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();
  }

  /** True count for the same filter set `adminList` applies, no LIMIT/OFFSET/ORDER BY. */
  adminCount(opts: AdminPromptFilters): number {
    const conditions = this.adminFilterConditions(opts);
    const query = this.db.select({ value: count() }).from(prompts).$dynamic();
    const row = conditions.length > 0 ? query.where(and(...conditions)).get() : query.get();
    return row?.value ?? 0;
  }

  /** Non-deleted prompt count per agent session, for the caller's page. */
  adminCountBySession(sessionIds: readonly string[]): Record<string, number> {
    if (sessionIds.length === 0) return {};
    const rows = this.db
      .select({ sessionId: prompts.sessionId, n: count() })
      .from(prompts)
      // `IN (<non-null set>)` already excludes a NULL session_id.
      .where(and(isNull(prompts.deletedAt), inArray(prompts.sessionId, idJsonSet(sessionIds))))
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
