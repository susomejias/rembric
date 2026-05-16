import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { AgentSessionsService } from './agent-sessions.js';
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
  });
});
