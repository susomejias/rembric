import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { agentSessions, type AgentSession } from '../db/schema/agent-sessions.js';

import { DomainError } from './errors.js';

/**
 * Service for the agent (MCP) session lifecycle.
 *
 * Append-only contract:
 *   - Never DELETE a row
 *   - Never UPDATE `agent`, `token_id`, `project_id`, `started_at`
 *   - Only flip `status` and write `ended_at` / `summary` once
 *
 * Cross-token access is rejected by `end` and `summarize` (the same
 * token that opened the session must close it) to prevent a misbehaving
 * token from closing another agent's session.
 */

export interface StartSessionInput {
  tokenId: string;
  projectId: string | null;
  agent: string;
  description?: string | null;
}

export interface EndSessionInput {
  tokenId: string;
}

export interface SummarizeSessionInput {
  tokenId: string;
  summary: string;
}

export interface RecentForContextInput {
  /** When provided, filters to `(scope='project', project_id=projectId)`. */
  projectId: string | null;
  limit?: number;
}

export class AgentSessionsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(input: StartSessionInput): AgentSession {
    const ts = this.now();
    const row = this.db
      .insert(agentSessions)
      .values({
        id: ulid(ts.getTime()),
        tokenId: input.tokenId,
        projectId: input.projectId,
        agent: input.agent,
        description: input.description ?? null,
        startedAt: ts,
        endedAt: null,
        summary: null,
        status: 'active',
      })
      .returning()
      .get();
    if (!row) throw new DomainError('conflict', 'sessions.start: insert returned no row');
    return row;
  }

  end(sessionId: string, input: EndSessionInput): AgentSession {
    return this.transitionToEnded(sessionId, input.tokenId, null);
  }

  summarize(sessionId: string, input: SummarizeSessionInput): AgentSession {
    if (input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.summarize: summary must be non-empty');
    }
    return this.transitionToEnded(sessionId, input.tokenId, input.summary);
  }

  getById(sessionId: string): AgentSession | undefined {
    return this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
  }

  /**
   * Find the most recently-started active session for the given
   * `(tokenId, projectId)` pair. Used by the in-process SessionRouter to
   * resolve `(token, project, mcp-session)` → active session.
   */
  findActiveForTransport(input: {
    tokenId: string;
    projectId: string | null;
  }): AgentSession | null {
    const conditions = [
      eq(agentSessions.tokenId, input.tokenId),
      eq(agentSessions.status, 'active'),
    ];
    if (input.projectId === null) {
      conditions.push(isNull(agentSessions.projectId));
    } else {
      conditions.push(eq(agentSessions.projectId, input.projectId));
    }
    const row = this.db
      .select()
      .from(agentSessions)
      .where(and(...conditions))
      .orderBy(desc(agentSessions.startedAt))
      .limit(1)
      .get();
    return row ?? null;
  }

  /** N most recent sessions for the given scope, ordered newest first. */
  recentForContext(input: RecentForContextInput): AgentSession[] {
    const limit = clamp(input.limit ?? 5, 1, 25);
    const baseCondition =
      input.projectId === null
        ? isNull(agentSessions.projectId)
        : eq(agentSessions.projectId, input.projectId);
    return this.db
      .select()
      .from(agentSessions)
      .where(baseCondition)
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit)
      .all();
  }

  /**
   * Mark any `status='active'` row older than `olderThanMs` as abandoned.
   * Called at startup so a crashed/restarted server doesn't leak
   * eternally-active rows.
   */
  abandonStale(input: { olderThanMs: number }): { abandoned: number } {
    const cutoff = new Date(this.now().getTime() - input.olderThanMs);
    const result = this.db
      .update(agentSessions)
      .set({ status: 'abandoned', endedAt: this.now() })
      .where(and(eq(agentSessions.status, 'active'), lt(agentSessions.startedAt, cutoff)))
      .run();
    return { abandoned: result.changes };
  }

  /** Count sessions by status for `memory.stats` / dashboard cards. */
  countByStatus(): Record<'active' | 'ended' | 'abandoned', number> {
    const rows = this.db
      .select({ status: agentSessions.status, count: sql<number>`count(*)` })
      .from(agentSessions)
      .groupBy(agentSessions.status)
      .all();
    const out: Record<'active' | 'ended' | 'abandoned', number> = {
      active: 0,
      ended: 0,
      abandoned: 0,
    };
    for (const row of rows) {
      const k = row.status;
      out[k] = Number(row.count);
    }
    return out;
  }

  /** Total memory rows referencing this session. */
  memoryCount(sessionId: string): number {
    const row = this.db.get<{ v: number }>(
      sql`SELECT COUNT(*) AS v FROM memory WHERE session_id = ${sessionId}`,
    ) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  /**
   * Common helper for `end` + `summarize`. Validates ownership, ensures
   * the session is still active, and writes the transition atomically.
   */
  private transitionToEnded(
    sessionId: string,
    tokenId: string,
    summary: string | null,
  ): AgentSession {
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    // Cross-token access leaks no information about session existence in
    // user-facing errors; we mask with the same code.
    if (existing.tokenId !== tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.status !== 'active') {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' is already ${existing.status}`,
      );
    }
    const ts = this.now();
    const updated = this.db
      .update(agentSessions)
      .set({
        status: 'ended',
        endedAt: ts,
        ...(summary !== null ? { summary } : {}),
      })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'active')))
      .returning()
      .get();
    if (!updated) {
      // Race: another writer ended the session between read and update.
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' was concurrently ended`,
      );
    }
    return updated;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Maintained import for downstream consumers that pull `gt` from drizzle
// when filtering session timestamps.
void gt;
