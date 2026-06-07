import { desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { agentSessions, type AgentSession } from '../schema/agent-sessions.js';
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

export interface AdminListSessionsOpts {
  deleted: boolean;
  /** Sort active sessions above ended/abandoned ones. */
  activeFirst: boolean;
  limit: number;
  offset: number;
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

export class AgentSessionsRepository {
  constructor(private readonly db: Db) {}

  adminList(opts: AdminListSessionsOpts): AdminSessionRow[] {
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

  /** Most recent non-deleted sessions with their anchored-memory count. */
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
