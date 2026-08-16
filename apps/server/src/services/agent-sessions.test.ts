import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { createTestDb, defaultProjectScope, type TestDb } from '../test/index.js';

import { AgentSessionsService, SUMMARY_MAX_CHARS } from './agent-sessions.js';
import { DomainError } from './errors.js';
import { ProjectsService } from './projects.js';
import { projectScope } from './scope.js';
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
  tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);

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

  it('end with a summary transitions and persists it', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    const updated = sessions.end(s.id, {
      tokenId,
      summary: '## Goal\nwrap it up',
      final: true,
    });
    expect(updated.status).toBe('ended');
    expect(updated.summary).toBe('## Goal\nwrap it up');
    expect(updated.endedAt).not.toBeNull();
  });

  it('refuses end from a different token (masks as session_not_found)', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.end(s.id, { tokenId: otherTokenId })).toThrow(/not found/i);
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

  it('end rejects an empty summary string', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.end(s.id, { tokenId, summary: '   ' })).toThrow(/non-empty/);
    expect(sessions.getById(s.id)?.status).toBe('active');
  });

  it('writeSummary rejects an empty summary string', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude' });
    expect(() => sessions.writeSummary(s.id, { tokenId, summary: '   ' })).toThrow(/non-empty/);
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

    it('the cap applies even when the write is final', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'claude' });
      expect(() => sessions.end(s.id, { tokenId, summary: tooLong, final: true })).toThrow(cap);
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

    it('marks the front and lands at exactly the cap', async () => {
      const { truncateSummary, SUMMARY_MAX_CHARS } = await import('./agent-sessions.js');
      const out = truncateSummary('a'.repeat(SUMMARY_MAX_CHARS + 1000));
      expect(out.length).toBe(SUMMARY_MAX_CHARS);
      expect(out.startsWith('…[truncated]')).toBe(true);
    });

    // The discriminating assertion: length and marker presence pass under BOTH
    // truncation directions, so only the surviving content distinguishes them.
    it('keeps the END of the text and discards the beginning', async () => {
      const { truncateSummary, SUMMARY_MAX_CHARS } = await import('./agent-sessions.js');
      const s = 'HEAD-MARKER' + 'a'.repeat(SUMMARY_MAX_CHARS) + 'TAIL-MARKER';
      const out = truncateSummary(s);
      expect(out.endsWith('TAIL-MARKER')).toBe(true);
      expect(out).not.toContain('HEAD-MARKER');
    });

    it('never leaves a lone low surrogate when the cut lands inside an emoji', async () => {
      const { truncateSummary, SUMMARY_MAX_CHARS, SUMMARY_TRUNCATE_MARKER } =
        await import('./agent-sessions.js');
      // Place the emoji so the tail slice would start between its two units.
      const keep = SUMMARY_MAX_CHARS - SUMMARY_TRUNCATE_MARKER.length;
      const s = 'a'.repeat(2000) + '😀' + 'a'.repeat(keep - 1);
      const out = truncateSummary(s);
      const content = out.slice(SUMMARY_TRUNCATE_MARKER.length);
      const firstCode = content.charCodeAt(0);
      const isLowSurrogate = firstCode >= 0xdc00 && firstCode <= 0xdfff;
      expect(isLowSurrogate).toBe(false);
      expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
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

  it('findActiveForTransport does not depend on row order: the sole match wins even when oldest', () => {
    const oldest = sessions.start({ tokenId, projectId, agent: 'oldest' });
    const newer = sessions.start({ tokenId, projectId, agent: 'newer' });
    // Behind `newer` on both ordering columns, but still inside
    // TRANSPORT_STALENESS_MS so it stays eligible.
    const past = Date.now() - 5 * 60_000;
    db.handle.raw
      .prepare('UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?')
      .run(past, past, oldest.id);
    sessions.end(newer.id, { tokenId, summary: 'done', title: 'done', final: true });

    expect(sessions.findActiveForTransport({ tokenId, projectId })?.id).toBe(oldest.id);
  });

  it('findActiveForTransport still returns null with THREE active matches', () => {
    sessions.start({ tokenId, projectId, agent: 'a' });
    sessions.start({ tokenId, projectId, agent: 'b' });
    sessions.start({ tokenId, projectId, agent: 'c' });
    expect(sessions.findActiveForTransport({ tokenId, projectId })).toBeNull();
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

  it('countByStatus reaches no session without a project — no scope addresses one', () => {
    sessions.start({ tokenId, projectId: null, agent: 'project-less-agent' });
    sessions.start({ tokenId, projectId, agent: 'project-agent' });

    // Control: the project-scoped session IS counted, so the zero below is the
    // predicate rather than an empty table.
    expect(sessions.countByStatus(projectScope(projectId)).active).toBe(1);
    expect(sessions.countByStatus(defaultProjectScope(db.handle)).active).toBe(0);
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
      sessions.end(s.id, { tokenId, summary: 'this session did something', final: true });
      db.handle.raw
        .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
        .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
    });

    it('a session with a non-NULL summary is not purge-eligible, regardless of how it got one', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'with-curated-summary' });
      sessions.end(s.id, { tokenId, summary: 'this session did something', final: true });
      db.handle.raw
        .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
        .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

      expect(sessions.getById(s.id)?.summary).not.toBeNull();

      const result = sessions.purgeEmpty({ adminBypass: true });
      expect(result.deletedIds).not.toContain(s.id);
      expect(sessions.getById(s.id)).toBeDefined();
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
      sessions.end(withSummary.id, { tokenId, summary: 'did the thing', final: true });
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
      sessions.end(s.id, { tokenId, summary: 'goal: x', final: true });
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
      sessions.end(useful.id, { tokenId, summary: 'older but useful', final: true });

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
      sessions.end(s.id, { tokenId, summary: 'had value, then deleted', final: true });
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

  describe('resume', () => {
    const START = new Date('2026-02-01T08:00:00.000Z');
    const LATER = new Date('2026-02-04T09:30:00.000Z');

    let repos: ReturnType<typeof createRepositories>;
    let clock: Date;
    let svc: AgentSessionsService;

    beforeEach(() => {
      repos = createRepositories(db.handle.db);
      clock = START;
      svc = new AgentSessionsService(repos, db.handle.db, () => clock);
    });

    /** Terminal row at START carrying a curated summary and title. */
    function terminal(status: 'ended' | 'abandoned') {
      const s = svc.start({ tokenId, projectId, agent: 'claude', description: 'seeded' });
      svc.writeSummary(s.id, {
        tokenId,
        summary: 'curated handoff',
        title: 'Fix the reaper',
        final: true,
      });
      return status === 'ended'
        ? svc.end(s.id, { tokenId })
        : svc.markAbandoned(s.id, { adminBypass: true });
    }

    function codeOf(fn: () => unknown): string {
      try {
        fn();
      } catch (err) {
        return err instanceof DomainError ? err.code : 'not-a-domain-error';
      }
      return 'no-throw';
    }

    for (const status of ['ended', 'abandoned'] as const) {
      it(`returns a ${status} row to active, clearing ended_at and stamping activity`, () => {
        const before = terminal(status);
        expect(before.endedAt?.getTime()).toBe(START.getTime());
        clock = LATER;

        const resumed = svc.resume(before.id, { tokenId });

        expect(resumed.status).toBe('active');
        expect(resumed.endedAt).toBeNull();
        expect(resumed.lastActivityAt?.getTime()).toBe(LATER.getTime());
        expect(svc.getById(before.id)).toEqual(resumed);
      });
    }

    it('masks another token’s session as session_not_found without mutating it', () => {
      const before = terminal('ended');
      expect(codeOf(() => svc.resume(before.id, { tokenId: otherTokenId }))).toBe(
        'session_not_found',
      );
      expect(svc.getById(before.id)).toEqual(before);
    });

    it('throws session_not_found for an unknown id', () => {
      expect(codeOf(() => svc.resume('does-not-exist', { tokenId }))).toBe('session_not_found');
    });

    it('refuses a soft-deleted row and leaves deleted_at set', () => {
      const before = terminal('abandoned');
      svc.softDelete(before.id, { adminBypass: true });
      const deleted = svc.getById(before.id);
      clock = LATER;

      expect(codeOf(() => svc.resume(before.id, { tokenId }))).toBe('session_deleted');

      const after = svc.getById(before.id);
      expect(after?.deletedAt?.getTime()).toBe(deleted?.deletedAt?.getTime());
      expect(after?.status).toBe('abandoned');
      expect(after?.endedAt?.getTime()).toBe(START.getTime());
      expect(after?.lastActivityAt?.getTime()).toBe(START.getTime());
    });

    it('is a no-op success on an already-active row, emitting no UPDATE', () => {
      const s = svc.start({ tokenId, projectId, agent: 'live' });
      clock = LATER;
      const spy = vi.spyOn(repos.agentSessions, 'updateById');

      const resumed = svc.resume(s.id, { tokenId });

      expect(spy).not.toHaveBeenCalled();
      expect(resumed).toEqual(s);
      expect(resumed.lastActivityAt?.getTime()).toBe(START.getTime());
      spy.mockRestore();
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
      it(`no verb but resume moves a ${status} row back to active or rewrites ended_at`, () => {
        const id = terminal(status);
        const before = sessions.getById(id)!;

        const verbs: (() => unknown)[] = [
          () => sessions.writeSummary(id, { tokenId, summary: 'late raw', final: false }),
          () => sessions.writeSummary(id, { tokenId, summary: 'late curated', final: true }),
          () => sessions.writeSummary(id, { tokenId, title: 'late title', final: true }),
          () => sessions.end(id, { tokenId }),
          () => sessions.end(id, { tokenId, summary: 'late via end', final: true }),
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

    // The ninth verb, asserted positively rather than appended to the refusal
    // list above: it is the one allowed to move `status` and `ended_at`, so
    // every OTHER column is named individually. A count of changed columns
    // would not distinguish "moved three" from "moved three others".
    describe('resume is the one verb that may move them', () => {
      const START = new Date('2026-03-01T07:00:00.000Z');
      const RESUMED_AT = new Date('2026-03-05T18:45:00.000Z');

      let clock: Date;
      let svc: AgentSessionsService;

      beforeEach(() => {
        clock = START;
        svc = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db, () => clock);
      });

      /** Every column non-null before the resume, so identity is not vacuous. */
      function terminalWithContent(status: 'ended' | 'abandoned') {
        const s = svc.start({
          tokenId,
          projectId,
          agent: `t-${status}`,
          description: 'seeded goal',
        });
        svc.writeSummary(s.id, {
          tokenId,
          summary: 'curated handoff',
          title: 'Fix the reaper',
          final: true,
        });
        return status === 'ended'
          ? svc.end(s.id, { tokenId })
          : svc.markAbandoned(s.id, { adminBypass: true });
      }

      for (const status of ['ended', 'abandoned'] as const) {
        it(`moves exactly status, ended_at and last_activity_at on a ${status} row`, () => {
          const before = terminalWithContent(status);
          clock = RESUMED_AT;

          svc.resume(before.id, { tokenId });
          const after = svc.getById(before.id)!;

          expect(before.status).toBe(status);
          expect(after.status).toBe('active');
          expect(before.endedAt?.getTime()).toBe(START.getTime());
          expect(after.endedAt).toBeNull();
          expect(before.lastActivityAt?.getTime()).toBe(START.getTime());
          expect(after.lastActivityAt?.getTime()).toBe(RESUMED_AT.getTime());

          expect(after.id).toBe(before.id);
          expect(after.agent).toBe(before.agent);
          expect(after.tokenId).toBe(before.tokenId);
          expect(after.projectId).toBe(before.projectId);
          expect(after.description).toBe('seeded goal');
          expect(after.description).toBe(before.description);
          expect(after.startedAt.getTime()).toBe(before.startedAt.getTime());
          expect(after.summary).toBe('curated handoff');
          expect(after.summary).toBe(before.summary);
          expect(after.summaryFinal).toBe(true);
          expect(after.summaryFinal).toBe(before.summaryFinal);
          expect(after.title).toBe('Fix the reaper');
          expect(after.title).toBe(before.title);
          expect(after.titleFinal).toBe(true);
          expect(after.titleFinal).toBe(before.titleFinal);
          expect(before.deletedAt).toBeNull();
          expect(after.deletedAt).toBeNull();
        });
      }

      it('does not launder a death: markAbandoned still refuses an ended row, and needs a resume first', () => {
        const before = terminalWithContent('ended');

        expect(() => svc.markAbandoned(before.id, { adminBypass: true })).toThrow(/already ended/);
        expect(svc.getById(before.id)?.status).toBe('ended');

        clock = RESUMED_AT;
        svc.resume(before.id, { tokenId });
        const abandoned = svc.markAbandoned(before.id, { adminBypass: true });

        expect(abandoned.status).toBe('abandoned');
        expect(abandoned.endedAt?.getTime()).toBe(RESUMED_AT.getTime());
        expect(abandoned.endedAt?.getTime()).not.toBe(before.endedAt?.getTime());
      });
    });
  });

  describe('resume, as its consumers see it', () => {
    const START = new Date('2026-04-01T00:00:00.000Z');
    const ABANDON_WINDOW_MS = 24 * 3600 * 1000;
    const LATER = new Date(START.getTime() + 2 * ABANDON_WINDOW_MS);

    let repos: ReturnType<typeof createRepositories>;
    let clock: Date;
    let svc: AgentSessionsService;

    beforeEach(() => {
      repos = createRepositories(db.handle.db);
      clock = START;
      svc = new AgentSessionsService(repos, db.handle.db, () => clock);
    });

    /** Active row that passes `recentForContext`'s curated-summary filter. */
    function curated(agent: string) {
      const s = svc.start({ tokenId, projectId, agent });
      svc.writeSummary(s.id, { tokenId, summary: `${agent} handoff`, title: agent, final: true });
      return s;
    }

    it('survives the very sweep that abandoned it, re-run over the same window', () => {
      const s = svc.start({ tokenId, projectId, agent: 'reaped' });
      clock = LATER;

      expect(svc.abandonStale({ olderThanMs: ABANDON_WINDOW_MS }).abandoned).toBe(1);
      expect(svc.getById(s.id)?.status).toBe('abandoned');

      svc.resume(s.id, { tokenId });

      expect(svc.abandonStale({ olderThanMs: ABANDON_WINDOW_MS }).abandoned).toBe(0);
      const after = svc.getById(s.id);
      expect(after?.status).toBe('active');
      expect(after?.endedAt).toBeNull();
      expect(after?.lastActivityAt?.getTime()).toBe(LATER.getTime());
    });

    it('leaves the purgeable-empty set it was demonstrably in beforehand', () => {
      const s = svc.start({ tokenId, projectId, agent: 'empty' });
      svc.end(s.id, { tokenId });
      clock = LATER;
      const cutoff = LATER.getTime();

      expect(repos.agentSessions.findPurgeableEmptyIds(cutoff)).toEqual([s.id]);
      expect(svc.countPurgeableEmpty()).toBe(1);

      svc.resume(s.id, { tokenId });

      expect(repos.agentSessions.findPurgeableEmptyIds(cutoff)).toEqual([]);
      expect(svc.countPurgeableEmpty()).toBe(0);
    });

    it('appears exactly once in recentForContext, keeping its id and startedAt', () => {
      const s = curated('resumed-once');
      svc.end(s.id, { tokenId });
      clock = LATER;
      svc.resume(s.id, { tokenId });

      const mine = svc.recentForContext({ projectId, limit: 25 }).filter((r) => r.id === s.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.startedAt.getTime()).toBe(START.getTime());
      expect(mine[0]?.status).toBe('active');
      expect(mine[0]?.endedAt).toBeNull();
    });

    // The accepted limitation of `started_at DESC` ordering, pinned positively
    // so it cannot be "fixed" without a change: recency of activity is not the
    // sort key, and a resume does not promote a session.
    it('does not re-sort to the head of recentForContext on resume', () => {
      const older = curated('older-then-resumed');
      svc.end(older.id, { tokenId });
      clock = new Date(START.getTime() + ABANDON_WINDOW_MS);
      const newer = curated('newer');
      clock = LATER;
      svc.resume(older.id, { tokenId });

      expect(svc.recentForContext({ projectId, limit: 25 }).map((r) => r.id)).toEqual([
        newer.id,
        older.id,
      ]);
      expect(svc.getById(older.id)?.startedAt.getTime()).toBe(START.getTime());
    });

    it('markAbandoned still refuses an ended row that was never resumed', () => {
      const s = svc.start({ tokenId, projectId, agent: 'ended-not-resumed' });
      const before = svc.end(s.id, { tokenId });
      clock = LATER;

      let code = 'no-throw';
      try {
        svc.markAbandoned(s.id, { adminBypass: true });
      } catch (err) {
        code = err instanceof DomainError ? err.code : 'not-a-domain-error';
      }
      expect(code).toBe('session_already_ended');

      const after = svc.getById(s.id);
      expect(after?.status).toBe('ended');
      expect(after?.endedAt?.getTime()).toBe(before.endedAt?.getTime());
      expect(after?.lastActivityAt?.getTime()).toBe(before.lastActivityAt?.getTime());
    });
  });

  describe('curated summary section-wise merge', () => {
    let svc: AgentSessionsService;

    beforeEach(() => {
      svc = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
    });

    function curated(summary: string) {
      const s = svc.start({ tokenId, projectId, agent: 'claude' });
      svc.writeSummary(s.id, { tokenId, summary, final: true });
      return s;
    }

    it('a partial write updates one section and preserves the others', () => {
      const s = curated('## Goal\nShip X\n## Files\nsrc/a.ts');
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: '## Files\nsrc/a.ts, src/b.ts',
        final: true,
      });
      expect(updated.summary).toBe('## Goal\nShip X\n## Files\nsrc/a.ts, src/b.ts');
    });

    it('a section the write carries is replaced outright, not appended to', () => {
      const s = curated('## Goal\nShip X');
      const updated = svc.writeSummary(s.id, { tokenId, summary: '## Goal\nShip Y', final: true });
      expect(updated.summary).toBe('## Goal\nShip Y');
      expect(updated.summary).not.toContain('Ship X');
    });

    it('a heading only the write carries is appended after the stored sections', () => {
      const s = curated('## Goal\nShip X\n## Files\nsrc/a.ts');
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: '## Risks\nflaky test',
        final: true,
      });
      expect(updated.summary).toBe('## Goal\nShip X\n## Files\nsrc/a.ts\n## Risks\nflaky test');
    });

    it('shared headings keep the stored order even when the write reorders them', () => {
      const s = curated('## Goal\nA\n## Files\nB');
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: '## Files\nB2\n## Goal\nA2',
        final: true,
      });
      expect(updated.summary).toBe('## Goal\nA2\n## Files\nB2');
    });

    it('heading matching ignores case and surrounding whitespace', () => {
      const s = curated('## Files\nsrc/a.ts');
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: '##   files  \nsrc/b.ts',
        final: true,
      });
      expect(updated.summary).toContain('src/b.ts');
      expect(updated.summary?.match(/^##/gim)).toHaveLength(1);
    });

    it('a `##` line inside a fenced code block is not a section boundary', () => {
      const s = curated('## Files\n```\n## Goal\n```\nsrc/a.ts');
      const updated = svc.writeSummary(s.id, { tokenId, summary: '## Goal\nShip X', final: true });
      expect(updated.summary).toContain('```\n## Goal\n```');
      expect(updated.summary).toContain('## Goal\nShip X');
    });

    it('a section carried with an empty body is stored empty rather than removed', () => {
      const s = curated('## Goal\nA\n## Unfinished+why\nblocked on Y');
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: '## Unfinished+why\n',
        final: true,
      });
      expect(updated.summary).toContain('## Unfinished+why');
      expect(updated.summary).toContain('## Goal\nA');
      expect(updated.summary).not.toContain('blocked on Y');
    });

    it('a `final: false` per-turn sync never merges', () => {
      const s = curated(
        '## Goal\nA\n## Accomplished\nB\n## Decisions+why\nC\n## Verified+how\nD\n## Unfinished+why\nE\n## Files\nF',
      );
      const before = svc.getById(s.id)?.summary;
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: '<raw transcript>',
        final: false,
      });
      expect(updated.summary).toBe(before);
    });

    it('the first curated write over a raw body replaces it whole', () => {
      const s = svc.start({ tokenId, projectId, agent: 'claude' });
      svc.writeSummary(s.id, {
        tokenId,
        summary: 'raw transcript containing a ## line',
        final: false,
      });
      const updated = svc.writeSummary(s.id, { tokenId, summary: '## Goal\nShip X', final: true });
      expect(updated.summary).toBe('## Goal\nShip X');
      expect(updated.summary).not.toContain('raw transcript');
    });

    it('a late curated write to a terminal row is still a silent no-op', () => {
      const s = curated('## Goal\nA\n## Files\nB');
      svc.end(s.id, { tokenId });
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: 'a flat paragraph',
        final: true,
      });
      expect(updated.summary).toBe('## Goal\nA\n## Files\nB');
    });

    it('a late over-cap curated write to a terminal row is still a silent no-op, not invalid_input', () => {
      const s = curated('## Goal\nA\n## Files\nB');
      svc.end(s.id, { tokenId });
      const updated = svc.writeSummary(s.id, {
        tokenId,
        summary: 'a'.repeat(SUMMARY_MAX_CHARS),
        final: true,
      });
      expect(updated.summary).toBe('## Goal\nA\n## Files\nB');
    });

    it('a merge that changes nothing stores the same bytes', () => {
      const s = curated('## Goal\nA\n## Files\nB');
      const updated = svc.writeSummary(s.id, { tokenId, summary: '## Files\nB', final: true });
      expect(updated.summary).toBe('## Goal\nA\n## Files\nB');
    });

    it('merging a document with itself is the identity', () => {
      const doc = '## Goal\nA\n\n### Sub-decision\ndetail\n## Files\n```\ncode\n```\nsrc/a.ts';
      const s = curated(doc);
      const updated = svc.writeSummary(s.id, { tokenId, summary: doc, final: true });
      expect(updated.summary).toBe(doc);
    });

    describe('heading-less write against a sectioned stored summary', () => {
      it('is rejected, naming the missing ## section, without mutating the row', () => {
        const s = curated('## Goal\nA\n## Files\nB');
        expect(() =>
          svc.writeSummary(s.id, {
            tokenId,
            summary: 'Fixed the CI formatting job.',
            final: true,
          }),
        ).toThrow(/##/);
        const after = svc.getById(s.id);
        expect(after?.summary).toBe('## Goal\nA\n## Files\nB');
        expect(after?.summaryFinal).toBe(true);
      });

      it('is accepted against a stored summary with no headings (the control)', () => {
        const s = curated('Goal: A. Files: B.');
        const updated = svc.writeSummary(s.id, {
          tokenId,
          summary: 'Fixed the CI formatting job.',
          final: true,
        });
        expect(updated.summary).toBe('Fixed the CI formatting job.');
      });

      it('a first curated write on an empty session may be free-form', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        const updated = svc.writeSummary(s.id, {
          tokenId,
          summary: 'no headings here',
          final: true,
        });
        expect(updated.summary).toBe('no headings here');
      });

      it('one heading is enough to merge', () => {
        const s = curated(
          '## Goal\nA\n## Accomplished\nB\n## Decisions+why\nC\n## Verified+how\nD\n## Unfinished+why\nE\n## Files\nF',
        );
        const updated = svc.writeSummary(s.id, {
          tokenId,
          summary: '## Accomplished\nDid it',
          final: true,
        });
        expect(updated.summary).toContain('## Accomplished\nDid it');
        expect(updated.summary).toContain('## Goal\nA');
      });
    });

    describe('the merged-document cap', () => {
      it('a within-cap argument whose merge exceeds the cap is rejected, and nothing is truncated', () => {
        const stored = `## Goal\n${'a'.repeat(SUMMARY_MAX_CHARS - 120)}`;
        const s = curated(stored);
        const newSection = `## Risks\n${'b'.repeat(500)}`;
        expect(newSection.length).toBeLessThan(SUMMARY_MAX_CHARS);
        expect(stored.length + newSection.length + 1).toBeGreaterThan(SUMMARY_MAX_CHARS);

        expect(() => svc.writeSummary(s.id, { tokenId, summary: newSection, final: true })).toThrow(
          String(SUMMARY_MAX_CHARS),
        );
        expect(svc.getById(s.id)?.summary).toBe(stored);
      });

      it('a condensed full rewrite always fits, so the rejection cannot wedge a session', () => {
        const stored = `## Goal\n${'a'.repeat(SUMMARY_MAX_CHARS - 20)}`;
        const s = curated(stored);
        const condensed = '## Goal\ncondensed';
        const updated = svc.writeSummary(s.id, { tokenId, summary: condensed, final: true });
        expect(updated.summary).toBe(condensed);
      });
    });

    it('end() merges identically to writeSummary() for the same partial write', () => {
      const s = svc.start({ tokenId, projectId, agent: 'claude' });
      svc.writeSummary(s.id, {
        tokenId,
        summary: '## Goal\nShip X\n## Files\nsrc/a.ts',
        final: true,
      });
      const updated = svc.end(s.id, {
        tokenId,
        summary: '## Files\nsrc/a.ts, src/b.ts',
        final: true,
      });
      expect(updated.summary).toBe('## Goal\nShip X\n## Files\nsrc/a.ts, src/b.ts');
    });
  });

  it('a curated write still stores and reads back end to end after the updateAndVersion collapse', () => {
    const s = sessions.start({ tokenId, projectId, agent: 'claude-code' });
    sessions.writeSummary(s.id, {
      tokenId,
      summary: '## Goal\ncontrol the collapse',
      title: 'Collapse control',
      final: true,
    });

    const row = sessions.getById(s.id);
    expect(row?.summary).toBe('## Goal\ncontrol the collapse');
    expect(row?.title).toBe('Collapse control');
    expect(row?.summaryFinal).toBe(true);
  });

  describe('the nudge-gate timestamps', () => {
    const START = new Date('2026-05-01T00:00:00.000Z');
    let repos: ReturnType<typeof createRepositories>;
    let clock: Date;
    let svc: AgentSessionsService;

    beforeEach(() => {
      repos = createRepositories(db.handle.db);
      clock = START;
      svc = new AgentSessionsService(repos, db.handle.db, () => clock);
    });

    function minutesAfter(base: Date, minutes: number): Date {
      return new Date(base.getTime() + minutes * 60_000);
    }

    describe('last_summary_at — written at the summary precedence site only', () => {
      it('is stamped on a final:true summary write', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 5);
        svc.writeSummary(s.id, { tokenId, summary: '## Goal\nx', final: true });
        expect(svc.getById(s.id)?.lastSummaryAt?.getTime()).toBe(clock.getTime());
      });

      it('is left untouched by a final:false write', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        svc.writeSummary(s.id, { tokenId, summary: 'raw sync', final: false });
        expect(svc.getById(s.id)?.lastSummaryAt).toBeNull();
      });

      it('is left untouched when precedence discards the write (already-final column, incoming final:false)', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        svc.writeSummary(s.id, { tokenId, summary: '## Goal\nfirst', final: true });
        const stampedAt = svc.getById(s.id)?.lastSummaryAt?.getTime();
        clock = minutesAfter(START, 10);
        svc.writeSummary(s.id, { tokenId, summary: 'raw sync ignored', final: false });
        expect(svc.getById(s.id)?.lastSummaryAt?.getTime()).toBe(stampedAt);
      });

      it('cannot be moved backwards by a stale write', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 30);
        svc.writeSummary(s.id, { tokenId, summary: '## Goal\nlater', final: true });
        const later = svc.getById(s.id)?.lastSummaryAt?.getTime();
        clock = minutesAfter(START, 10); // an out-of-order clock read
        svc.end(s.id, { tokenId, summary: '## Goal\nearlier', final: true });
        // end() on an already-final summary column is a no-op for `summary`
        // itself (last-final-wins would replace it on an ACTIVE row — this
        // assertion is about last_summary_at specifically staying forward).
        expect(svc.getById(s.id)!.lastSummaryAt!.getTime()).toBeGreaterThanOrEqual(later!);
      });
    });

    describe('resume leaves all three nudge-gate timestamps alone', () => {
      it('after a report has stamped last_work_at and a notice has stamped last_nudge_at', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        svc.writeSummary(s.id, { tokenId, summary: '## Goal\nx', final: true });
        clock = minutesAfter(START, 30);
        svc.reportTurn(s.id, { tokenId, usedTools: true });
        const before = svc.getById(s.id)!;
        expect(before.lastWorkAt).not.toBeNull();

        svc.end(s.id, { tokenId });
        clock = minutesAfter(START, 60);
        const resumed = svc.resume(s.id, { tokenId });

        expect(resumed.lastWorkAt?.getTime()).toBe(before.lastWorkAt?.getTime());
        expect(resumed.lastSummaryAt?.getTime()).toBe(before.lastSummaryAt?.getTime());
        expect(resumed.lastNudgeAt?.getTime()).toBe(before.lastNudgeAt?.getTime());
      });
    });

    describe('reportTurn', () => {
      it('stamps last_activity_at always and last_work_at only when usedTools', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 1);
        svc.reportTurn(s.id, { tokenId, usedTools: false });
        const afterConvo = svc.getById(s.id)!;
        expect(afterConvo.lastActivityAt?.getTime()).toBe(clock.getTime());
        expect(afterConvo.lastWorkAt).toBeNull();

        clock = minutesAfter(START, 2);
        svc.reportTurn(s.id, { tokenId, usedTools: true });
        const afterWork = svc.getById(s.id)!;
        expect(afterWork.lastWorkAt?.getTime()).toBe(clock.getTime());
      });

      it('a conversation-only session over three hours never returns notice lines', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        for (let h = 0; h <= 180; h += 20) {
          clock = minutesAfter(START, h);
          const { lines } = svc.reportTurn(s.id, { tokenId, usedTools: false });
          expect(lines).toEqual([]);
        }
        expect(svc.getById(s.id)?.lastWorkAt).toBeNull();
      });

      it('writes the provisional title under final:false precedence, once', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        svc.reportTurn(s.id, { tokenId, usedTools: false, title: 'first prompt title' });
        expect(svc.getById(s.id)?.title).toBe('first prompt title');
        expect(svc.getById(s.id)?.titleFinal).toBe(false);

        // A model-authored final:true title is never displaced by a later report.
        svc.writeSummary(s.id, { tokenId, title: 'model title', final: true });
        svc.reportTurn(s.id, { tokenId, usedTools: false, title: 'stale provisional' });
        expect(svc.getById(s.id)?.title).toBe('model title');
      });

      it('fires the notice once work follows a null summary, past the floor, and stamps last_nudge_at', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 26);
        const { lines } = svc.reportTurn(s.id, { tokenId, usedTools: true });
        expect(lines.length).toBeGreaterThan(0);
        expect(svc.getById(s.id)?.lastNudgeAt?.getTime()).toBe(clock.getTime());
      });

      it('does not fire before one floor has elapsed since started_at', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 24);
        expect(svc.reportTurn(s.id, { tokenId, usedTools: true }).lines).toEqual([]);
      });

      it('a summary written after the work suppresses the notice until further work', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 5);
        svc.reportTurn(s.id, { tokenId, usedTools: true });
        clock = minutesAfter(START, 6);
        svc.writeSummary(s.id, { tokenId, summary: '## Goal\ncaught up', final: true });
        clock = minutesAfter(START, 40);
        expect(svc.reportTurn(s.id, { tokenId, usedTools: false }).lines).toEqual([]);
        clock = minutesAfter(START, 41);
        expect(svc.reportTurn(s.id, { tokenId, usedTools: true }).lines.length).toBeGreaterThan(0);
      });

      it('is not repeated inside the floor once emitted, even with continued work', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 26);
        const first = svc.reportTurn(s.id, { tokenId, usedTools: true });
        expect(first.lines.length).toBeGreaterThan(0);

        const nudgedAt = clock;
        for (const m of [1, 5, 10, 15, 20]) {
          clock = minutesAfter(nudgedAt, m);
          const { lines } = svc.reportTurn(s.id, { tokenId, usedTools: true });
          expect(lines).toEqual([]);
        }
      });

      it('a report against a terminal row stamps nothing but last_activity_at and returns no lines', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        clock = minutesAfter(START, 26);
        svc.reportTurn(s.id, { tokenId, usedTools: true }); // arms a notice-eligible state
        svc.end(s.id, { tokenId });
        const before = svc.getById(s.id)!;

        clock = minutesAfter(START, 60);
        const { lines } = svc.reportTurn(s.id, { tokenId, usedTools: true });
        expect(lines).toEqual([]);

        const after = svc.getById(s.id)!;
        expect(after.status).toBe('ended');
        expect(after.endedAt?.getTime()).toBe(before.endedAt?.getTime());
        expect(after.lastWorkAt?.getTime()).toBe(before.lastWorkAt?.getTime());
        expect(after.lastNudgeAt?.getTime()).toBe(before.lastNudgeAt?.getTime());
        expect(after.lastActivityAt?.getTime()).toBe(clock.getTime());
      });

      it('rejects a cross-token report, masked as session_not_found', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        expect(() => svc.reportTurn(s.id, { tokenId: otherTokenId, usedTools: true })).toThrow(
          /not found/i,
        );
      });

      it('rejects a report against a soft-deleted session', () => {
        const s = svc.start({ tokenId, projectId, agent: 'claude' });
        svc.softDelete(s.id, { adminBypass: true });
        expect(() => svc.reportTurn(s.id, { tokenId, usedTools: true })).toThrow(/soft-deleted/);
      });
    });
  });

  describe('NUDGE_FLOOR_MS — the one floor constant in the server tree', () => {
    it('no other `_FLOOR_MS` constant is defined anywhere under apps/server/src', async () => {
      const { execSync } = await import('node:child_process');
      const out = execSync(
        `git grep -n "_FLOOR_MS\\s*=" -- apps/server/src ':(exclude)apps/server/src/**/*.test.ts'`,
        { cwd: new URL('../../../..', import.meta.url).pathname, encoding: 'utf8' },
      );
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('services/agent-sessions.ts');
    });
  });
});
