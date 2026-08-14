import { and, count, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import type { Scope } from '../../services/scope.js';
import type { Db } from '../client.js';
import {
  agentSessions,
  sessionSummaryVersions,
  type AgentSession,
  type AgentSessionStatus,
  type NewAgentSession,
  type NewSessionSummaryVersion,
  type SessionSummaryVersion,
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

export type AdminSessionDetail = AdminSessionRow & Pick<AgentSession, 'summary' | 'summaryFinal'>;

export type AdminRecentSession = Pick<
  AgentSession,
  'id' | 'agent' | 'startedAt' | 'endedAt' | 'status' | 'summary' | 'summaryFinal'
> & {
  projectSlug: Project['slug'] | null;
  memCount: number;
};

export interface ListSessionsOpts {
  limit: number;
  status?: AgentSessionStatus;
  includeDeleted?: boolean;
}

export interface AdminSessionFilters {
  deleted: boolean;
  /** Unset = no filter; `null` = global-only; a string = that project. */
  projectId?: string | null;
  agent?: string;
  status?: AgentSessionStatus;
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

// Single source of truth for "when was this session last touched" — a
// zombie active row (killed without SessionEnd) never advances
// last_activity_at again, so falling back to started_at only matters for
// rows from before this column existed.
const EFFECTIVE_LAST_ACTIVITY = sql`COALESCE(${agentSessions.lastActivityAt}, ${agentSessions.startedAt})`;

// "Session has something worth surfacing" — adding a new table that anchors
// to a session id (e.g. a future `tool_calls`) MUST update only this helper.
// requireCuratedSummary distinguishes the two consumers' bars on clause 1
// only: context-surfacing (true, default) trusts only a curated summary;
// purge-eligibility (false) treats any summary text as "not empty", since
// deleting genuine-but-uncurated content is irreversible while merely not
// surfacing it in memory.context is not.
function sessionHasContentSql(
  alias: 's' | 'sessions',
  opts: { requireCuratedSummary: boolean } = { requireCuratedSummary: true },
) {
  const summaryClause = opts.requireCuratedSummary
    ? `${alias}.summary IS NOT NULL AND ${alias}.summary_final = 1`
    : `${alias}.summary IS NOT NULL`;
  return sql.raw(
    `((${summaryClause})` +
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

  /**
   * The auto-attachment fallback for MCP writes that omit an explicit
   * sessionId and have no SessionRouter entry for this transport. Returns
   * undefined — never guesses — when more than one active session matches
   * `(tokenId, projectId)`: two concurrently active sessions (e.g. two
   * different clients, or two windows of the same client) are genuinely
   * ambiguous, and silently attaching to "whichever started most recently"
   * can attach to the WRONG one. Preferring no attachment over a wrong one
   * is the whole point of this method's contract — see
   * `sessions/spec.md`'s "findActiveForTransport MUST NOT guess under
   * concurrent ambiguity".
   *
   * `activeSinceMs` additionally excludes rows whose last activity predates
   * that instant — a session killed without SessionEnd (SIGKILL/OOM/closed
   * terminal) never advances `last_activity_at` again, so it stops
   * contributing false ambiguity once stale, WITHOUT introducing a
   * recency tiebreak among genuinely concurrent live sessions (both must
   * still be within the window to be considered "live" at all).
   */
  findActiveForTransport(
    tokenId: string,
    projectId: string | null,
    activeSinceMs: number,
  ): AgentSession | undefined {
    const conditions = [
      eq(agentSessions.tokenId, tokenId),
      eq(agentSessions.status, 'active'),
      isNull(agentSessions.deletedAt),
      projectId === null ? isNull(agentSessions.projectId) : eq(agentSessions.projectId, projectId),
      sql`${EFFECTIVE_LAST_ACTIVITY} >= ${activeSinceMs}`,
    ];
    // No ORDER BY: "sole match or nothing" makes it unobservable.
    const rows = this.db
      .select()
      .from(agentSessions)
      .where(and(...conditions))
      .limit(2)
      .all();
    return rows.length === 1 ? rows[0] : undefined;
  }

  /** Bump `last_activity_at` — called by every write that resolves to this session. */
  touchActivity(id: string, at: Date): void {
    this.db.update(agentSessions).set({ lastActivityAt: at }).where(eq(agentSessions.id, id)).run();
  }

  recentForContext(projectId: string | null, limit: number): AgentSession[] {
    const scopeCondition =
      projectId === null ? isNull(agentSessions.projectId) : eq(agentSessions.projectId, projectId);
    return this.db
      .select()
      .from(agentSessions)
      .where(
        and(
          scopeCondition,
          isNull(agentSessions.deletedAt),
          sessionHasContentSql('sessions', { requireCuratedSummary: true }),
        ),
      )
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

  /**
   * Bulk-abandon active rows whose last activity predates `cutoff`. Keyed
   * on `COALESCE(last_activity_at, started_at)` rather than `started_at`
   * alone, so a session that is genuinely still being written to (long-
   * running work, not a zombie) is never abandoned out from under it — only
   * `fix-audited-defects: zombie sessions block auto-attach` changes it from
   * a boot-only sweep to one also runnable on an interval.
   */
  abandonInactiveSince(cutoff: Date, endedAt: Date): number {
    const result = this.db
      .update(agentSessions)
      .set({ status: 'abandoned', endedAt })
      .where(
        and(
          eq(agentSessions.status, 'active'),
          sql`${EFFECTIVE_LAST_ACTIVITY} < ${cutoff.getTime()}`,
        ),
      )
      .run();
    return result.changes;
  }

  private countByStatusWhere(
    scopeCondition?: SQL,
  ): { status: AgentSessionStatus; count: number }[] {
    const where = scopeCondition
      ? and(scopeCondition, isNull(agentSessions.deletedAt))
      : isNull(agentSessions.deletedAt);
    return this.db
      .select({ status: agentSessions.status, count: count() })
      .from(agentSessions)
      .where(where)
      .groupBy(agentSessions.status)
      .all();
  }

  /**
   * Session counts scoped to `(projectId === null ? global : that project)`.
   * The MCP-facing `memory.stats` handler MUST use this, not
   * `adminCountByStatus` — see openspec/changes/fix-audited-defects
   * ("memory.stats.sessionsByStatus bypasses scope enforcement").
   */
  countByStatusInScope(projectId: string | null): { status: AgentSessionStatus; count: number }[] {
    const scopeCondition =
      projectId === null ? isNull(agentSessions.projectId) : eq(agentSessions.projectId, projectId);
    return this.countByStatusWhere(scopeCondition);
  }

  /**
   * Unscoped, server-wide session counts. `admin`-prefixed so the data-
   * access confinement grep gate (`src/test/invariants.test.ts`) confines it
   * to the dashboard layer and `memory.doctor` (whose global `sessions.active`
   * is spec-blessed) — never to a per-request MCP tool.
   */
  adminCountByStatus(): { status: AgentSessionStatus; count: number }[] {
    return this.countByStatusWhere();
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
         AND NOT ${sessionHasContentSql('s', { requireCuratedSummary: false })}
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
           AND NOT ${sessionHasContentSql('s', { requireCuratedSummary: false })}
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

  /**
   * Optional filters shared by `adminList`/`adminCount`. `projectId`
   * follows the memories-list scope convention: unset = no filter,
   * `null` = global-only (`project_id IS NULL`), a string = that project.
   */
  private adminFilterConditions(opts: AdminSessionFilters): SQL[] {
    const conditions: SQL[] = [
      opts.deleted ? isNotNull(agentSessions.deletedAt) : isNull(agentSessions.deletedAt),
    ];
    if (opts.projectId === null) {
      conditions.push(isNull(agentSessions.projectId));
    } else if (opts.projectId !== undefined) {
      conditions.push(eq(agentSessions.projectId, opts.projectId));
    }
    if (opts.agent) conditions.push(eq(agentSessions.agent, opts.agent));
    if (opts.status) conditions.push(eq(agentSessions.status, opts.status));
    return conditions;
  }

  adminList(
    opts: AdminSessionFilters & {
      activeFirst: boolean;
      limit: number;
      offset: number;
    },
  ): AdminSessionRow[] {
    return this.db
      .select(listSelection)
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .where(and(...this.adminFilterConditions(opts)))
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

  /** True count for the same filter set `adminList` applies, no LIMIT/OFFSET/ORDER BY. */
  adminCount(opts: AdminSessionFilters): number {
    const row = this.db
      .select({ value: count() })
      .from(agentSessions)
      .where(and(...this.adminFilterConditions(opts)))
      .get();
    return row?.value ?? 0;
  }

  adminGetDetail(id: string): AdminSessionDetail | undefined {
    return this.db
      .select({
        ...listSelection,
        summary: agentSessions.summary,
        summaryFinal: agentSessions.summaryFinal,
      })
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .where(eq(agentSessions.id, id))
      .get();
  }

  insertSummaryVersion(values: NewSessionSummaryVersion): void {
    this.db.insert(sessionSummaryVersions).values(values).run();
  }

  latestSummaryVersion(sessionId: string): SessionSummaryVersion | undefined {
    return this.db
      .select()
      .from(sessionSummaryVersions)
      .where(eq(sessionSummaryVersions.sessionId, sessionId))
      .orderBy(desc(sessionSummaryVersions.version))
      .limit(1)
      .get();
  }

  /**
   * Unscoped history read for the dashboard's `SUMMARY HISTORY` section,
   * newest first. `limit` bounds the dashboard's page weight
   * (`dashboard`, "The session detail view MUST list the summary version
   * history"); omit it for the full history, used where a test or the
   * invariant needs every row rather than a page of it.
   */
  adminListSummaryVersions(sessionId: string, limit?: number): SessionSummaryVersion[] {
    const query = this.db
      .select()
      .from(sessionSummaryVersions)
      .where(eq(sessionSummaryVersions.sessionId, sessionId))
      .orderBy(desc(sessionSummaryVersions.version))
      .$dynamic();
    return (limit !== undefined ? query.limit(limit) : query).all();
  }

  /** Total version-row count for a session, for the dashboard's "N more" note. */
  adminCountSummaryVersions(sessionId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(sessionSummaryVersions)
      .where(eq(sessionSummaryVersions.sessionId, sessionId))
      .get();
    return row?.value ?? 0;
  }

  /**
   * Scoped history read for `memory.session_get({ limit })` — the model-
   * facing exceptional-use path (`sessions`, "Every curated session-summary
   * write MUST append a version row in the same transaction"). Joins to
   * `sessions` to enforce the caller's `Scope` directly in the query rather
   * than trusting a prior check, matching every other scoped repository
   * read in this codebase.
   */
  listSummaryVersionsInScope(
    sessionId: string,
    scope: Scope,
    limit: number,
  ): SessionSummaryVersion[] {
    return this.db
      .select({
        id: sessionSummaryVersions.id,
        sessionId: sessionSummaryVersions.sessionId,
        version: sessionSummaryVersions.version,
        content: sessionSummaryVersions.content,
        title: sessionSummaryVersions.title,
        createdAt: sessionSummaryVersions.createdAt,
      })
      .from(sessionSummaryVersions)
      .innerJoin(agentSessions, eq(agentSessions.id, sessionSummaryVersions.sessionId))
      .where(
        and(
          eq(sessionSummaryVersions.sessionId, sessionId),
          eq(agentSessions.projectId, scope.projectId),
          isNull(agentSessions.deletedAt),
        ),
      )
      .orderBy(desc(sessionSummaryVersions.version))
      .limit(limit)
      .all();
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
        summaryFinal: agentSessions.summaryFinal,
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
