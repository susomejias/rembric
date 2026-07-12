import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { AgentSessionsService, SUMMARY_MAX_CHARS } from './agent-sessions.js';
import { ProjectsService } from './projects.js';
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
  });

  it('findActiveForTransport returns the most recent active session for the pair', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    // Sleep so b's startedAt > a's startedAt.
    const b = sessions.start({ tokenId, projectId, agent: 'b' });
    const found = sessions.findActiveForTransport({ tokenId, projectId });
    expect(found?.id).toBe(b.id);
    expect(found?.id).not.toBe(a.id);
  });

  it('findActiveForTransport returns null when the token has no active session', () => {
    expect(sessions.findActiveForTransport({ tokenId, projectId })).toBeNull();
  });

  it('abandonStale flips old active rows to abandoned', () => {
    const old = sessions.start({ tokenId, projectId, agent: 'old' });
    // Backdate started_at by 48h via raw SQL so abandonStale picks it up.
    db.handle.raw
      .prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`)
      .run(Date.now() - 2 * 24 * 3600 * 1000, old.id);

    const result = sessions.abandonStale({ olderThanMs: 24 * 3600 * 1000 });
    expect(result.abandoned).toBe(1);
    expect(sessions.getById(old.id)?.status).toBe('abandoned');
  });

  it('countByStatus returns counts grouped by status', () => {
    const a = sessions.start({ tokenId, projectId, agent: 'a' });
    sessions.start({ tokenId, projectId, agent: 'b' });
    sessions.end(a.id, { tokenId });
    const counts = sessions.countByStatus();
    expect(counts.active).toBe(1);
    expect(counts.ended).toBe(1);
    expect(counts.abandoned).toBe(0);
  });

  it('countByStatus excludes soft-deleted rows to match list() visibility', () => {
    const visible = sessions.start({ tokenId, projectId, agent: 'visible' });
    const hidden = sessions.start({ tokenId, projectId, agent: 'hidden' });
    sessions.softDelete(hidden.id, { adminBypass: true });

    const counts = sessions.countByStatus();
    expect(counts.active).toBe(1);
    expect(counts.ended).toBe(0);
    expect(counts.abandoned).toBe(0);
    expect(visible.id).toBeDefined();
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

    it('persists bridgeInstanceId on a fresh insert', () => {
      const { session } = sessions.ensure({
        id: 'sess-with-bridge-1',
        tokenId,
        projectId,
        agent: 'opencode',
        bridgeInstanceId: 'bi-42',
      });
      expect(session.bridgeInstanceId).toBe('bi-42');
    });

    it('backfills bridgeInstanceId on an idempotent hit when the first call omitted it', () => {
      sessions.ensure({ id: 'sess-backfill-1', tokenId, projectId, agent: 'opencode' });
      const { session, created } = sessions.ensure({
        id: 'sess-backfill-1',
        tokenId,
        projectId,
        agent: 'opencode',
        bridgeInstanceId: 'bi-later',
      });
      expect(created).toBe(false);
      expect(session.bridgeInstanceId).toBe('bi-later');
    });
  });

  describe('bridgeInstanceId threading on writeSummary/end + findActiveByBridgeInstance', () => {
    it('writeSummary backfills bridgeInstanceId when the session lacks one', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'a' });
      const updated = sessions.writeSummary(s.id, {
        tokenId,
        summary: 'raw transcript',
        final: false,
        bridgeInstanceId: 'bi-summary',
      });
      expect(updated.bridgeInstanceId).toBe('bi-summary');
    });

    it('end backfills bridgeInstanceId when the session lacks one', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'a' });
      const ended = sessions.end(s.id, { tokenId, bridgeInstanceId: 'bi-end' });
      expect(ended.bridgeInstanceId).toBe('bi-end');
    });

    it('end on an already-ended session still backfills bridgeInstanceId', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'a' });
      sessions.end(s.id, { tokenId });
      const second = sessions.end(s.id, { tokenId, bridgeInstanceId: 'bi-late' });
      expect(second.bridgeInstanceId).toBe('bi-late');
    });

    it('findActiveByBridgeInstance resolves the tagged session, scoped to the caller token', () => {
      const a = sessions.ensure({
        id: 'sess-find-bi-a',
        tokenId,
        projectId,
        agent: 'x',
        bridgeInstanceId: 'bi-a',
      });
      sessions.ensure({
        id: 'sess-find-bi-b',
        tokenId: otherTokenId,
        projectId,
        agent: 'x',
        bridgeInstanceId: 'bi-a',
      });

      const found = sessions.findActiveByBridgeInstance({ tokenId, bridgeInstanceId: 'bi-a' });
      expect(found?.id).toBe(a.session.id);
    });

    it('findActiveByBridgeInstance returns null for an unknown instance id', () => {
      expect(
        sessions.findActiveByBridgeInstance({ tokenId, bridgeInstanceId: 'no-such-instance' }),
      ).toBeNull();
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
});
