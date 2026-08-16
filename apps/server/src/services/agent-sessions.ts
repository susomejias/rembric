import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import { type AgentSession, type NewAgentSession } from '../db/schema/agent-sessions.js';

import { DomainError } from './errors.js';
import type { Scope } from './scope.js';
import { evaluateSessionNudge, type SessionNudgeRow } from './session-nudge.js';
import {
  assertNoNul,
  sliceTailWithoutSplittingSurrogatePair,
  sliceWithoutSplittingSurrogatePair,
} from './strings.js';
import { hasAnyHeading, mergeSummarySections } from './summary-sections.js';

const SESSION_PURGE_GRACE_MS = 3_600_000;
const SESSION_PURGE_REASONING = 'operator purge of empty sessions';

/**
 * A minimum interval, not a schedule: condition (2) of the gate means
 * nothing fires without new work, so this bounds the notice from above
 * while work bounds it from below (`session-nudges`, D2). The one floor
 * constant in the server tree — asserted by a grep test.
 */
export const NUDGE_FLOOR_MS = 25 * 60_000;

/** Never move a monotone timestamp backwards. */
function laterOf(existing: Date | null, candidate: Date): Date {
  return existing === null || candidate.getTime() > existing.getTime() ? candidate : existing;
}

/**
 * How stale `last_activity_at` (falling back to `started_at`) must be
 * before `findActiveForTransport` stops considering a row "live". A killed
 * client (SIGKILL/OOM/closed terminal) never advances this again, so once
 * past the window it stops creating false ambiguity for a fresh session on
 * the same (tokenId, projectId) — WITHOUT introducing a recency tiebreak
 * among rows that are both still within the window. See
 * openspec/changes/fix-audited-defects.
 */
export const TRANSPORT_STALENESS_MS = 30 * 60_000;

/**
 * Single source of truth for the maximum length (UTF-16 code units) of
 * `sessions.summary`. Enforced SERVER-SIDE ONLY at: (a) the service layer
 * below via `assertSummaryWithinCap`, (b) the MCP zod schema in
 * `session-tools.ts`, (c) the HTTP handler in `api-router.ts` via
 * `truncateSummary`. There is NO SQLite `CHECK` pinning this value — the
 * `0011` constraint was dropped in `0012_drop_summary_length_check.sql`, so
 * this constant is a tunable: change it here and no table rebuild is needed.
 *
 * The asymmetry between (b) and (c) is deliberate: MCP rejects (the agent
 * retries with a shorter body), HTTP truncates (hook scripts cannot react
 * to an error). See `openspec/specs/sessions/spec.md`.
 */
export const SUMMARY_MAX_CHARS = 10000;

/**
 * Marker PREFIXED by `truncateSummary`. It leads rather than trails because the
 * kept half is the tail: text that begins mid-session is indistinguishable from
 * a whole summary without a signal at the point the reader starts reading.
 */
export const SUMMARY_TRUNCATE_MARKER = '…[truncated]';

/**
 * Returns `s` unchanged when it fits `SUMMARY_MAX_CHARS`; otherwise the MARKER
 * followed by the LAST `SUMMARY_MAX_CHARS - marker.length` chars. Keeping the
 * tail is the load-bearing part: a session's conclusions, final state and
 * unfinished items are at its end, and the plugin already selects the tail
 * before sending — a head-keeping server discarded exactly what it chose.
 *
 * Used by the HTTP layer (where hook scripts cannot retry on rejection) to
 * silently bring oversized bodies under the cap before calling the service.
 * The service itself rejects oversized inputs unconditionally.
 */
export function truncateSummary(s: string): string {
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return (
    SUMMARY_TRUNCATE_MARKER +
    sliceTailWithoutSplittingSurrogatePair(s, SUMMARY_MAX_CHARS - SUMMARY_TRUNCATE_MARKER.length)
  );
}

/** Head-keeping, unlike `truncateSummary`: a label's meaning is at its start. */
export function truncateTitle(s: string): string {
  return s.length <= TITLE_MAX_LENGTH ? s : sliceWithoutSplittingSurrogatePair(s, TITLE_MAX_LENGTH);
}

