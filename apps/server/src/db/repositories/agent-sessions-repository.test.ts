import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../../test/db.js';
import { agentSessions, type NewAgentSession } from '../schema/agent-sessions.js';
import { projects } from '../schema/projects.js';
import { tokens } from '../schema/tokens.js';

import { AgentSessionsRepository } from './agent-sessions-repository.js';

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
      // S4 matches agent+status but is soft-deleted — excluded from the
      // non-deleted partition.
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
});

describe('AgentSessionsRepository.findActiveByBridgeInstance', () => {
  let t: TestDb;
  let repo: AgentSessionsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new AgentSessionsRepository(t.handle.db);
    t.handle.db
      .insert(tokens)
      .values([
        { id: 'tk1', name: 'test-1', hash: 'x', scope: '*', createdAt: new Date(500) },
        { id: 'tk2', name: 'test-2', hash: 'y', scope: '*', createdAt: new Date(500) },
      ])
      .run();
  });

  afterEach(() => t.cleanup());

  it('resolves the session tagged with the given bridge instance id', () => {
    t.handle.db
      .insert(agentSessions)
      .values([
        row({
          id: 'S1',
          status: 'active',
          bridgeInstanceId: 'bi-1',
          startedAt: new Date(1_000),
        }),
        row({
          id: 'S2',
          status: 'active',
          bridgeInstanceId: 'bi-2',
          startedAt: new Date(2_000),
        }),
      ])
      .run();

    const found = repo.findActiveByBridgeInstance('tk1', 'bi-1');
    expect(found?.id).toBe('S1');
  });

  it('never resolves a session belonging to a different token', () => {
    t.handle.db
      .insert(agentSessions)
      .values([
        row({
          id: 'S1',
          tokenId: 'tk1',
          status: 'active',
          bridgeInstanceId: 'bi-shared',
          startedAt: new Date(1_000),
        }),
      ])
      .run();

    expect(repo.findActiveByBridgeInstance('tk2', 'bi-shared')).toBeUndefined();
  });

  it('ignores an ended session even with a matching instance id', () => {
    t.handle.db
      .insert(agentSessions)
      .values([
        row({
          id: 'S1',
          status: 'ended',
          bridgeInstanceId: 'bi-1',
          startedAt: new Date(1_000),
        }),
      ])
      .run();

    expect(repo.findActiveByBridgeInstance('tk1', 'bi-1')).toBeUndefined();
  });

  it('returns undefined when no session carries the given instance id', () => {
    expect(repo.findActiveByBridgeInstance('tk1', 'bi-unknown')).toBeUndefined();
  });
});
