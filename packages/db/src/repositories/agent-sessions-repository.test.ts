import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentSessions,
  AgentSessionsRepository,
  projects,
  tokens,
  type NewAgentSession,
} from '@rembric/db';

import { createTestDb, type TestDb } from '../test-support/db.js';

function row(overrides: Partial<NewAgentSession> & { id: string }): NewAgentSession {
  return {
    tokenId: 'tk1',
    agent: 'claude-code',
    startedAt: new Date(1_000),
    ...overrides,
  };
}

describe('AgentSessionsRepository admin filters', () => {
  let t: TestDb;
  let repo: AgentSessionsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new AgentSessionsRepository(t.handle.db);
    t.handle.db
      .insert(projects)
      .values([{ id: 'p1', slug: 'proj-one', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(tokens)
      .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(agentSessions)
      .values([
        row({ id: 'S1', agent: 'claude-code', status: 'active', startedAt: new Date(1_000) }),
        row({
          id: 'S2',
          agent: 'opencode',
          status: 'ended',
          projectId: 'p1',
          startedAt: new Date(2_000),
        }),
        row({ id: 'S3', agent: 'claude-code', status: 'ended', startedAt: new Date(3_000) }),
        row({
          id: 'S4',
          agent: 'claude-code',
          status: 'active',
          deletedAt: new Date(9_000),
          startedAt: new Date(4_000),
        }),
      ])
      .run();
  });

  afterEach(() => t.cleanup());

  describe('adminList', () => {
    it('filters by projectId (a specific project)', () => {
      const rows = repo.adminList({
        deleted: false,
        activeFirst: false,
        projectId: 'p1',
        limit: 10,
        offset: 0,
      });
      expect(rows.map((r) => r.id)).toEqual(['S2']);
    });

    it('filters by projectId=null (global-only)', () => {
      const rows = repo.adminList({
        deleted: false,
        activeFirst: false,
        projectId: null,
        limit: 10,
        offset: 0,
      });
      expect(rows.map((r) => r.id).sort()).toEqual(['S1', 'S3']);
    });

    it('filters by agent', () => {
      const rows = repo.adminList({
        deleted: false,
        activeFirst: false,
        agent: 'opencode',
        limit: 10,
        offset: 0,
      });
      expect(rows.map((r) => r.id)).toEqual(['S2']);
    });

    it('filters by status', () => {
      const rows = repo.adminList({
        deleted: false,
        activeFirst: false,
        status: 'ended',
        limit: 10,
        offset: 0,
      });
      expect(rows.map((r) => r.id).sort()).toEqual(['S2', 'S3']);
    });

    it('combines agent + status filters', () => {
      const rows = repo.adminList({
        deleted: false,
        activeFirst: false,
        agent: 'claude-code',
        status: 'ended',
        limit: 10,
        offset: 0,
      });
      expect(rows.map((r) => r.id)).toEqual(['S3']);
    });

    it('filters apply only within the requested deleted/non-deleted partition', () => {
      const rows = repo.adminList({
        deleted: false,
        activeFirst: false,
        agent: 'claude-code',
        status: 'active',
        limit: 10,
        offset: 0,
      });
      expect(rows.map((r) => r.id)).toEqual(['S1']);
    });
  });

  describe('adminCount', () => {
    it('mirrors adminList filters exactly, independent of limit/offset', () => {
      expect(repo.adminCount({ deleted: false })).toBe(3);
      expect(repo.adminCount({ deleted: false, projectId: 'p1' })).toBe(1);
      expect(repo.adminCount({ deleted: false, projectId: null })).toBe(2);
      expect(repo.adminCount({ deleted: false, agent: 'claude-code' })).toBe(2);
      expect(repo.adminCount({ deleted: false, status: 'ended' })).toBe(2);
      expect(repo.adminCount({ deleted: true })).toBe(1);
    });
  });

  describe('q filter', () => {
    beforeEach(() => {
      t.handle.db
        .insert(agentSessions)
        .values([
          row({
            id: 'Q1',
            title: 'Deploy pipeline fixes',
            status: 'ended',
            startedAt: new Date(10_000),
          }),
          row({
            id: 'Q2',
            description: 'Investigate flaky tests',
            status: 'ended',
            startedAt: new Date(11_000),
          }),
          row({
            id: 'Q3',
            summary: 'Summarized deployment notes',
            status: 'ended',
            startedAt: new Date(12_000),
          }),
          row({
            id: 'Q4',
            title: 'Unrelated work',
            status: 'ended',
            startedAt: new Date(13_000),
          }),
        ])
        .run();
    });

    it('control: without q the list and count are unchanged', () => {
      expect(repo.adminCount({ deleted: false })).toBe(7);
      expect(
        repo.adminList({ deleted: false, activeFirst: false, limit: 100, offset: 0 }),
      ).toHaveLength(7);
    });

    it('q matches title/description/summary, case-insensitively, and count matches the list', () => {
      const rows = repo.adminList({
        deleted: false,
        q: 'DEPLOY',
        activeFirst: false,
        limit: 100,
        offset: 0,
      });
      expect(rows.map((r) => r.id).sort()).toEqual(['Q1', 'Q3']);
      expect(repo.adminCount({ deleted: false, q: 'DEPLOY' })).toBe(rows.length);

      const described = repo.adminList({
        deleted: false,
        q: 'flaky',
        activeFirst: false,
        limit: 100,
        offset: 0,
      });
      expect(described.map((r) => r.id)).toEqual(['Q2']);
      expect(repo.adminCount({ deleted: false, q: 'flaky' })).toBe(described.length);
    });

    it('q excludes non-matching rows and count is zero', () => {
      expect(
        repo.adminList({
          deleted: false,
          q: 'no-such-keyword',
          activeFirst: false,
          limit: 100,
          offset: 0,
        }),
      ).toEqual([]);
      expect(repo.adminCount({ deleted: false, q: 'no-such-keyword' })).toBe(0);
    });

    it('q combines with the existing filters in both list and count', () => {
      const rows = repo.adminList({
        deleted: false,
        q: 'Deploy',
        agent: 'opencode',
        activeFirst: false,
        limit: 100,
        offset: 0,
      });
      expect(rows).toEqual([]);
      expect(repo.adminCount({ deleted: false, q: 'Deploy', agent: 'opencode' })).toBe(0);
      expect(repo.adminCount({ deleted: false, q: 'Deploy', agent: 'claude-code' })).toBe(2);
    });

    it('escapes LIKE wildcards in q', () => {
      expect(repo.adminCount({ deleted: false, q: '%' })).toBe(0);
      expect(repo.adminCount({ deleted: false, q: '_' })).toBe(0);
    });
  });
});

describe('findSoleActiveForReuse (session_start reuse lookup — no staleness window)', () => {
  let t: TestDb;
  let repo: AgentSessionsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new AgentSessionsRepository(t.handle.db);
    t.handle.db
      .insert(tokens)
      .values([
        { id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) },
        { id: 'other', name: 'other', hash: 'y', scope: '*', createdAt: new Date(500) },
      ])
      .run();
    t.handle.db
      .insert(projects)
      .values([{ id: 'p1', slug: 'proj-one', createdAt: new Date(500) }])
      .run();
  });

  afterEach(() => t.cleanup());

  function insertRow(overrides: Partial<NewAgentSession> & { id: string }) {
    t.handle.db
      .insert(agentSessions)
      .values([row(overrides)])
      .run();
  }

  function backdate(id: string, minutesAgo: number) {
    const past = Date.now() - minutesAgo * 60_000;
    t.handle.raw
      .prepare('UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?')
      .run(past, past, id);
  }

  it('returns the sole active row regardless of staleness', () => {
    insertRow({ id: 'S10', status: 'active', startedAt: new Date(1_000) });
    backdate('S10', 90);
    expect(repo.findSoleActiveForReuse('tk1', null)?.id).toBe('S10');
    // Control: the windowed lookup still refuses the same row.
    expect(repo.findActiveForTransport('tk1', null, Date.now())).toBeUndefined();
  });

  it('returns undefined with two live rows and with three (LIMIT 2 sole-or-nothing, never recency)', () => {
    insertRow({ id: 'SA', status: 'active', startedAt: new Date(1_000) });
    insertRow({ id: 'SB', status: 'active', startedAt: new Date(2_000) });
    expect(repo.findSoleActiveForReuse('tk1', null)).toBeUndefined();
    insertRow({ id: 'SC', status: 'active', startedAt: new Date(3_000) });
    expect(repo.findSoleActiveForReuse('tk1', null)).toBeUndefined();
  });

  it('excludes non-active, soft-deleted and out-of-scope rows', () => {
    insertRow({ id: 'SE', status: 'ended', startedAt: new Date(1_000) });
    expect(repo.findSoleActiveForReuse('tk1', null)).toBeUndefined();
    insertRow({
      id: 'SD',
      status: 'active',
      deletedAt: new Date(2_000),
      startedAt: new Date(2_000),
    });
    expect(repo.findSoleActiveForReuse('tk1', null)).toBeUndefined();
    insertRow({ id: 'SO', status: 'active', tokenId: 'other', startedAt: new Date(3_000) });
    expect(repo.findSoleActiveForReuse('tk1', null)).toBeUndefined();
    insertRow({ id: 'SP', status: 'active', projectId: 'p1', startedAt: new Date(4_000) });
    expect(repo.findSoleActiveForReuse('tk1', 'p1')?.id).toBe('SP');
    expect(repo.findSoleActiveForReuse('tk1', null)).toBeUndefined();
  });
});
