import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { AgentSessionsService, composeDerivedSummary } from './agent-sessions.js';
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
  sessions = new AgentSessionsService(db.handle.db);
  projects = new ProjectsService(db.handle.db);
  tokens = new TokensService(db.handle.db);

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

    it('skips sessions referenced by a memory row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'with-memory' });
      // Stamp a memory row referencing this session.
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'x', 'active', '[]', ?, ?)`,
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
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'x', 'active', '[]', ?, ?)`,
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

  describe('recentForContext content filter (sessionIsContextWorthy predicate)', () => {
    function newSessionId(suffix: string): string {
      return `sess-content-${suffix}-${Date.now()}`;
    }

    it('excludes an empty active session with no anchored content', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'empty-active' });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('includes a session that has a curated summary written', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-summary' });
      sessions.summarize(s.id, { tokenId, summary: 'goal: x' });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(true);
    });

    it('includes a session with curated summary via writeSummary({final:true})', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-curated' });
      sessions.writeSummary(s.id, { tokenId, summary: 'Goal: x', final: true });
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

    it('excludes a session whose only summary write was final:false (transcript fallback)', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'transcript-only' });
      sessions.writeSummary(s.id, { tokenId, summary: 'raw transcript', final: false });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('excludes a session referenced ONLY by a memory row (memory still surfaces via recentMemories[])', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-memory' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'x', 'active', '[]', ?, ?)`,
        )
        .run(newSessionId('mem'), projectId, Date.now(), s.id);
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('excludes a session referenced ONLY by a prompt row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-prompt' });
      db.handle.raw
        .prepare(
          `INSERT INTO prompts (id, session_id, project_id, content, title, agent, created_at)
           VALUES (?, ?, ?, 'do the thing', 'do the thing', 'claude', ?)`,
        )
        .run(newSessionId('p'), s.id, projectId, Date.now());
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('excludes a session referenced ONLY by a confirmation row', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'has-confirmation' });
      const memoryId = newSessionId('mem-for-conf');
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'x', 'active', '[]', ?, NULL)`,
        )
        .run(memoryId, projectId, Date.now());
      db.handle.raw
        .prepare(
          `INSERT INTO confirmations (id, memory_id, event_ts, source, session_id)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(newSessionId('c'), memoryId, Date.now(), s.id);
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });

    it('filter-then-truncate: backfills past newer non-curated sessions', () => {
      const useful = sessions.start({ tokenId, projectId, agent: 'useful-old' });
      sessions.summarize(useful.id, { tokenId, summary: 'older but useful' });

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

    it('soft-deleted session with curated summary is still excluded', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'deleted-with-content' });
      sessions.summarize(s.id, { tokenId, summary: 'had value, then deleted' });
      sessions.softDelete(s.id, { adminBypass: true });
      const recent = sessions.recentForContext({ projectId, limit: 25 });
      expect(recent.some((r) => r.id === s.id)).toBe(false);
    });
  });

  describe('purge protection vs surfacing asymmetry', () => {
    function newId(suffix: string): string {
      return `asym-${suffix}-${Date.now()}`;
    }

    it('a session with anchored memory but no curated summary surfaces via auto-curate AND stays purge-protected', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'asym' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'memory anchored to uncurated session', 'active', '[]', ?, ?)`,
        )
        .run(newId('mem'), projectId, Date.now(), s.id);

      // Before end(): session is active, summary_final=0, NOT context-worthy yet.
      const recentBefore = sessions.recentForContext({ projectId, limit: 25 });
      expect(recentBefore.some((r) => r.id === s.id)).toBe(false);

      // End the session — auto-curate fires (EXISTS memory).
      sessions.end(s.id, { tokenId });

      // After end(): row now has summary_final=1 with derived summary.
      const after = sessions.getById(s.id);
      expect(after?.summaryFinal).toBe(true);
      expect(after?.summary).toMatch(/^\[auto\] 1 memorias/);

      // (a) Surfacing: NOW context-worthy → IS in recentForContext.
      const recentAfter = sessions.recentForContext({ projectId, limit: 25 });
      expect(recentAfter.some((r) => r.id === s.id)).toBe(true);

      // (b) Purge protection: content-bearing (EXISTS memory) → NOT purgeable
      // even after backdating ended_at past the 1h grace.
      const tenHoursAgo = Date.now() - 10 * 3_600_000;
      db.handle.raw.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(tenHoursAgo, s.id);
      expect(sessions.countPurgeableEmpty()).toBe(0);
    });
  });

  describe('auto-curate at terminal transition', () => {
    function newId(suffix: string): string {
      return `autocur-${suffix}-${Date.now()}`;
    }

    it('end() auto-curates a session with anchored memory and no prior curation', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-memory' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'Fixed null check in handler', 'active', '[]', ?, ?)`,
        )
        .run(newId('m'), projectId, Date.now(), s.id);

      sessions.end(s.id, { tokenId });

      const row = sessions.getById(s.id);
      expect(row?.status).toBe('ended');
      expect(row?.summaryFinal).toBe(true);
      expect(row?.summary).toBe("[auto] 1 memorias — última: 'Fixed null check in handler'");
    });

    it('end() does NOT auto-curate if summary_final is already true', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-curated' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'should not appear', 'active', '[]', ?, ?)`,
        )
        .run(newId('m'), projectId, Date.now(), s.id);
      sessions.writeSummary(s.id, {
        tokenId,
        summary: 'Curated by agent',
        final: true,
      });

      sessions.end(s.id, { tokenId });

      const row = sessions.getById(s.id);
      expect(row?.summary).toBe('Curated by agent');
      expect(row?.summaryFinal).toBe(true);
    });

    it('end() does NOT auto-curate if no anchored content exists', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-empty' });
      sessions.end(s.id, { tokenId });
      const row = sessions.getById(s.id);
      expect(row?.summary).toBeNull();
      expect(row?.summaryFinal).toBe(false);
    });

    it('end() auto-curate counts memories and shows last memory snippet', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-multi' });
      const baseTs = Date.now();
      for (let i = 0; i < 3; i++) {
        db.handle.raw
          .prepare(
            `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
             VALUES (?, 'project', ?, 'user', ?, 'active', '[]', ?, ?)`,
          )
          .run(newId(`m-${i}`), projectId, `memory ${i}`, baseTs + i, s.id);
      }
      sessions.end(s.id, { tokenId });
      const row = sessions.getById(s.id);
      expect(row?.summary).toBe("[auto] 3 memorias — última: 'memory 2'");
    });

    it('end() with prompts only generates prompt-based summary', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-prompts' });
      db.handle.raw
        .prepare(
          `INSERT INTO prompts (id, session_id, project_id, content, title, agent, created_at)
           VALUES (?, ?, ?, 'do the thing', 'do the thing', 'claude', ?)`,
        )
        .run(newId('p'), s.id, projectId, Date.now());
      sessions.end(s.id, { tokenId });
      const row = sessions.getById(s.id);
      expect(row?.summary).toBe('[auto] 1 prompts');
      expect(row?.summaryFinal).toBe(true);
    });

    it('end() ignores soft-deleted prompts in auto-curate counts', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-soft' });
      db.handle.raw
        .prepare(
          `INSERT INTO prompts (id, session_id, project_id, content, title, agent, created_at, deleted_at)
           VALUES (?, ?, ?, 'deleted', 'deleted', 'claude', ?, ?)`,
        )
        .run(newId('p'), s.id, projectId, Date.now(), Date.now());
      sessions.end(s.id, { tokenId });
      const row = sessions.getById(s.id);
      expect(row?.summary).toBeNull();
      expect(row?.summaryFinal).toBe(false);
    });

    it('abandonStale() auto-curates each transitioned session that has anchored content', () => {
      const s1 = sessions.start({ tokenId, projectId, agent: 'autocur-stale-1' });
      const s2 = sessions.start({ tokenId, projectId, agent: 'autocur-stale-2' });
      const baseTs = Date.now();
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'work in s1', 'active', '[]', ?, ?)`,
        )
        .run(newId('m1'), projectId, baseTs, s1.id);
      // s2 has no memories.

      // Backdate so abandonStale picks them up.
      const ancient = baseTs - 10 * 3_600_000;
      db.handle.raw
        .prepare('UPDATE sessions SET started_at = ? WHERE id IN (?, ?)')
        .run(ancient, s1.id, s2.id);

      const result = sessions.abandonStale({ olderThanMs: 3_600_000 });
      expect(result.abandoned).toBe(2);

      const row1 = sessions.getById(s1.id);
      const row2 = sessions.getById(s2.id);
      expect(row1?.status).toBe('abandoned');
      expect(row1?.summary).toBe("[auto] 1 memorias — última: 'work in s1'");
      expect(row1?.summaryFinal).toBe(true);

      expect(row2?.status).toBe('abandoned');
      expect(row2?.summary).toBeNull();
      expect(row2?.summaryFinal).toBe(false);
    });

    it('writeSummary({final:true}) succeeds on an ended (auto-curated) session — agent override', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-override' });
      db.handle.raw
        .prepare(
          `INSERT INTO memory (id, scope, project_id, type, content, status, replaces, created_at, session_id)
           VALUES (?, 'project', ?, 'user', 'auto material', 'active', '[]', ?, ?)`,
        )
        .run(newId('m'), projectId, Date.now(), s.id);
      sessions.end(s.id, { tokenId });

      const auto = sessions.getById(s.id);
      expect(auto?.summary).toMatch(/^\[auto\]/);

      // Agent overrides AFTER end with a curated text.
      const overridden = sessions.writeSummary(s.id, {
        tokenId,
        summary: 'Goal: Refactor X. Files: foo.ts.',
        title: 'Refactor X',
        final: true,
      });
      expect(overridden.summary).toBe('Goal: Refactor X. Files: foo.ts.');
      expect(overridden.title).toBe('Refactor X');
      expect(overridden.summaryFinal).toBe(true);
      expect(overridden.titleFinal).toBe(true);
      expect(overridden.status).toBe('ended');
    });

    it('writeSummary({final:false}) is rejected on an ended session', () => {
      const s = sessions.start({ tokenId, projectId, agent: 'autocur-reject' });
      sessions.end(s.id, { tokenId });
      expect(() =>
        sessions.writeSummary(s.id, {
          tokenId,
          summary: 'should be rejected',
          final: false,
        }),
      ).toThrow(/session_already_ended|already ended/);
    });
  });

  describe('composeDerivedSummary helper', () => {
    it('memories-only template', () => {
      expect(composeDerivedSummary({ memories: 5, prompts: 0, confirmations: 0 }, 'foo')).toBe(
        "[auto] 5 memorias — última: 'foo'",
      );
    });

    it('prompts-only template (no memory snippet)', () => {
      expect(composeDerivedSummary({ memories: 0, prompts: 3, confirmations: 0 }, null)).toBe(
        '[auto] 3 prompts',
      );
    });

    it('confirmations-only template', () => {
      expect(composeDerivedSummary({ memories: 0, prompts: 0, confirmations: 2 }, null)).toBe(
        '[auto] 2 confirmaciones',
      );
    });

    it('mixed counts with snippet', () => {
      expect(
        composeDerivedSummary(
          { memories: 3, prompts: 2, confirmations: 1 },
          'Refactored the auth middleware to use jose',
        ),
      ).toBe(
        "[auto] 3 memorias, 2 prompts, 1 confirmaciones — última: 'Refactored the auth middleware to use jose'",
      );
    });

    it('truncates long memory content at 80 chars', () => {
      const long = 'A'.repeat(200);
      const result = composeDerivedSummary({ memories: 1, prompts: 0, confirmations: 0 }, long);
      expect(result).toMatch(/^\[auto\] 1 memorias — última: 'A{79}…'$/);
    });
  });
});