function assertSummaryWithinCap(callsite: string, summary: string | undefined): void {
  if (summary !== undefined && summary.length > SUMMARY_MAX_CHARS) {
    throw new DomainError(
      'invalid_input',
      `${callsite}: summary must be ≤${SUMMARY_MAX_CHARS} chars (got ${summary.length})`,
    );
  }
}

/**
 * The `title` counterpart of `assertSummaryWithinCap`, at the same layer and
 * with the same `callsite` argument, rather than inside `precedenceSet`: the
 * one write path that never reaches that site is `reportTurn` against a
 * terminal row, which today rejects a bad title and would silently accept one
 * from there.
 */
function assertTitleValid(callsite: string, title: string | undefined): void {
  if (title === undefined) return;
  if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
    throw new DomainError(
      'invalid_input',
      `${callsite}: title must be 1..${TITLE_MAX_LENGTH} chars`,
    );
  }
  assertNoNul(callsite, 'title', title);
}

/**
 * Service for the agent (MCP) session lifecycle.
 *
 * Append-only contract:
 *   - Never DELETE a row
 *   - Never UPDATE `agent`, `token_id`, `project_id`, `started_at`
 *   - Flip `status` only along the FSM, and write `ended_at` once per
 *     terminal transition — `resume` clears it on the way back to `active`
 *   - `summary` and `title` are mutable subject to `final`-flag precedence:
 *     a `final:true` write locks the column; subsequent `final:false`
 *     writes are no-ops; subsequent `final:true` writes replace
 *
 * Cross-token access is rejected by `end` and `writeSummary`
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

export interface ReportTurnInput {
  tokenId: string;
  /** What the CLIENT observed — whether at least one tool was invoked this turn. */
  usedTools: boolean;
  /** Provisional title, sent at most once per session; written under `final:false` precedence. */
  title?: string;
}

export interface ReportTurnResult {
  session: AgentSession;
  /** Empty when the gate does not fire — never a separate null/undefined state. */
  lines: string[];
}

export class AgentSessionsService {
  constructor(
    private readonly repos: Pick<Repositories, 'agentSessions' | 'consolidation'>,
    private readonly tx: TransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(input: StartSessionInput): AgentSession {
    const ts = this.now();
    const row = this.repos.agentSessions.insert({
      id: ulid(ts.getTime()),
      tokenId: input.tokenId,
      projectId: input.projectId,
      agent: input.agent,
      description: input.description ?? null,
      title: computePlaceholderTitle(input.cwd ?? null, ts),
      startedAt: ts,
      endedAt: null,
      lastActivityAt: ts,
      summary: null,
      summaryFinal: false,
      titleFinal: false,
      status: 'active',
    });
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
      // The plugin POSTs this on every turn (session-start/post-compact
      // hooks), so a hit here IS activity — bump it rather than leaving the
      // row's staleness clock stuck at its original insert time.
      this.repos.agentSessions.touchActivity(existing.id, this.now());
      return { session: existing, created: false };
    }
    const ts = this.now();
    const row = this.repos.agentSessions.insert({
      id: input.id,
      tokenId: input.tokenId,
      projectId: input.projectId,
      agent: input.agent,
      description: input.description ?? null,
      title: computePlaceholderTitle(input.cwd ?? null, ts),
      startedAt: ts,
      endedAt: null,
      lastActivityAt: ts,
      summary: null,
      summaryFinal: false,
      titleFinal: false,
      status: 'active',
    });
    if (!row) throw new DomainError('conflict', 'sessions.ensure: insert returned no row');
    return { session: row, created: true };
  }

  /**
   * Explicit activity touch for MCP writes that resolve to a session
   * without going through `writeSummary`/`end` (memory.save,
   * memory.confirm, memory.save_prompt, memory.capture_passive). Best-
   * effort: never throws, so a stale/mid-transition row can't fail the
   * caller's real write.
   */
  touchActivity(sessionId: string): void {
    try {
      this.repos.agentSessions.touchActivity(sessionId, this.now());
    } catch {
      // best-effort — the caller's actual write must not fail over this
    }
  }

