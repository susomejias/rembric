import {
  projectScope,
  type AgentSession,
  type MemoryType,
  type NewAgentSession,
  type Repositories,
  type Scope,
  type TransactionRunner,
} from '@rembric/db';
import { ulid } from 'ulid';

import type { ExtractedEntity } from './entities.js';
import { iterateEntityMatches } from './entity-relevance.js';
import { DomainError } from './errors.js';
import { evaluateSessionNudge, NOTICE_MAX_BYTES, type SessionNudgeRow } from './session-nudge.js';
import {
  assertNoNul,
  sliceTailWithoutSplittingSurrogatePair,
  sliceWithoutSplittingSurrogatePair,
} from './strings.js';
import { hasAnyHeading, mergeSummarySections } from './summary-sections.js';

const SESSION_PURGE_GRACE_MS = 3_600_000;
const SESSION_PURGE_REASONING = 'operator purge of empty sessions';

/** proactive-recall D4: reference memories are factual, not actionable as a hint. */
const RECALL_MEMORY_TYPES: readonly MemoryType[] = ['project', 'feedback', 'procedural'];

const RECALL_ENTITY_PROBE_MAX = 20;

/** proactive-recall D3: bounds `AgentSessionsService`'s recall-dedupe map, LRU-evicted. */
const RECALL_DEDUPE_SESSIONS_MAX = 500;

/** Keyed on `(kind, value)`, not the bare value — the same literal under a different kind is a separate first appearance. */
function recallDedupeKey(entity: ExtractedEntity): string {
  return `${entity.kind}:${entity.value}`;
}

export const NUDGE_FLOOR_MS = 25 * 60_000;

/** Never move a monotone timestamp backwards. */
function laterOf(existing: Date | null, candidate: Date): Date {
  return existing === null || candidate.getTime() > existing.getTime() ? candidate : existing;
}

export const TRANSPORT_STALENESS_MS = 30 * 60_000;

export const SUMMARY_MAX_CHARS = 10000;

export const SUMMARY_TRUNCATE_MARKER = '…[truncated]';

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

export interface StartSessionInput {
  tokenId: string;
  projectId: string | null;
  agent: string;
  description?: string | null;
  /** Optional cwd used to compute the placeholder title. */
  cwd?: string | null;
}

export interface EnsureSessionInput {
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
    private readonly repos: Pick<Repositories, 'agentSessions' | 'consolidation' | 'entities'>,
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

  touchActivity(sessionId: string): void {
    try {
      this.repos.agentSessions.touchActivity(sessionId, this.now());
    } catch {
      // best-effort — the caller's actual write must not fail over this
    }
  }

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

  private writeTerminalFields(
    existing: AgentSession,
    input: PrecedenceInput,
  ): { row: AgentSession; applied: boolean } {
    const set = precedenceSet(existing, input, this.now(), { terminal: true });
    if (existing.titleFinal) {
      delete set.title;
      delete set.titleFinal;
    }
    if (Object.keys(set).length === 0) {
      return { row: existing, applied: false };
    }
    const updated = this.repos.agentSessions.updateById(existing.id, set, { requireActive: false });
    if (!updated) {
      return { row: existing, applied: false };
    }
    return { row: updated, applied: true };
  }

  writeSummary(
    sessionId: string,
    input: WriteSummaryInput,
  ): { row: AgentSession; applied: boolean } {
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
    const ts = this.now();
    const set: Partial<NewAgentSession> = {
      lastActivityAt: ts,
      ...precedenceSet(existing, input, ts),
    };
    return { row: this.updateActiveOrThrow(sessionId, set), applied: true };
  }

  end(sessionId: string, input: EndSessionInput): { row: AgentSession; applied: boolean } {
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
    const row = this.updateActiveOrThrow(sessionId, set);
    this.releaseRecallDedupe(sessionId);
    return { row, applied: true };
  }

