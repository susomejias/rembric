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

/**
 * Input for `ensure()` — the hook-driven path used by the Claude Code /
 * Codex plugin to create or upsert a session by the host's own session id.
 */
export interface EnsureSessionInput {
  /**
   * Client-provided session id (typically the Claude Code or Codex host
   * session id from hook stdin). Must match `^[A-Za-z0-9_-]{8,128}$`.
   */
  id: string;
  tokenId: string;
  projectId: string | null;
  agent: string;
  description?: string | null;
}

export interface EnsureSessionResult {
  session: AgentSession;
  /** True for fresh inserts, false for idempotent hits on the same `(tokenId, id)`. */
  created: boolean;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

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

  /**
   * Hook-driven session creation: the plugin POSTs the host session id
   * (from Claude Code or Codex hook stdin) and the server upserts.
   *
   * Idempotent: when `(id)` already exists for the same token, returns the
   * existing row with `created: false`. When it exists for a different
   * token, rejects with `id_collision` (theoretically possible with non-
   * UUID/ULID ids; operationally a ~0 probability event — see the
   * persistence delta spec in `add-http-session-lifecycle`).
   */
  ensure(input: EnsureSessionInput): EnsureSessionResult {
    if (!SESSION_ID_RE.test(input.id)) {
      throw new DomainError(
        'invalid_input',
        `sessions.ensure: id must match ${SESSION_ID_RE.source}`,
      );
    }
    const existing = this.getById(input.id);
    if (existing) {
      if (existing.tokenId !== input.tokenId) {
        throw new DomainError(
          'id_collision',
          `sessions.ensure: id '${input.id}' is already in use by a different token`,
        );
      }
      return { session: existing, created: false };
    }
    const ts = this.now();
    const row = this.db
      .insert(agentSessions)
      .values({
        id: input.id,
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
    if (!row) throw new DomainError('conflict', 'sessions.ensure: insert returned no row');
    return { session: row, created: true };
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

  /**
   * N most recent sessions for the given scope, ordered newest first.
   * Soft-deleted sessions are NEVER surfaced via this path — memory.context
   * callers must not see them.
   */
  recentForContext(input: RecentForContextInput): AgentSession[] {
    const limit = clamp(input.limit ?? 5, 1, 25);
    const scopeCondition =
      input.projectId === null
        ? isNull(agentSessions.projectId)
        : eq(agentSessions.projectId, input.projectId);
    return this.db
      .select()
      .from(agentSessions)
      .where(and(scopeCondition, isNull(agentSessions.deletedAt)))
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit)
      .all();
  }

  /**
   * Soft-delete a session by setting `deleted_at` to the current time.
   * Idempotent: a second call on an already-deleted row is a no-op that
   * returns the existing row. Cross-token rule: without `adminBypass`,
   * the caller's token must match the session's `token_id`.
   */
  softDelete(
    sessionId: string,
    input: { tokenId?: string; adminBypass?: boolean } = {},
  ): AgentSession {
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (!input.adminBypass) {
      if (!input.tokenId || existing.tokenId !== input.tokenId) {
        throw new DomainError('forbidden', `session '${sessionId}' belongs to a different token`);
      }
    }
    if (existing.deletedAt) {
      return existing;
    }
    const ts = this.now();
    const updated = this.db
      .update(agentSessions)
      .set({ deletedAt: ts })
      .where(eq(agentSessions.id, sessionId))
      .returning()
      .get();
    if (!updated) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    return updated;
  }

  /**
   * Clear `deleted_at`, returning the row to visibility. Admin-only:
   * agent-facing callers do not have access. Idempotent: re-undeleting an
   * already-visible row returns the row as-is.
   */
  undelete(sessionId: string, _input: { adminBypass?: boolean } = {}): AgentSession {
    void _input;
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (!existing.deletedAt) {
      return existing;
    }
    const updated = this.db
      .update(agentSessions)
      .set({ deletedAt: null })
      .where(eq(agentSessions.id, sessionId))
      .returning()
      .get();
    if (!updated) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    return updated;
  }

  /**
   * List sessions ordered newest first. Hides soft-deleted rows by
   * default; pass `includeDeleted: true` to surface them.
   */
  list(
    input: {
      limit?: number;
      status?: 'active' | 'ended' | 'abandoned';
      includeDeleted?: boolean;
    } = {},
  ): AgentSession[] {
    const limit = clamp(input.limit ?? 50, 1, 500);
    const conditions = [];
    if (!input.includeDeleted) {
      conditions.push(isNull(agentSessions.deletedAt));
    }
    if (input.status) {
      conditions.push(eq(agentSessions.status, input.status));
    }
    const query = this.db
      .select()
      .from(agentSessions)
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit);
    return conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();
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