  /**
   * Every write that has already decided the row is `active`. The
   * `requireActive` filter can still miss — the row may have been ended
   * between the read and this update — and the miss MUST surface, because
   * the alternative (`?? existing`) silently reports success for a write
   * that never landed. Kept in one place so a fourth such path cannot
   * forget it.
   */
  private updateActiveOrThrow(sessionId: string, set: Partial<NewAgentSession>): AgentSession {
    const updated = this.repos.agentSessions.updateById(sessionId, set, { requireActive: true });
    if (!updated) {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' was concurrently ended`,
      );
    }
    return updated;
  }

  /**
   * The one late-write path for a row that is already `ended` or
   * `abandoned`. */
  private writeTerminalFields(existing: AgentSession, input: PrecedenceInput): AgentSession {
    // No lastActivityAt stamp, unlike the active path: it only drives
    // stale-active retirement and transport resolution, both status='active'.
    // `{ terminal: true }` is the deviation from the active path's
    // last-final-wins: on a closed row the owning process is dead, so a
    // second final write is a resumed or zombie client, and losing a
    // curated handoff is unrecoverable (no `replaces` chain for sessions).
    // First curated value stands — `precedenceSet` blocks any further
    // summary change once `existing.summaryFinal` is already true, which is
    // also what keeps a late heading-less or over-cap write a silent no-op
    // here instead of a merge attempt (D2(3)).
    const set = precedenceSet(existing, input, this.now(), { terminal: true });
    if (existing.titleFinal) {
      delete set.title;
      delete set.titleFinal;
    }
    if (Object.keys(set).length === 0) {
      return existing;
    }
    const updated = this.repos.agentSessions.updateById(existing.id, set, { requireActive: false });
    return updated ?? existing;
  }

  /**
   * Write summary/title without transitioning status. Called by two
   * classes of HTTP writer: the curated path (MCP `memory.session_summary`,
   * always final:true) and the raw per-turn sync path shared by every
   * client's periodic transcript sync (Codex `Stop`, Claude `Stop`, the
   * opencode `chat.message` flush, Hermes `sync_turn` — all final:false).
   *
   * Writes are subject to the per-field final precedence: a column whose
   * `_final` flag is already true ignores incoming `final:false` writes
   * and is replaced by incoming `final:true` writes (last-final-wins).
   */
  writeSummary(sessionId: string, input: WriteSummaryInput): AgentSession {
    if (input.summary !== undefined && input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.writeSummary: summary must be non-empty');
    }
    if (input.summary !== undefined) assertNoNul('sessions.writeSummary', 'summary', input.summary);
    assertSummaryWithinCap('sessions.writeSummary', input.summary);
    assertTitleValid('sessions.writeSummary', input.title);
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.tokenId !== input.tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.deletedAt) {
      throw new DomainError(
        'session_deleted',
        `sessions.writeSummary: session '${sessionId}' was soft-deleted`,
      );
    }
    if (existing.status !== 'active') {
      return this.writeTerminalFields(existing, input);
    }
    // This write path IS activity even when precedence blocks the
    // summary/title change — a per-turn sync hit means the session is live.
    const ts = this.now();
    const set: Partial<NewAgentSession> = {
      lastActivityAt: ts,
      ...precedenceSet(existing, input, ts),
    };
    return this.updateActiveOrThrow(sessionId, set);
  }

  end(sessionId: string, input: EndSessionInput): AgentSession {
    if (input.summary !== undefined && input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.end: summary must be non-empty');
    }
    if (input.summary !== undefined) assertNoNul('sessions.end', 'summary', input.summary);
    assertSummaryWithinCap('sessions.end', input.summary);
    assertTitleValid('sessions.end', input.title);
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.tokenId !== input.tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    // This read is the fresh one: the boundary check ran before an awaited body
    // upload, so only a re-read inside this tick can see a delete that landed
    // in between.
    if (existing.deletedAt) {
      throw new DomainError(
        'session_deleted',
        `sessions.end: session '${sessionId}' was soft-deleted`,
      );
    }
    if (existing.status !== 'active') {
      return this.writeTerminalFields(existing, input);
    }
    const ts = this.now();
    const set: Partial<NewAgentSession> = {
      status: 'ended',
      endedAt: ts,
      lastActivityAt: ts,
      ...precedenceSet(existing, input, ts),
    };
    return this.updateActiveOrThrow(sessionId, set);
  }

  /**
   * The ONLY path back to `active`, reached only by `memory.session_resume`
   * naming the row. `ended` and `abandoned` behave identically: `abandoned`
   * is the steady state for the clients that never post `/end`, and the
   * outcome of stale-active retirement for the rest.
   */
  resume(sessionId: string, input: { tokenId: string }): AgentSession {
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.tokenId !== input.tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    // Read in this tick, like `end`: the tool-boundary gate ran before the
    // request body was awaited and can be stale by now.
    if (existing.deletedAt) {
      throw new DomainError(
        'session_deleted',
        `sessions.resume: session '${sessionId}' was soft-deleted at ${existing.deletedAt.toISOString()}`,
      );
    }
    if (existing.status === 'active') {
      return existing;
    }
    const ts = this.now();
    // `lastActivityAt` is required, not cosmetic: `abandonInactiveSince`
    // compares COALESCE(last_activity_at, started_at) against its cutoff, so
    // an unstamped revival is retired again by the next sweep pass.
    const updated = this.repos.agentSessions.updateById(
      sessionId,
      { status: 'active', endedAt: null, lastActivityAt: ts },
      { requireActive: false },
    );
    if (!updated) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    return updated;
  }

  /**
   * The per-turn ping (`session-nudges`, `http-api`'s `POST /turn`). One
   * service call: stamp `last_activity_at` and `last_turn_report_at` always,
   * `last_work_at` with the reported turn's START when `usedTools`, `title`
   * under `final:false` precedence when present, then evaluate the gate and
   * stamp `last_nudge_at` only when it fires.
   *
   * A terminal row (not lifecycle) stamps ONLY `last_activity_at` and
   * always returns `lines: []` — a report is not a second path back to
   * `active` and SHALL NOT transition `status` or write `summary`.
   */
  reportTurn(sessionId: string, input: ReportTurnInput): ReportTurnResult {
    assertTitleValid('sessions.reportTurn', input.title);
    const existing = this.getById(sessionId);
    if (!existing) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.tokenId !== input.tokenId) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    if (existing.deletedAt) {
      throw new DomainError(
        'session_deleted',
        `sessions.reportTurn: session '${sessionId}' was soft-deleted`,
      );
    }

    const ts = this.now();

    if (existing.status !== 'active') {
      const updated = this.repos.agentSessions.updateById(
        sessionId,
        { lastActivityAt: ts },
        { requireActive: false },
      );
      return { session: updated ?? existing, lines: [] };
    }

    // The provisional title goes through the same single precedence site as
    // the other three write paths (`final:false`, so a model-authored title
    // is never displaced) rather than re-deriving the rule here.
    const set: Partial<NewAgentSession> = {
      lastActivityAt: ts,
      lastTurnReportAt: ts,
      ...precedenceSet(existing, { title: input.title }, ts),
    };
    if (input.usedTools) {
      // The turn's START, not `now`: the report lands after the mid-turn
      // `memory.session_summary`, so `now` would put work strictly after the
      // summary on every summary-writing turn and condition (2) could never
      // suppress. The start is the PREVIOUS report's arrival, read here
      // before this one overwrites it — `last_activity_at` cannot serve,
      // because the transcript sync and every attached memory write advance
      // it mid-turn (`session-nudges`, D1a).
      //
      // `laterOf` is the only thing keeping `last_work_at` monotone: the
      // anchor is a wall-clock reading, so an NTP step backwards between two
      // reports would otherwise move it back.
      set.lastWorkAt = laterOf(
        existing.lastWorkAt,
        existing.lastTurnReportAt ?? existing.startedAt,
      );
    }
    const row = this.updateActiveOrThrow(sessionId, set);

    const gateRow: SessionNudgeRow = {
      startedAt: row.startedAt,
      lastWorkAt: row.lastWorkAt,
      lastSummaryAt: row.lastSummaryAt,
      lastNudgeAt: row.lastNudgeAt,
      summary: row.summary,
      title: row.title,
    };
    const lines = evaluateSessionNudge(gateRow, ts, NUDGE_FLOOR_MS, SUMMARY_MAX_CHARS);
    if (lines === null) {
      return { session: row, lines: [] };
    }
    const stamped = this.repos.agentSessions.updateById(
      sessionId,
      { lastNudgeAt: laterOf(row.lastNudgeAt, ts) },
      { requireActive: false },
    );
    return { session: stamped ?? row, lines };
  }

  getById(sessionId: string): AgentSession | undefined {
    return this.repos.agentSessions.getById(sessionId);
  }

  /**
   * Resolve the active session for `(tokenId, projectId)` when exactly one
   * unambiguous candidate exists. Used by the in-process SessionRouter to
   * resolve `(token, project, mcp-session)` → active session.
   *
   * Excludes rows whose last activity is older than `TRANSPORT_STALENESS_MS`
   * — a session killed without SessionEnd never advances that clock again,
   * so it stops creating false ambiguity for a fresh session on the same
   * transport once stale, while two genuinely concurrent LIVE sessions
   * still correctly refuse to resolve (see `sessions/spec.md`'s
   * "findActiveForTransport MUST NOT guess under concurrent ambiguity").
   */
  findActiveForTransport(input: {
    tokenId: string;
    projectId: string | null;
  }): AgentSession | null {
    // Soft-deleted sessions must NOT surface here — auto-resolution would
    // otherwise stamp memories onto a deleted row.
    const activeSinceMs = this.now().getTime() - TRANSPORT_STALENESS_MS;
    return (
      this.repos.agentSessions.findActiveForTransport(
        input.tokenId,
        input.projectId,
        activeSinceMs,
      ) ?? null
    );
  }

  /**
   * N most recent sessions for the given scope, ordered newest first.
   * Soft-deleted sessions and empty sessions (those failing the shared
   * `sessionHasContent` predicate) are NEVER surfaced via this path —
   * memory.context callers must not see noise. Filter-then-truncate
   * semantics: empty sessions do not consume slots, so a `limit:N`
   * request returns the N most-recent USEFUL sessions even if dozens of
   * newer empties exist between them.
   */
  recentForContext(input: RecentForContextInput): AgentSession[] {
    const limit = clamp(input.limit ?? 5, 1, 25);
    return this.repos.agentSessions.recentForContext(input.projectId, limit);
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
    const updated = this.repos.agentSessions.updateById(
      sessionId,
      { deletedAt: this.now() },
      { requireActive: false },
    );
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
    const updated = this.repos.agentSessions.updateById(
      sessionId,
      { deletedAt: null },
      { requireActive: false },
    );
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
    return this.repos.agentSessions.list({
      limit,
      status: input.status,
      includeDeleted: input.includeDeleted,
    });
  }

  /**
   * Mark any `status='active'` row whose last activity predates
   * `olderThanMs` as abandoned. Called at startup (so a crashed/restarted
   * server doesn't leak eternally-active rows) AND periodically on an
   * interval (so a zombie session doesn't have to wait for a restart to be
   * reclaimed) — see openspec/changes/fix-audited-defects.
   */
  abandonStale(input: { olderThanMs: number }): { abandoned: number } {
    const cutoff = new Date(this.now().getTime() - input.olderThanMs);
    const abandoned = this.repos.agentSessions.abandonInactiveSince(cutoff, this.now());
    return { abandoned };
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
    const updated = this.repos.agentSessions.updateById(
      sessionId,
      { status: 'abandoned', endedAt: this.now() },
      { requireActive: true },
    );
    if (!updated) {
      throw new DomainError(
        'session_already_ended',
        `session '${sessionId}' was concurrently transitioned`,
      );
    }
    return updated;
  }

  /**
   * Count sessions by status, scoped to the caller's `Scope` — REQUIRED so a
   * scope-less call is a compile error, not a naming-convention oversight
   * (see openspec/changes/fix-audited-defects). This is what `memory.stats`
   * MUST call.
   *
   * Excludes soft-deleted rows (`deleted_at IS NOT NULL`) so the overview
   * counters stay in lock-step with `list()`, which hides them by default.
   */
  countByStatus(scope: Scope): Record<'active' | 'ended' | 'abandoned', number> {
    const projectId = scope.projectId;
    return toStatusRecord(this.repos.agentSessions.countByStatusInScope(projectId));
  }

  /**
   * Unscoped, server-wide session counts. Callable ONLY from the dashboard
   * layer and `memory.doctor` (whose global `sessions.active` is a
   * deliberate spec exception — `mcp-api/spec.md`) — never from a per-
   * request MCP tool. Naming the boundary in the method name is not the
   * enforcement mechanism here; `countByStatus` requiring a `Scope` is.
   */
  adminCountByStatus(): Record<'active' | 'ended' | 'abandoned', number> {
    return toStatusRecord(this.repos.agentSessions.adminCountByStatus());
  }

  memoryCount(sessionId: string): number {
    return this.repos.agentSessions.memoryCount(sessionId);
  }

  /**
   * Count rows that match the empty-session purge predicate.
   *
   * Predicate (in lock-step with `purgeEmpty`):
   *   - status ∈ {ended, abandoned}
   *   - deleted_at IS NULL (operator soft-delete is respected)
   *   - NOT sessionHasContent(s) — i.e. no summary, no title_final,
   *     no referencing memory/prompts/confirmations
   *   - ended_at < now − 1h (grace for late summary writes)
   */
  countPurgeableEmpty(): number {
    const cutoff = this.now().getTime() - SESSION_PURGE_GRACE_MS;
    return this.repos.agentSessions.countPurgeableEmpty(cutoff);
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

    return this.tx.transaction((): { deletedIds: string[] } => {
      const deletedIds = this.repos.agentSessions.findPurgeableEmptyIds(cutoff);
      if (deletedIds.length === 0) {
        return { deletedIds: [] };
      }

      this.repos.agentSessions.purgeByIds(deletedIds);

      const runId = ulid(ts.getTime());
      this.repos.consolidation.insertRun({
        id: runId,
        startedAt: ts,
        finishedAt: ts,
        scope: 'maintenance',
        summary: JSON.stringify({ kind: 'session_purge', deleted: deletedIds.length }),
      });
      this.repos.consolidation.insertOp({
        id: ulid(ts.getTime()),
        runId,
        opType: 'session_purge',
        affectedIds: deletedIds,
        createdId: null,
        reasoning: SESSION_PURGE_REASONING,
        appliedAt: ts,
      });

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

type PrecedenceInput = Omit<WriteSummaryInput, 'tokenId'>;

/**
 * The only place per-field `final` precedence is folded into an update
 * `set` — and, since "A curated session-summary write MUST be merged
 * section-wise with the stored summary", the only place the merge, the
 * heading-less rejection and the merged-document cap check run. It is also
 * where `last_summary_at` is stamped, because `session-nudges` puts that
 * stamp on "the same single site that folds per-field `final` precedence
 * into an update `set`": it fires on exactly the writes that store a
 * `final:true` summary, so a write precedence discarded cannot move it.
 *
 * `opts.terminal` carries the terminal-row deviation ("first curated value
 * stands", D2 in this change's design.md): once `existing.summaryFinal` is
 * already true on a terminal row, NO further write changes `summary` —
 * unlike the active path, where a `final:true` write always replaces
 * (last-final-wins) regardless of what was stored. Folding that here,
 * rather than deleting `summary`/`summaryFinal` from the `set` afterward in
 * `writeTerminalFields`, is what keeps a late heading-less or over-cap
 * write on such a row the silent no-op it is today instead of a merge
 * attempt that throws.
 */
function precedenceSet(
  existing: AgentSession,
  input: PrecedenceInput,
  now: Date,
  opts: { terminal: boolean } = { terminal: false },
): Partial<NewAgentSession> {
  const incomingFinal = input.final ?? false;
  const title = applyPrecedence(existing.title, existing.titleFinal, input.title, incomingFinal);

  const summaryLocked = opts.terminal && existing.summaryFinal;
  const summary = summaryLocked
    ? { changed: false, value: existing.summary, final: existing.summaryFinal }
    : applyPrecedence(existing.summary, existing.summaryFinal, input.summary, incomingFinal);

  let summarySet: Partial<NewAgentSession> = {};
  if (summary.changed) {
    const storedSummary = existing.summary;
    const incomingSummary = input.summary;
    // `summary.changed` (the enclosing `if`) already forces `incomingFinal`
    // true whenever `existing.summaryFinal` is true — `applyPrecedence`
    // blocks a non-final incoming write against an already-final column —
    // so D2(1) ("incoming final:true") needs no separate check here.
    const isCuratedMerge =
      incomingSummary !== undefined && existing.summaryFinal && storedSummary !== null;
    // Reaching here means precedence already decided the value WILL be
    // stored, so the only remaining condition on the stamp is that the write
    // is the curated one.
    const stamp = summary.final ? { lastSummaryAt: laterOf(existing.lastSummaryAt, now) } : {};
    if (isCuratedMerge && storedSummary !== null && incomingSummary !== undefined) {
      if (!hasAnyHeading(incomingSummary) && hasAnyHeading(storedSummary)) {
        throw new DomainError(
          'invalid_input',
          'sessions: summary has no ## section, but the stored summary already uses the canonical ## Markdown structure (## Goal, ## Accomplished, ## Decisions+why, ## Verified+how, ## Unfinished+why, ## Files) — include at least one ## heading to merge, or call memory.session_get to read what is stored',
        );
      }
      const merged = mergeSummarySections(storedSummary, incomingSummary);
      if (merged.length > SUMMARY_MAX_CHARS) {
        throw new DomainError(
          'invalid_input',
          `sessions: merged summary would be ${merged.length} characters, exceeding the ${SUMMARY_MAX_CHARS}-character cap — condense the ## sections and resend; read the stored summary with memory.session_get first`,
        );
      }
      summarySet = { summary: merged, summaryFinal: summary.final, ...stamp };
    } else {
      summarySet = { summary: summary.value, summaryFinal: summary.final, ...stamp };
    }
  }

  return {
    ...summarySet,
    ...(title.changed && { title: title.value, titleFinal: title.final }),
  };
}

/**
 * Build the placeholder title written at row insert.
 *
 * Format: `${basename(cwd) || 'session'} · HH:MM UTC`.
 * Used by `ensure` (HTTP) and `start` (MCP).
 *
 * The insert paths do not run their `title` through `assertTitleValid` — the
 * value is server-computed, not caller-supplied — so the cap is honoured
 * here instead. `cwd` reaches this at up to 4096 characters (`api-router`'s
 * schema) and unbounded over MCP, and the basename is the half that gives
 * way: the clock suffix is what tells two sessions in one directory apart.
 */
export function computePlaceholderTitle(cwd: string | null, now: Date): string {
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mm = now.getUTCMinutes().toString().padStart(2, '0');
  const suffix = ` · ${hh}:${mm} UTC`;
  const room = TITLE_MAX_LENGTH - suffix.length;
  const base = cwdBasename(cwd) || 'session';
  return (base.length > room ? sliceWithoutSplittingSurrogatePair(base, room) : base) + suffix;
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

function toStatusRecord(
  rows: { status: 'active' | 'ended' | 'abandoned'; count: number }[],
): Record<'active' | 'ended' | 'abandoned', number> {
  const out: Record<'active' | 'ended' | 'abandoned', number> = {
    active: 0,
    ended: 0,
    abandoned: 0,
  };
  for (const row of rows) out[row.status] = Number(row.count);
  return out;
}