  resume(sessionId: string, input: { tokenId: string }): AgentSession {
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
        `sessions.resume: session '${sessionId}' was soft-deleted at ${existing.deletedAt.toISOString()}`,
      );
    }
    if (existing.status === 'active') {
      return existing;
    }
    const ts = this.now();
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

    const set: Partial<NewAgentSession> = {
      lastActivityAt: ts,
      lastTurnReportAt: ts,
      ...precedenceSet(existing, { title: input.title }, ts),
    };
    if (input.usedTools) {
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

  findActiveForTransport(input: {
    tokenId: string;
    projectId: string | null;
  }): AgentSession | null {
    const activeSinceMs = this.now().getTime() - TRANSPORT_STALENESS_MS;
    return (
      this.repos.agentSessions.findActiveForTransport(
        input.tokenId,
        input.projectId,
        activeSinceMs,
      ) ?? null
    );
  }

  findSoleActiveForReuse(input: {
    tokenId: string;
    projectId: string | null;
  }): AgentSession | null {
    return this.repos.agentSessions.findSoleActiveForReuse(input.tokenId, input.projectId) ?? null;
  }

  recentForContext(input: RecentForContextInput): AgentSession[] {
    const limit = clamp(input.limit ?? 5, 1, 25);
    return this.repos.agentSessions.recentForContext(input.projectId, limit);
  }

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
    this.releaseRecallDedupe(sessionId);
    return updated;
  }

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

  abandonStale(input: { olderThanMs: number }): { abandoned: number } {
    const cutoff = new Date(this.now().getTime() - input.olderThanMs);
    const abandoned = this.repos.agentSessions.abandonInactiveSince(cutoff, this.now());
    return { abandoned };
  }

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

  countByStatus(scope: Scope): Record<'active' | 'ended' | 'abandoned', number> {
    const projectId = scope.projectId;
    return toStatusRecord(this.repos.agentSessions.countByStatusInScope(projectId));
  }

  adminCountByStatus(): Record<'active' | 'ended' | 'abandoned', number> {
    return toStatusRecord(this.repos.agentSessions.adminCountByStatus());
  }

  recallHints(sessionId: string, prompt: string): { lines: string[] } {
    // Slice BEFORE any regex runs — bounds ReDoS exposure.
    const snippet = prompt.slice(0, 500);
    if (snippet.length === 0) return { lines: [] };

    const session = this.getById(sessionId);
    if (!session) return { lines: [] };
    if (!session.projectId) return { lines: [] };

    const existing = this.touchRecallDedupe(sessionId);
    const seenInThisTurn = new Set<string>();
    const lines: string[] = [];

    for (const { entity, memories } of iterateEntityMatches(this.repos, {
      scope: projectScope(session.projectId),
      seedText: snippet,
      limit: 2,
      types: RECALL_MEMORY_TYPES,
      status: 'active',
      probeMax: RECALL_ENTITY_PROBE_MAX,
      shouldContinue: () => lines.length < 3,
      skip: (e) => {
        const key = recallDedupeKey(e);
        return existing.has(key) || seenInThisTurn.has(key);
      },
    })) {
      seenInThisTurn.add(recallDedupeKey(entity));
      if (memories.length === 0) continue;
      existing.add(recallDedupeKey(entity));
      const titles = memories.map((m) => m.title).join(', ');
      lines.push(`${entity.value}: ${titles}`);
    }

    while (lines.length > 0 && Buffer.byteLength(lines.join('\n'), 'utf8') > NOTICE_MAX_BYTES) {
      lines.pop();
    }

    return { lines };
  }

  private touchRecallDedupe(sessionId: string): Set<string> {
    const existing = this._recallDedupeState.get(sessionId);
    if (existing) {
      this._recallDedupeState.delete(sessionId);
      this._recallDedupeState.set(sessionId, existing);
      return existing;
    }
    const created = new Set<string>();
    this._recallDedupeState.set(sessionId, created);
    if (this._recallDedupeState.size > RECALL_DEDUPE_SESSIONS_MAX) {
      const oldest = this._recallDedupeState.keys().next().value;
      if (oldest !== undefined) this._recallDedupeState.delete(oldest);
    }
    return created;
  }

  /** Releases a session's recall-dedupe state; called on `end` and `softDelete`. */
  private releaseRecallDedupe(sessionId: string): void {
    this._recallDedupeState.delete(sessionId);
  }

  /** Transient dedupe state: sessionId → Set of `(kind, value)` keys already recalled. */
  private _recallDedupeState = new Map<string, Set<string>>();

  memoryCount(sessionId: string): number {
    return this.repos.agentSessions.memoryCount(sessionId);
  }

  countPurgeableEmpty(): number {
    const cutoff = this.now().getTime() - SESSION_PURGE_GRACE_MS;
    return this.repos.agentSessions.countPurgeableEmpty(cutoff);
  }

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
    const isCuratedMerge =
      incomingSummary !== undefined && existing.summaryFinal && storedSummary !== null;
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
