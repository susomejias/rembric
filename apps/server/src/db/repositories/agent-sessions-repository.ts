import { and, count, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  agentSessions,
  type AgentSession,
  type AgentSessionStatus,
  type NewAgentSession,
} from '../schema/agent-sessions.js';
import { projects, type Project } from '../schema/projects.js';
import { tokens, type Token } from '../schema/tokens.js';

export type AdminSessionRow = Pick<
  AgentSession,
  | 'id'
  | 'agent'
  | 'title'
  | 'description'
  | 'startedAt'
  | 'endedAt'
  | 'status'
  | 'deletedAt'
  | 'projectId'
> & {
  tokenName: Token['name'] | null;
  tokenRevokedAt: Token['revokedAt'] | null;
  projectSlug: Project['slug'] | null;
};

export type AdminSessionDetail = AdminSessionRow & Pick<AgentSession, 'summary'>;

export type AdminRecentSession = Pick<
  AgentSession,
  'id' | 'agent' | 'startedAt' | 'endedAt' | 'status' | 'summary'
> & {
  projectSlug: Project['slug'] | null;
  memCount: number;
};

export interface ListSessionsOpts {
  limit: number;
  status?: AgentSessionStatus;
  includeDeleted?: boolean;
}

const listSelection = {
  id: agentSessions.id,
  agent: agentSessions.agent,
  title: agentSessions.title,
  description: agentSessions.description,
  startedAt: agentSessions.startedAt,
  endedAt: agentSessions.endedAt,
  status: agentSessions.status,
  deletedAt: agentSessions.deletedAt,
  projectId: agentSessions.projectId,
  tokenName: tokens.name,
  tokenRevokedAt: tokens.revokedAt,
  projectSlug: projects.slug,
};

// "Session has something worth surfacing" — adding a new table that anchors
// to a session id (e.g. a future `tool_calls`) MUST update only this helper.
function sessionHasContentSql(alias: 's' | 'sessions') {
  return sql.raw(
    `(${alias}.summary IS NOT NULL` +
      ` OR ${alias}.title_final = 1` +
      ` OR EXISTS (SELECT 1 FROM memory        WHERE session_id = ${alias}.id)` +
      ` OR EXISTS (SELECT 1 FROM prompts       WHERE session_id = ${alias}.id AND deleted_at IS NULL)` +
      ` OR EXISTS (SELECT 1 FROM confirmations WHERE session_id = ${alias}.id))`,
  );
}

