import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { agentSessions, type AgentSession } from '../db/schema/agent-sessions.js';
import { consolidationOps, consolidationRuns } from '../db/schema/consolidation.js';

import { DomainError } from './errors.js';

const SESSION_PURGE_GRACE_MS = 3_600_000;
const SESSION_PURGE_REASONING = 'operator purge of empty sessions';

/**
 * Service for the agent (MCP) session lifecycle.
 *
 * Append-only contract:
 *   - Never DELETE a row
 *   - Never UPDATE `agent`, `token_id`, `project_id`, `started_at`
 *   - Only flip `status` and write `ended_at` once
 *   - `summary` and `title` are mutable subject to `final`-flag precedence:
 *     a `final:true` write locks the column; subsequent `final:false`
 *     writes are no-ops; subsequent `final:true` writes replace
 *
 * Cross-token access is rejected by `end`, `summarize`, and `writeSummary`
 * (the same token that opened the session must close it) to prevent a
 * misbehaving token from closing another agent's session.
 */

export interface StartSessionInput {
  tokenId: string;
  projectId: string | null;
  agent: string;
  description?: string | null;
  /** Optional cwd used to compute the placeholder title. */
  cwd?: string | null;
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
  /** Optional cwd used to compute the placeholder title. */
  cwd?: string | null;
}

