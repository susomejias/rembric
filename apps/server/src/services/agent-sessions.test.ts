import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { AgentSessionsService, SUMMARY_MAX_CHARS } from './agent-sessions.js';
import { ProjectsService } from './projects.js';
import { projectScope, SCOPE_GLOBAL } from './scope.js';
import { TokensService } from './tokens.js';

let db: TestDb;
let sessions: AgentSessionsService;
let projects: ProjectsService;
let tokens: TokensService;
let tokenId: string;
let otherTokenId: string;
let projectId: string;

beforeEach(() => {
  db = createTestDb();
  sessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  projects = new ProjectsService(createRepositories(db.handle.db));
  tokens = new TokensService(createRepositories(db.handle.db));

  tokens.bootstrapAdmin('test-admin-token-with-enough-entropy');
  const admin = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get();
  tokenId = admin!.id;

  const { token: other } = tokens.create({ name: 'other-agent', scope: '*' });
  otherTokenId = other.id;

  projectId = projects.create({ slug: 'lifecycle-tests' }).id;
});

afterEach(() => db.cleanup());

describe('AgentSessionsService', () => {
  it('start inserts an active row with the provided fields', () => {
    const s = sessions.start({
      tokenId,
      projectId,
      agent: 'claude-code',
      description: 'wire the test',
    });
    expect(s.status).toBe('active');
    expect(s.agent).toBe('claude-code');
    expect(s.projectId).toBe(projectId);
    expect(s.description).toBe('wire the test');
    expect(s.endedAt).toBeNull();
    expect(s.summary).toBeNull();
  });

  it('end transitions to ended without writing summary', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    const ended = sessions.end(s.id, { tokenId });
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).not.toBeNull();
    expect(ended.summary).toBeNull();
  });

  it('summarize transitions to ended and persists the summary', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    const updated = sessions.summarize(s.id, {
      tokenId,
      summary: '## Goal\nwrap it up',
    });
    expect(updated.status).toBe('ended');
    expect(updated.summary).toBe('## Goal\nwrap it up');
    expect(updated.endedAt).not.toBeNull();
  });

  it('refuses end from a different token (masks as session_not_found)', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.end(s.id, { tokenId: otherTokenId })).toThrow(/not found/i);
  });

  it('refuses summarize from a different token (masks as session_not_found)', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.summarize(s.id, { tokenId: otherTokenId, summary: 'x' })).toThrow(
      /not found/i,
    );
  });

  it('double-end is idempotent on already-ended sessions', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    const first = sessions.end(s.id, { tokenId });
    expect(first.status).toBe('ended');
    const firstEndedAt = first.endedAt?.getTime();
    // Second end returns the existing row unchanged — no throw, no
    // re-write of ended_at.
    const second = sessions.end(s.id, { tokenId });
    expect(second.status).toBe('ended');
    expect(second.endedAt?.getTime()).toBe(firstEndedAt);
  });

  it('summarize rejects an empty summary string', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.summarize(s.id, { tokenId, summary: '   ' })).toThrow(/non-empty/);
  });

  describe('summary length cap (SUMMARY_MAX_CHARS)', () => {
    const tooLong = 'a'.repeat(SUMMARY_MAX_CHARS + 1);
    const cap = String(SUMMARY_MAX_CHARS);

    it('writeSummary rejects a summary longer than the cap and leaves the row unchanged', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'claude' });
      expect(() => sessions.writeSummary(s.id, { tokenId, summary: tooLong, final: true })).toThrow(
        cap,
      );
      const after = sessions.getById(s.id);
      expect(after?.summary).toBeNull();
      expect(after?.summaryFinal).toBe(false);
    });

    it('writeSummary accepts a summary of exactly the cap', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'claude' });
      const updated = sessions.writeSummary(s.id, {
        tokenId,
        summary: 'a'.repeat(SUMMARY_MAX_CHARS),
        final: true,
      });
      expect(updated.summary?.length).toBe(SUMMARY_MAX_CHARS);
      expect(updated.summaryFinal).toBe(true);
    });

    it('end rejects oversized summary atomically with the transition', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'claude' });
      expect(() => sessions.end(s.id, { tokenId, summary: tooLong })).toThrow(cap);
      const after = sessions.getById(s.id);
      expect(after?.status).toBe('active');
      expect(after?.endedAt).toBeNull();
      expect(after?.summary).toBeNull();
    });

    it('summarize (legacy wrapper) inherits the cap', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'claude' });
      expect(() => sessions.summarize(s.id, { tokenId, summary: tooLong })).toThrow(cap);
      const after = sessions.getById(s.id);
      expect(after?.status).toBe('active');
    });
  });

  describe('truncateSummary helper', () => {
    it('returns input unchanged when within the cap', async () => {
      const { truncateSummary, SUMMARY_MAX_CHARS } = await import('./agent-sessions.js');
      expect(truncateSummary('hi')).toBe('hi');
      expect(truncateSummary('a'.repeat(SUMMARY_MAX_CHARS))).toHaveLength(SUMMARY_MAX_CHARS);
    });

    it('truncates oversize input with the …[truncated] suffix and lands at exactly the cap', async () => {
      const { truncateSummary, SUMMARY_MAX_CHARS } = await import('./agent-sessions.js');
      const out = truncateSummary('a'.repeat(SUMMARY_MAX_CHARS + 1000));
      expect(out.length).toBe(SUMMARY_MAX_CHARS);
      expect(out.endsWith('…[truncated]')).toBe(true);
    });

    it('never leaves a lone high surrogate when the cut lands inside an emoji', async () => {
      const { truncateSummary, SUMMARY_MAX_CHARS } = await import('./agent-sessions.js');
      const cutPoint = SUMMARY_MAX_CHARS - '…[truncated]'.length;
      const s = 'a'.repeat(cutPoint - 1) + '😀' + 'a'.repeat(2000);
      const out = truncateSummary(s);
      const content = out.slice(0, out.length - '…[truncated]'.length);
      const lastCode = content.charCodeAt(content.length - 1);
      const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
    });
  });

  describe('truncateTitle helper', () => {
    it('returns input unchanged when within the cap', async () => {
      const { truncateTitle } = await import('./agent-sessions.js');
      expect(truncateTitle('hi')).toBe('hi');
      expect(truncateTitle('t'.repeat(100))).toHaveLength(100);
    });

    it('hard-cuts oversize input with no suffix', async () => {
      const { truncateTitle } = await import('./agent-sessions.js');
      const out = truncateTitle('t'.repeat(150));
      expect(out).toBe('t'.repeat(100));
    });

    it('drops a whole emoji rather than splitting its surrogate pair at the boundary', async () => {
      const { truncateTitle } = await import('./agent-sessions.js');
      const out = truncateTitle('t'.repeat(99) + '😀');
      expect(out).toBe('t'.repeat(99));
    });
  });

  it('findActiveForTransport returns the sole active session for the pair', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    const found = sessions.findActiveForTransport({ tokenId, projectId });
    expect(found?.id).toBe(a.id);
  });

  it('findActiveForTransport returns null when the token has no active session', () => {
    expect(sessions.findActiveForTransport({ tokenId, projectId })).toBeNull();
  });

  it('findActiveForTransport returns null (never guesses) when TWO active sessions match — concurrency is genuinely ambiguous', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    const b = sessions.start({ tokenId, projectId, agent: 'b' });
    const found = sessions.findActiveForTransport({ tokenId, projectId });
    expect(found).toBeNull();
    // Neither session was silently (and possibly wrongly) chosen.
    expect(found?.id).not.toBe(a.id);
    expect(found?.id).not.toBe(b.id);
  });

  it('abandonStale flips old active rows to abandoned', () => {
    const old = sessions.start({ tokenId, projectId, agent: 'old' });
    // Backdate BOTH started_at and last_activity_at by 48h via raw SQL so
    // abandonStale (keyed on COALESCE(last_activity_at, started_at) since
    // fix-audited-defects) picks it up — a stale started_at alone no longer
    // qualifies a row whose last_activity_at is recent.
    const oldTs = Date.now() - 2 * 24 * 3600 * 1000;
    db.handle.raw
      .prepare(`UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?`)
      .run(oldTs, oldTs, old.id);

    const result = sessions.abandonStale({ olderThanMs: 24 * 3600 * 1000 });
    expect(result.abandoned).toBe(1);
    expect(sessions.getById(old.id)?.status).toBe('abandoned');
  });

  it('abandonStale does NOT reap a session with a stale started_at but recent activity (fix-audited-defects)', () => {
    const longRunning = sessions.start({ tokenId, projectId, agent: 'long-running' });
    // started_at is old (48h ago) but last_activity_at is recent — this is a
    // genuinely still-live session (long-running work), not a zombie, and
    // must survive the reap.
    db.handle.raw
      .prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`)
      .run(Date.now() - 2 * 24 * 3600 * 1000, longRunning.id);

    const result = sessions.abandonStale({ olderThanMs: 24 * 3600 * 1000 });
    expect(result.abandoned).toBe(0);
    expect(sessions.getById(longRunning.id)?.status).toBe('active');
  });

  it('countByStatus returns counts grouped by status, scoped to the given project', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    sessions.start({ tokenId, projectId, agent: 'b' });
    sessions.end(a.id, { tokenId });
    const counts = sessions.countByStatus(projectScope(projectId));
    expect(counts.active).toBe(1);
    expect(counts.ended).toBe(1);
    expect(counts.abandoned).toBe(0);
  });

  it('countByStatus excludes soft-deleted rows to match list() visibility', () => {
    const visible = sessions.start({ tokenId, projectId, agent: 'visible' });
    const hidden = sessions.start({ tokenId, projectId, agent: 'hidden' });
    sessions.softDelete(hidden.id, { adminBypass: true });

    const counts = sessions.countByStatus(projectScope(projectId));
    expect(counts.active).toBe(1);
    expect(counts.ended).toBe(0);
    expect(counts.abandoned).toBe(0);
    expect(visible.id).toBeDefined();
  });

  it("countByStatus does not count another project's sessions (fix-audited-defects)", () => {
    const otherProjectId = projects.create({ slug: 'other-project' }).id;
    sessions.start({ tokenId, projectId, agent: 'a' });
    sessions.start({ tokenId, projectId: otherProjectId, agent: 'b' });

    const counts = sessions.countByStatus(projectScope(projectId));
    expect(counts.active).toBe(1);
  });

  it('countByStatus(SCOPE_GLOBAL) does not count project-scoped sessions', () => {
    sessions.start({ tokenId, projectId: null, agent: 'global-agent' });
    sessions.start({ tokenId, projectId, agent: 'project-agent' });

    const counts = sessions.countByStatus(SCOPE_GLOBAL);
    expect(counts.active).toBe(1);
  });

  it('adminCountByStatus is server-wide, unlike the scoped countByStatus', () => {
    sessions.start({ tokenId, projectId, agent: 'a' });
    const otherProjectId = projects.create({ slug: 'yet-another-project' }).id;
    sessions.start({ tokenId, projectId: otherProjectId, agent: 'b' });

    expect(sessions.countByStatus(projectScope(projectId)).active).toBe(1);
    expect(sessions.adminCountByStatus().active).toBe(2);
  });

  describe('soft-delete', () => {
    it('softDelete sets deleted_at and hides the row from default list', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'to-delete' });
      const deleted = sessions.softDelete(s.id, { adminBypass: true });
      expect(deleted.deletedAt).toBeInstanceOf(Date);

      const visible = sessions.list();
      expect(visible.some((r) => r.id === s.id)).toBe(false);
      const all = sessions.list({ includeDeleted: true });
      expect(all.some((r) => r.id === s.id)).toBe(true);

      // findById is unfiltered; the detail view must still resolve.
      expect(sessions.getById(s.id)?.deletedAt).toBeInstanceOf(Date);
    });

    it('softDelete is idempotent on double-call', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'idempotent' });
      const first = sessions.softDelete(s.id, { adminBypass: true });
      const second = sessions.softDelete(s.id, { adminBypass: true });
      expect(second.id).toBe(first.id);
      expect(second.deletedAt?.getTime()).toBe(first.deletedAt?.getTime());
    });

    it('undelete clears deleted_at and the row re-appears in the default list', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'restore' });
      sessions.softDelete(s.id, { adminBypass: true });
      const restored = sessions.undelete(s.id, { adminBypass: true });
      expect(restored.deletedAt).toBeNull();
      expect(sessions.list().some((r) => r.id === s.id)).toBe(true);
    });

    it('softDelete without adminBypass requires the owning token', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'cross-token' });
      expect(() => sessions.softDelete(s.id, { tokenId: otherTokenId })).toThrow(
        /belongs to a different token/,
      );
      // owning token can soft-delete without adminBypass
      const deleted = sessions.softDelete(s.id, { tokenId });
      expect(deleted.deletedAt).toBeInstanceOf(Date);
    });

    it('recentForContext never returns deleted rows', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'context' });
      sessions.softDelete(s.id, { adminBypass: true });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('softDelete on a missing id throws session_not_found', () => {
      expect(() => sessions.softDelete('not-a-real-ulid', { adminBypass: true })).toThrow(
        /not found/,
      );
    });
  });

  describe('markAbandoned', () => {
    it('flips an active row to abandoned with ended_at', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'to-abandon' });
      const abandoned = sessions.markAbandoned(s.id, { tokenId });
      expect(abandoned.status).toBe('abandoned');
      expect(abandoned.endedAt).toBeInstanceOf(Date);
    });

    it('is idempotent on already-abandoned rows', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'idempotent-abandon' });
      const first = sessions.markAbandoned(s.id, { tokenId });
      const second = sessions.markAbandoned(s.id, { tokenId });
      expect(second.id).toBe(first.id);
      expect(second.endedAt?.getTime()).toBe(first.endedAt?.getTime());
    });

    it('rejects ended sessions with session_already_ended', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'already-ended' });
      sessions.end(s.id, { tokenId });
      expect(() => sessions.markAbandoned(s.id, { tokenId })).toThrow(/already ended/);
    });

    it('rejects cross-token callers without adminBypass', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'cross-token' });
      expect(() => sessions.markAbandoned(s.id, { tokenId: otherTokenId })).toThrow(
        /belongs to a different token/,
      );
      expect(sessions.getById(s.id)?.status).toBe('active');
    });

    it('accepts cross-token callers when adminBypass is true', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'admin-abandon' });
      const abandoned = sessions.markAbandoned(s.id, { adminBypass: true });
      expect(abandoned.status).toBe('abandoned');
      expect(abandoned.endedAt).toBeInstanceOf(Date);
    });

    it('throws session_not_found for unknown ids', () => {
      expect(() => sessions.markAbandoned('does-not-exist', { adminBypass: true })).toThrow(
        /not found/,
      );
    });
  });

  describe('late summary/title writes on terminal rows', () => {
    const START = new Date('2026-01-01T00:00:00.000Z');
    const LATE = new Date('2026-01-03T12:00:00.000Z');

    let repos: ReturnType<typeof createRepositories>;
    let clock: Date;
    let svc: AgentSessionsService;

    beforeEach(() => {
      repos = createRepositories(db.handle.db);
      clock = START;
      svc = new AgentSessionsService(repos, db.handle.db, () => clock);
    });

    /** Terminal row at START, clock advanced to LATE so a stray activity stamp shows up. */
    function terminalSession(
      status: 'ended' | 'abandoned',
      opts: { curatedSummary?: boolean } = {},
    ) {
      const s = svc.start({ tokenId, projectId, agent: 'claude' });
      if (opts.curatedSummary) {
        svc.writeSummary(s.id, { tokenId, summary: 'curated', final: true });
      }
      const row =
        status === 'ended'
          ? svc.end(s.id, { tokenId })
          : svc.markAbandoned(s.id, { tokenId, adminBypass: true });
      clock = LATE;
      return row;
    }

    for (const status of ['abandoned', 'ended'] as const) {
      it(`writeSummary on a ${status} row writes summary and title, leaving lifecycle columns untouched`, () => {
        const before = terminalSession(status);
        const updated = svc.writeSummary(before.id, {
          tokenId,
          summary: 'late but curated',
          title: 'Fix the reaper',
          final: true,
        });
        expect(updated.summary).toBe('late but curated');
        expect(updated.summaryFinal).toBe(true);
        expect(updated.title).toBe('Fix the reaper');
        expect(updated.titleFinal).toBe(true);
        expect(updated.status).toBe(status);
        expect(updated.endedAt?.getTime()).toBe(before.endedAt?.getTime());
        expect(updated.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());

        const stored = svc.getById(before.id);
        expect(stored?.summary).toBe('late but curated');
        expect(stored?.status).toBe(status);
        expect(stored?.endedAt?.getTime()).toBe(before.endedAt?.getTime());
        expect(stored?.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());
      });

      it(`writeSummary on a ${status} row applies per-field precedence: the curated summary survives a final:false sync, the title still lands`, () => {
        const before = terminalSession(status, { curatedSummary: true });
        const updated = svc.writeSummary(before.id, {
          tokenId,
          summary: 'raw transcript dump',
          title: 'hook fallback title',
          final: false,
        });
        expect(updated.summary).toBe('curated');
        expect(updated.summaryFinal).toBe(true);
        expect(updated.title).toBe('hook fallback title');
        expect(updated.titleFinal).toBe(false);
        expect(updated.status).toBe(status);
        expect(updated.endedAt?.getTime()).toBe(before.endedAt?.getTime());
        expect(updated.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());
      });

      it(`writeSummary on a ${status} row emits no UPDATE when precedence blocks every field`, () => {
        const before = terminalSession(status, { curatedSummary: true });
        const spy = vi.spyOn(repos.agentSessions, 'updateById');
        const updated = svc.writeSummary(before.id, {
          tokenId,
          summary: 'raw transcript dump',
          final: false,
        });
        expect(spy).not.toHaveBeenCalled();
        expect(updated).toEqual(before);
        spy.mockRestore();
      });
    }

    it('end on an abandoned row writes the summary without promoting the status', () => {
      const before = terminalSession('abandoned');
      const updated = svc.end(before.id, { tokenId, summary: 'closing notes', final: true });
      expect(updated.summary).toBe('closing notes');
      expect(updated.summaryFinal).toBe(true);
      expect(updated.status).toBe('abandoned');
      expect(updated.endedAt?.getTime()).toBe(before.endedAt?.getTime());
      expect(updated.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());
    });

    it('writeSummary rejects an oversized summary on a terminal row (cap is checked before status)', () => {
      const before = terminalSession('abandoned');
      expect(() =>
        svc.writeSummary(before.id, {
          tokenId,
          summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1),
          final: true,
        }),
      ).toThrow(String(SUMMARY_MAX_CHARS));
      expect(svc.getById(before.id)).toEqual(before);
    });

    it('writeSummary on a terminal row owned by another token is still masked as session_not_found', () => {
      const before = terminalSession('abandoned');
      expect(() =>
        svc.writeSummary(before.id, { tokenId: otherTokenId, summary: 'not mine', final: true }),
      ).toThrow(/not found/i);
      expect(svc.getById(before.id)).toEqual(before);
    });

    it('a late curated summary on an abandoned row reaches recentForContext', () => {
      const before = terminalSession('abandoned');
      expect(svc.recentForContext({ projectId })).toEqual([]);
      svc.writeSummary(before.id, { tokenId, summary: 'late but curated', final: true });
      expect(svc.recentForContext({ projectId }).map((r) => r.id)).toEqual([before.id]);
    });
  });

  describe('ensure (client-provided id)', () => {
    it('inserts a new row with the provided id and returns created: true', () => {
      const { session, created } = sessions.ensure({
        id: 'sess-abc12345',
        tokenId,
        projectId,
        agent: 'claude-code',
      });
      expect(created).toBe(true);
      expect(session.id).toBe('sess-abc12345');
      expect(session.tokenId).toBe(tokenId);
      expect(session.status).toBe('active');
    });

    it('is idempotent for the same (tokenId, id) — returns existing row with created: false', () => {
      const first = sessions.ensure({
        id: 'sess-idempo-1',
        tokenId,
        projectId,
        agent: 'claude',
      });
      const second = sessions.ensure({
        id: 'sess-idempo-1',
        tokenId,
        projectId,
        agent: 'claude',
      });
      expect(second.created).toBe(false);
      expect(second.session.id).toBe(first.session.id);
      expect(second.session.startedAt.getTime()).toBe(first.session.startedAt.getTime());
      const all = sessions.list({ includeDeleted: true }).filter((r) => r.id === 'sess-idempo-1');
      expect(all).toHaveLength(1);
    });

    it('rejects cross-token id collision with id_collision', () => {
      sessions.ensure({ id: 'shared-id-12345', tokenId, projectId, agent: 'a' });
      expect(() =>
        sessions.ensure({
          id: 'shared-id-12345',
          tokenId: otherTokenId,
          projectId,
          agent: 'b',
        }),
      ).toThrow(/already in use by a different token/);
      const original = sessions.getById('shared-id-12345');
      expect(original?.tokenId).toBe(tokenId);
    });

    it('rejects malformed ids', () => {
      const bad = ['x', 'has spaces', 'has\nnewlines', 'A'.repeat(129), ''];
      for (const id of bad) {
        expect(() => sessions.ensure({ id, tokenId, projectId, agent: 'a' })).toThrow(
          /id must match/,
        );
      }
    });

    it('accepts UUID-, ULID-, and prefixed-id formats', () => {
      const ids = [
        '550e8400-e29b-41d4-a716-446655440000',
        '01HXC9Z8H8R8RVV3M9CWY2J5RM',
        'claude-2026-05-15-abc123',
      ];
      for (const id of ids) {
        const result = sessions.ensure({ id, tokenId, projectId, agent: 'a' });
        expect(result.created).toBe(true);
      }
    });
  });

  describe('purgeEmpty', () => {
    /** Helper: end a session and backdate its ended_at past the grace period. */
    function endAndBackdate(sessionId: string, ageMs: number): void {
      sessions.end(sessionId, { tokenId });
      db.handle.raw
        .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
        .run(Date.now() - ageMs, sessionId);
    }

    it('purges ended sessions with no referencing rows past the grace period', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'empty' });
      endAndBackdate(s.id, 2 * 60 * 60 * 1000);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).toContain(s.id);
      expect(sessions.getById(s.id)).toBeUndefined();
    });

    it('writes a session_purge op to consolidation_ops with the deleted ids', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'journal' });
      endAndBackdate(s.id, 2 * 60 * 60 * 1000);

      sessions.purgeEmpty({ adminBypass: true });

      const ops = db.handle.raw
        .prepare(`SELECT op_type, affected_ids, reasoning FROM consolidation_ops`)
        .all() as { op_type: string; affected_ids: string; reasoning: string }[];
      const purgeOp = ops.find((o) => o.op_type === 'session_purge');
      expect(purgeOp).toBeDefined();
      const affected = JSON.parse(purgeOp!.affected_ids) as string[];
      expect(affected).toContain(s.id);
      expect(purgeOp!.reasoning).toMatch(/operator purge of empty sessions/);
    });

    it('skips sessions still within the 1-hour grace period', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'fresh' });
      endAndBackdate(s.id, 10 * 60 * 1000);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
      expect(sessions.getById(s.id)).toBeDefined();
    });

    it('skips sessions that are still active', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'active' });
      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
      expect(sessions.getById(s.id)?.status).toBe('active');
    });

    it('skips soft-deleted sessions (operator intent preserved)', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'soft-deleted' });
      endAndBackdate(s.id, 2 * 60 * 60 * 1000);
      sessions.softDelete(s.id, { adminBypass: true });

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
      expect(sessions.getById(s.id)).toBeDefined();
    });

    it('skips sessions with a summary written', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'with-summary' });
      sessions.summarize(s.id, { tokenId, summary: 'this session did something' });
      db.handle.raw
        .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
        .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
    });

    it('does not purge a session with a genuine but uncurated summary (summary_final=0)', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'raw-summary-purge' });
      sessions.writeSummary(s.id, { tokenId, summary: 'raw transcript dump', final: false });
      endAndBackdate(s.id, 2 * 60 * 60 * 1000);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
      expect(sessions.getById(s.id)).toBeDefined();
    });

    it('skips sessions referenced by a memory row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'with-memory' });
      // Stamp a memory row referencing this session.
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, title, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'mem title', 'x', 'active', '[]', ?, ?)`,
        )
        .run('mem-purge-test-001', projectId, Date.now(), s.id);
      endAndBackdate(s.id, 2 * 60 * 60 * 1000);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
    });

    it('returns an empty list when nothing is eligible (no-op)', () => {
      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).toEqual([]);
    });

    it('writes no consolidation_ops row on a zero-delete call', () => {
      sessions.purgeEmpty({ adminBypass: true });
      const ops = db.handle.raw
        .prepare(`SELECT COUNT(*) AS v FROM consolidation_ops WHERE op_type = 'session_purge'`)
        .get() as { v: number };
      expect(ops.v).toBe(0);
    });

    it('throws forbidden when adminBypass is not strictly true', () => {
      expect(() => sessions.purgeEmpty({ adminBypass: false as unknown as true })).toThrow(
        /adminBypass:true required/,
      );
      expect(() => sessions.purgeEmpty({} as unknown as { adminBypass: true })).toThrow(
        /adminBypass:true required/,
      );
    });

    it('preserves byte-identical behavior after the predicate refactor (3-fixture parity)', () => {
      const empty = sessions.start({ tokenId, projectId, agent: 'empty' });
      endAndBackdate(empty.id, 2 * 60 * 60 * 1000);

      const withMemory = sessions.start({ tokenId, projectId, agent: 'with-memory' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, title, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'mem title', 'x', 'active', '[]', ?, ?)`,
        )
        .run('mem-parity-test-001', projectId, Date.now(), withMemory.id);
      endAndBackdate(withMemory.id, 2 * 60 * 60 * 1000);

      const withSummary = sessions.start({ tokenId, projectId, agent: 'with-summary' });
      sessions.summarize(withSummary.id, { tokenId, summary: 'did the thing' });
      db.handle.raw
        .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
        .run(Date.now() - 2 * 60 * 60 * 1000, withSummary.id);

      expect(sessions.countPurgeableEmpty()).toBe(1);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).toEqual([empty.id]);
      expect(sessions.getById(empty.id)).toBeUndefined();
      expect(sessions.getById(withMemory.id)).toBeDefined();
      expect(sessions.getById(withSummary.id)).toBeDefined();
    });
  });

  describe('recentForContext content filter (sessionHasContent predicate)', () => {
    function newSessionId(suffix: string): string {
      return `sess-content-${suffix}-${Date.now()}`;
    }

    it('excludes an empty active session with no anchored content', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'empty-active' });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('includes a session that has a summary written', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-summary' });
      sessions.summarize(s.id, { tokenId, summary: 'goal: x' });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('excludes a session with only a raw, uncurated summary (summary_final=0)', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'raw-summary-only' });
      sessions.writeSummary(s.id, { tokenId, summary: 'raw transcript dump', final: false });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('includes a session with an uncurated summary but an anchored memory row (clause 3)', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'raw-summary-plus-memory' });
      sessions.writeSummary(s.id, { tokenId, summary: 'raw transcript dump', final: false });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, title, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'mem title', 'x', 'active', '[]', ?, ?)`,
        )
        .run(newSessionId('mem-raw'), projectId, Date.now(), s.id);
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('includes a session with title_final = 1 even without a summary', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-title-final' });
      db.handle.raw
        .prepare('UPDATE sessions SET title = ?, title_final = 1 WHERE id = ?')
        .run('locked title', s.id);
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('includes a session referenced by at least one memory row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-memory' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, title, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'mem title', 'x', 'active', '[]', ?, ?)`,
        )
        .run(newSessionId('mem'), projectId, Date.now(), s.id);
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('includes a session referenced by at least one prompt row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-prompt' });
      db.handle.raw
        .prepare(
          `INSERT INTO prompts (id, session_id, project_id, content, title, agent, created_at)
           VALUES (?, ?, ?, 'do the thing', 'do the thing', 'claude', ?)`,
        )
        .run(newSessionId('p'), s.id, projectId, Date.now());
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('includes a session referenced by at least one confirmation row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-confirmation' });
      const memoryId = newSessionId('mem-for-conf');
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, title, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'mem title', 'x', 'active', '[]', ?, NULL)`,
        )
        .run(memoryId, projectId, Date.now());
      db.handle.raw
        .prepare(
          `INSERT INTO confirmations (id, memory_id, event_ts, source, session_id)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(newSessionId('c'), memoryId, Date.now(), s.id);
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('filter-then-truncate: backfills past newer empty sessions', () => {
      const useful = sessions.start({ tokenId, projectId, agent: 'useful-old' });
      sessions.summarize(useful.id, { tokenId, summary: 'older but useful' });

      // Three empty sessions started AFTER `useful`. Backdating started_at
      // via raw SQL to guarantee ordering on fast machines.
      const now = Date.now();
      for (let i = 1; i <= 3; i++) {
        const e = sessions.start({ tokenId, projectId, agent: `empty-${i}` });
        db.handle.raw
          .prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
          .run(now + i * 1000, e.id);
      }
      db.handle.raw
        .prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
        .run(now - 60_000, useful.id);

      const recent = sessions.recentForContext({ projectId, limit: 1 });
      expect(recent).toHaveLength(1);
      expect(recent[0]?.id).toBe(useful.id);
    });

    it('soft-deleted session with content is still excluded', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'deleted-with-content' });
      sessions.summarize(s.id, { tokenId, summary: 'had value, then deleted' });
      sessions.softDelete(s.id, { adminBypass: true });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });
  });

  describe('a closed row does not lose its curated handoff', () => {
    it('a second final write cannot replace a final summary on a terminal row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'handoff' });
      sessions.writeSummary(s.id, { tokenId, summary: 'the real handoff', final: true });
      sessions.end(s.id, { tokenId });

      // A resumed or zombie client re-summarising the same host session id.
      sessions.writeSummary(s.id, { tokenId, summary: 'clobbered by a resume', final: true });
      expect(sessions.getById(s.id)?.summary).toBe('the real handoff');
    });

    it('but an active row still takes last-final-wins', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'live' });
      sessions.writeSummary(s.id, { tokenId, summary: 'first', final: true });
      sessions.writeSummary(s.id, { tokenId, summary: 'second', final: true });
      expect(sessions.getById(s.id)?.summary).toBe('second');
    });

    it('a soft-deleted terminal row rejects the write instead of mutating', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'gone' });
      sessions.markAbandoned(s.id, { adminBypass: true });
      sessions.softDelete(s.id, { adminBypass: true });

      expect(() => sessions.writeSummary(s.id, { tokenId, summary: 'late', final: true })).toThrow(
        /soft-deleted/,
      );
      expect(sessions.getById(s.id)?.summary).toBeNull();
    });
  });

  // Runtime rather than grep: a mutation test showed a counting invariant over
  // `requireActive: false` passes when a revival is added inside the terminal
  // write path itself. Driving every mutating verb is the only form that fails.
  describe('terminal rows are terminal', () => {
    function terminal(status: 'ended' | 'abandoned'): string {
      const s = sessions.start({ tokenId, projectId, agent: `t-${status}` });
      if (status === 'ended') sessions.end(s.id, { tokenId });
      else sessions.markAbandoned(s.id, { adminBypass: true });
      return s.id;
    }

    for (const status of ['ended', 'abandoned'] as const) {
      it(`no verb moves a ${status} row back to active or rewrites ended_at`, () => {
        const id = terminal(status);
        const before = sessions.getById(id)!;

        const verbs: (() => unknown)[] = [
          () => sessions.writeSummary(id, { tokenId, summary: 'late raw', final: false }),
          () => sessions.writeSummary(id, { tokenId, summary: 'late curated', final: true }),
          () => sessions.writeSummary(id, { tokenId, title: 'late title', final: true }),
          () => sessions.end(id, { tokenId }),
          () => sessions.end(id, { tokenId, summary: 'late via end', final: true }),
          () => sessions.summarize(id, { tokenId, summary: 'late via summarize' }),
          () => sessions.markAbandoned(id, { adminBypass: true }),
          () => sessions.touchActivity(id),
          () => sessions.abandonStale({ olderThanMs: 0 }),
        ];
        for (const verb of verbs) {
          try {
            verb();
          } catch {
            /* a refusal is fine; a mutation is not */
          }
          const row = sessions.getById(id)!;
          expect(row.status).toBe(before.status);
          expect(row.endedAt?.getTime()).toBe(before.endedAt?.getTime());
        }
      });
    }
  });
});