export class AgentSessionsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewAgentSession): AgentSession | undefined {
    return this.db.insert(agentSessions).values(values).returning().get();
  }

  getById(id: string): AgentSession | undefined {
    return this.db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  }

  /**
   * Apply a field update to a session, optionally requiring it still be
   * `active` (the FSM guard). Returns the updated row, or undefined when
   * the active-guard filtered it out (concurrent transition).
   */
  updateById(
    id: string,
    set: Partial<NewAgentSession>,
    opts: { requireActive: boolean },
  ): AgentSession | undefined {
    return this.db
      .update(agentSessions)
      .set(set)
      .where(
        opts.requireActive
          ? and(eq(agentSessions.id, id), eq(agentSessions.status, 'active'))
          : eq(agentSessions.id, id),
      )
      .returning()
      .get();
  }

  findActiveForTransport(tokenId: string, projectId: string | null): AgentSession | undefined {
    const conditions = [
      eq(agentSessions.tokenId, tokenId),
      eq(agentSessions.status, 'active'),
      isNull(agentSessions.deletedAt),
      projectId === null ? isNull(agentSessions.projectId) : eq(agentSessions.projectId, projectId),
    ];
    return this.db
      .select()
      .from(agentSessions)
      .where(and(...conditions))
      .orderBy(desc(agentSessions.startedAt))
      .limit(1)
      .get();
  }

  recentForContext(projectId: string | null, limit: number): AgentSession[] {
    const scopeCondition =
      projectId === null ? isNull(agentSessions.projectId) : eq(agentSessions.projectId, projectId);
    return this.db
      .select()
      .from(agentSessions)
      .where(and(scopeCondition, isNull(agentSessions.deletedAt), sessionHasContentSql('sessions')))
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit)
      .all();
  }

  list(opts: ListSessionsOpts): AgentSession[] {
    const conditions = [];
    if (!opts.includeDeleted) conditions.push(isNull(agentSessions.deletedAt));
    if (opts.status) conditions.push(eq(agentSessions.status, opts.status));
    const query = this.db
      .select()
      .from(agentSessions)
      .orderBy(desc(agentSessions.startedAt))
      .limit(opts.limit)
      .$dynamic();
    return conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();
  }

  /** Bulk-abandon active rows started before `cutoff`. Returns rows changed. */
  abandonActiveOlderThan(cutoff: Date, endedAt: Date): number {
    const result = this.db
      .update(agentSessions)
      .set({ status: 'abandoned', endedAt })
      .where(and(eq(agentSessions.status, 'active'), lt(agentSessions.startedAt, cutoff)))
      .run();
    return result.changes;
  }

  countByStatus(): { status: AgentSessionStatus; count: number }[] {
    return this.db
      .select({ status: agentSessions.status, count: count() })
      .from(agentSessions)
      .where(isNull(agentSessions.deletedAt))
      .groupBy(agentSessions.status)
      .all();
  }

  memoryCount(sessionId: string): number {
    const row = this.db.get<{ v: number }>(
      sql`SELECT COUNT(*) AS v FROM memory WHERE session_id = ${sessionId}`,
    ) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  countPurgeableEmpty(cutoffMs: number): number {
    const row = this.db.get<{ v: number }>(sql`
      SELECT COUNT(*) AS v FROM sessions s
       WHERE s.status IN ('ended','abandoned')
         AND s.deleted_at IS NULL
         AND s.ended_at IS NOT NULL
         AND s.ended_at < ${cutoffMs}
         AND NOT ${sessionHasContentSql('s')}
    `) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  findPurgeableEmptyIds(cutoffMs: number): string[] {
    return this.db
      .all<{ id: string }>(
        sql`
        SELECT s.id FROM sessions s
         WHERE s.status IN ('ended','abandoned')
           AND s.deleted_at IS NULL
           AND s.ended_at IS NOT NULL
           AND s.ended_at < ${cutoffMs}
           AND NOT ${sessionHasContentSql('s')}
      `,
      )
      .map((r) => r.id);
  }

  purgeByIds(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const placeholders = sql.join(
      ids.map((id) => sql`${id}`),
      sql.raw(', '),
    );
    this.db.run(sql`DELETE FROM sessions WHERE id IN (${placeholders})`);
  }

  adminList(opts: {
    deleted: boolean;
    activeFirst: boolean;
    limit: number;
    offset: number;
  }): AdminSessionRow[] {
    return this.db
      .select(listSelection)
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .where(opts.deleted ? isNotNull(agentSessions.deletedAt) : isNull(agentSessions.deletedAt))
      .orderBy(
        ...(opts.activeFirst
          ? [sql`CASE WHEN ${agentSessions.status} = 'active' THEN 0 ELSE 1 END`]
          : []),
        desc(agentSessions.startedAt),
      )
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
  }

  adminGetDetail(id: string): AdminSessionDetail | undefined {
    return this.db
      .select({ ...listSelection, summary: agentSessions.summary })
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .where(eq(agentSessions.id, id))
      .get();
  }

  adminRecent(limit: number): AdminRecentSession[] {
    return this.db
      .select({
        id: agentSessions.id,
        agent: agentSessions.agent,
        startedAt: agentSessions.startedAt,
        endedAt: agentSessions.endedAt,
        status: agentSessions.status,
        summary: agentSessions.summary,
        projectSlug: projects.slug,
        memCount: sql<number>`(SELECT COUNT(*) FROM memory m WHERE m.session_id = ${agentSessions.id})`,
      })
      .from(agentSessions)
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .where(isNull(agentSessions.deletedAt))
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit)
      .all();
  }
}