export interface EnsureSessionResult {
  session: AgentSession;
  /** True for fresh inserts, false for idempotent hits on the same `(tokenId, id)`. */
  created: boolean;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TITLE_MAX_LENGTH = 100;

export interface EndSessionInput {
  tokenId: string;
  /** Optional summary to write atomically with the transition. */
  summary?: string;
  /** Optional title to write atomically with the transition. */
  title?: string;
  /** Precedence flag for summary/title writes. Defaults to false. */
  final?: boolean;
}

export interface SummarizeSessionInput {
  tokenId: string;
  summary: string;
}

export interface WriteSummaryInput {
  tokenId: string;
  summary?: string;
  title?: string;
  /** Precedence flag. Defaults to false. */
  final?: boolean;
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
        title: computePlaceholderTitle(input.cwd ?? null, ts),
        startedAt: ts,
        endedAt: null,
        summary: null,
        summaryFinal: false,
        titleFinal: false,
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
   * UUID/ULID ids; operationally a ~0 probability event).
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
        title: computePlaceholderTitle(input.cwd ?? null, ts),
        startedAt: ts,
        endedAt: null,
        summary: null,
        summaryFinal: false,
        titleFinal: false,
        status: 'active',
      })
      .returning()
      .get();
    if (!row) throw new DomainError('conflict', 'sessions.ensure: insert returned no row');
    return { session: row, created: true };
  }

  /**
   * Write summary/title without transitioning status. Used by the
   * MCP `memory.session_summary` tool (always final:true) and by the
   * Codex per-turn `Stop` HTTP hook (always final:false).
   *
   * Writes are subject to the per-field final precedence: a column whose
   * `_final` flag is already true ignores incoming `final:false` writes
   * and is replaced by incoming `final:true` writes (last-final-wins).
   */
  writeSummary(sessionId: string, input: WriteSummaryInput): AgentSession {
    if (input.summary !== undefined && input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.writeSummary: summary must be non-empty');
    }
    if (input.title !== undefined) {
      if (input.title.length === 0 || input.title.length > TITLE_MAX_LENGTH) {
        throw new DomainError(
          'invalid_input',
          `sessions.writeSummary: title must be 1..${TITLE_MAX_LENGTH} chars`,
        );
      }
    }
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.tokenId !== input.tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.status !== 'active') {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' is already ${existing.status}`,
      );
    }
    const incomingFinal = input.final ?? false;
    const summaryUpdate = applyPrecedence(
      existing.summary,
      existing.summaryFinal,
      input.summary,
      incomingFinal,
    );
    const titleUpdate = applyPrecedence(
      existing.title,
      existing.titleFinal,
      input.title,
      incomingFinal,
    );
    const set: Partial<typeof agentSessions.$inferInsert> = {};
    if (summaryUpdate.changed) {
      set.summary = summaryUpdate.value;
      set.summaryFinal = summaryUpdate.final;
    }
    if (titleUpdate.changed) {
      set.title = titleUpdate.value;
      set.titleFinal = titleUpdate.final;
    }
    if (Object.keys(set).length === 0) {
      return existing;
    }
    const updated = this.db
      .update(agentSessions)
      .set(set)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'active')))
      .returning()
      .get();
    if (!updated) {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' was concurrently ended`,
      );
    }
    return updated;
  }

  end(sessionId: string, input: EndSessionInput): AgentSession {
    if (input.summary !== undefined && input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.end: summary must be non-empty');
    }
    if (input.title !== undefined) {
      if (input.title.length === 0 || input.title.length > TITLE_MAX_LENGTH) {
        throw new DomainError(
          'invalid_input',
          `sessions.end: title must be 1..${TITLE_MAX_LENGTH} chars`,
        );
      }
    }
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.tokenId !== input.tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.status === 'abandoned') {
      throw new DomainError('session_already_ended', `session '${sessionId}' is already abandoned`);
    }
    const incomingFinal = input.final ?? false;
    const summaryUpdate = applyPrecedence(
      existing.summary,
      existing.summaryFinal,
      input.summary,
      incomingFinal,
    );
    const titleUpdate = applyPrecedence(
      existing.title,
      existing.titleFinal,
      input.title,
      incomingFinal,
    );
    if (existing.status === 'ended') {
      const set: Partial<typeof agentSessions.$inferInsert> = {};
      if (summaryUpdate.changed) {
        set.summary = summaryUpdate.value;
        set.summaryFinal = summaryUpdate.final;
      }
      if (titleUpdate.changed) {
        set.title = titleUpdate.value;
        set.titleFinal = titleUpdate.final;
      }
      if (Object.keys(set).length === 0) {
        return existing;
      }
      const updated = this.db
        .update(agentSessions)
        .set(set)
        .where(eq(agentSessions.id, sessionId))
        .returning()
        .get();
      return updated ?? existing;
    }
    const ts = this.now();
    const set: Partial<typeof agentSessions.$inferInsert> = {
      status: 'ended',
      endedAt: ts,
    };
    if (summaryUpdate.changed) {
      set.summary = summaryUpdate.value;
      set.summaryFinal = summaryUpdate.final;
    }
    if (titleUpdate.changed) {
      set.title = titleUpdate.value;
      set.titleFinal = titleUpdate.final;
    }
    const updated = this.db
      .update(agentSessions)
      .set(set)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'active')))
      .returning()
      .get();
    if (!updated) {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' was concurrently ended`,
      );
    }
    return updated;
  }

  /**
   * Back-compat wrapper. New callers SHOULD use `writeSummary` (no
   * transition) followed by `end` (transition) instead. This wrapper
   * stays for in-tree callers that still expect the old combined
   * behaviour; remove in a follow-up change once those are migrated.
   */
  summarize(sessionId: string, input: SummarizeSessionInput): AgentSession {
    if (input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.summarize: summary must be non-empty');
    }
    return this.end(sessionId, {
      tokenId: input.tokenId,
      summary: input.summary,
      final: true,
    });
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
      // Soft-deleted sessions must NOT be surfaced as "the active session
      // for transport" — callers that auto-resolve a sessionId would
      // otherwise stamp memories onto a deleted row.
      isNull(agentSessions.deletedAt),
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

  /**
   * Flip a single `status='active'` row to `abandoned` with `ended_at=now()`.
   *
   * Operator-facing per-id verb (the bulk counterpart is `abandonStale`).
   * Idempotent on already-abandoned rows. Rejects ended rows — the reverse
   * `ended → abandoned` transition is not allowed. Cross-token rule:
   * without `adminBypass`, the caller's `tokenId` must match the row's
   * `token_id`.
   */
  markAbandoned(
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
    if (existing.status === 'abandoned') {
      return existing;
    }
    if (existing.status === 'ended') {
      throw new DomainError('session_already_ended', `session '${sessionId}' is already ended`);
    }
    const ts = this.now();
    const updated = this.db
      .update(agentSessions)
      .set({ status: 'abandoned', endedAt: ts })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'active')))
      .returning()
      .get();
    if (!updated) {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' was concurrently transitioned`,
      );
    }
    return updated;
  }

  /**
   * Count sessions by status for `memory.stats` / dashboard cards.
   *
   * Excludes soft-deleted rows (`deleted_at IS NOT NULL`) so the overview
   * counters stay in lock-step with `list()`, which hides them by default.
   * Without this filter, an operator who soft-deletes an `active` session
   * still sees it counted in `ACTIVE SESSIONS` even though it no longer
   * appears in `/dashboard/sessions`.
   */
  countByStatus(): Record<'active' | 'ended' | 'abandoned', number> {
    const rows = this.db
      .select({ status: agentSessions.status, count: sql<number>`count(*)` })
      .from(agentSessions)
      .where(isNull(agentSessions.deletedAt))
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
   * Count rows that match the empty-session purge predicate.
   *
   * Predicate (in lock-step with `purgeEmpty`):
   *   - status ∈ {ended, abandoned}
   *   - deleted_at IS NULL (operator soft-delete is respected)
   *   - summary IS NULL AND title_final = 0
   *   - ended_at < now − 1h (grace for late summary writes)
   *   - no referencing rows in memory, prompts, confirmations
   */
  countPurgeableEmpty(): number {
    const cutoff = this.now().getTime() - SESSION_PURGE_GRACE_MS;
    const row = this.db.get<{ v: number }>(sql`
      SELECT COUNT(*) AS v FROM sessions s
       WHERE s.status IN ('ended','abandoned')
         AND s.deleted_at IS NULL
         AND s.summary IS NULL
         AND s.title_final = 0
         AND s.ended_at IS NOT NULL
         AND s.ended_at < ${cutoff}
         AND NOT EXISTS (SELECT 1 FROM memory        m WHERE m.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM prompts       p WHERE p.session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM confirmations c WHERE c.session_id = s.id)
    `) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  /**
   * Physically delete sessions matching the empty-session predicate.
   *
   * This is the ONE escape hatch in the otherwise append-only contract
   * for `sessions`. The invariant test (`src/test/invariants.test.ts`)
   * white-lists ONLY this file for `DELETE FROM sessions`. The predicate
   * here MUST stay in lock-step with `countPurgeableEmpty` and with the
   * spec at `openspec/specs/sessions/spec.md::"Sessions MAY be physically
   * purged when empty"`.
   *
   * Journals the deletion in `consolidation_ops` with
   * `op_type='session_purge'` in the same transaction, so the audit trail
   * survives even though the rows themselves are gone.
   */
  purgeEmpty(input: { adminBypass: true }): { deletedIds: string[] } {
    if (input?.adminBypass !== true) {
      throw new DomainError(
        'forbidden',
        'sessions.purgeEmpty: adminBypass:true required (admin-only operation)',
      );
    }
    const ts = this.now();
    const cutoff = ts.getTime() - SESSION_PURGE_GRACE_MS;

    return this.db.transaction((tx): { deletedIds: string[] } => {
      const eligible = tx.all<{ id: string }>(sql`
        SELECT s.id FROM sessions s
         WHERE s.status IN ('ended','abandoned')
           AND s.deleted_at IS NULL
           AND s.summary IS NULL
           AND s.title_final = 0
           AND s.ended_at IS NOT NULL
           AND s.ended_at < ${cutoff}
           AND NOT EXISTS (SELECT 1 FROM memory        m WHERE m.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM prompts       p WHERE p.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM confirmations c WHERE c.session_id = s.id)
      `);
      const deletedIds = eligible.map((r) => r.id);
      if (deletedIds.length === 0) {
        return { deletedIds: [] };
      }

      const placeholders = sql.join(
        deletedIds.map((id) => sql`${id}`),
        sql.raw(', '),
      );
      tx.run(sql`DELETE FROM sessions WHERE id IN (${placeholders})`);

      const runId = ulid(ts.getTime());
      tx.insert(consolidationRuns)
        .values({
          id: runId,
          startedAt: ts,
          finishedAt: ts,
          llmProvider: null,
          llmModel: null,
          scope: 'maintenance',
          summary: JSON.stringify({ kind: 'session_purge', deleted: deletedIds.length }),
        })
        .run();
      tx.insert(consolidationOps)
        .values({
          id: ulid(ts.getTime()),
          consolidationId: runId,
          opType: 'session_purge',
          affectedIds: deletedIds,
          createdId: null,
          reasoning: SESSION_PURGE_REASONING,
          appliedAt: ts,
        })
        .run();

      return { deletedIds };
    });
  }
}

interface PrecedenceResult {
  /** True if the caller should write this field (value/final changed). */
  changed: boolean;
  value: string | null;
  final: boolean;
}

/**
 * Apply the final-flag precedence for a single column.
 *
 * - No incoming value → no change (changed: false).
 * - Incoming non-final write blocked by existing final → no change.
 * - Otherwise → write the new value, lift `_final` to incoming flag's level.
 *   When existing _final=true and incoming final=true, the new value
 *   replaces (last-final-wins).
 */
function applyPrecedence(
  currentValue: string | null,
  currentFinal: boolean,
  incomingValue: string | undefined,
  incomingFinal: boolean,
): PrecedenceResult {
  if (incomingValue === undefined) {
    return { changed: false, value: currentValue, final: currentFinal };
  }
  if (currentFinal && !incomingFinal) {
    return { changed: false, value: currentValue, final: currentFinal };
  }
  return { changed: true, value: incomingValue, final: incomingFinal };
}

/**
 * Build the placeholder title written at row insert.
 *
 * Format: `${basename(cwd) || 'session'} · HH:MM UTC`.
 * Used by `ensure` (HTTP) and `start` (MCP).
 */
export function computePlaceholderTitle(cwd: string | null, now: Date): string {
  const base = cwdBasename(cwd) || 'session';
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mm = now.getUTCMinutes().toString().padStart(2, '0');
  return `${base} · ${hh}:${mm} UTC`;
}

function cwdBasename(cwd: string | null): string {
  if (!cwd) return '';
  const trimmed = cwd.replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Maintained import for downstream consumers that pull `gt` from drizzle
// when filtering session timestamps.
void gt;
