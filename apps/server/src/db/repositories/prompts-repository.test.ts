import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../../test/db.js';
import { agentSessions } from '../schema/agent-sessions.js';
import { projects } from '../schema/projects.js';
import { prompts, type NewPrompt } from '../schema/prompts.js';
import { tokens } from '../schema/tokens.js';

import { PromptsRepository } from './prompts-repository.js';

function row(overrides: Partial<NewPrompt> & { id: string; content: string }): NewPrompt {
  return {
    title: 'a prompt',
    createdAt: new Date(1_000),
    ...overrides,
  };
}

describe('PromptsRepository', () => {
  let t: TestDb;
  let repo: PromptsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new PromptsRepository(t.handle.db);
    t.handle.db
      .insert(projects)
      .values([{ id: 'p1', slug: 'project-one', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(tokens)
      .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(agentSessions)
      .values([{ id: 'SESSAAA', tokenId: 'tk1', agent: 'claude-code', startedAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(prompts)
      .values([
        row({ id: 'P1', content: 'deploy alpha checklist', createdAt: new Date(1_000) }),
        row({
          id: 'P2',
          content: 'alpha rollback plan',
          projectId: 'p1',
          agent: 'claude-code',
          sessionId: 'SESSAAA',
          createdAt: new Date(2_000),
        }),
        row({
          id: 'P3',
          content: 'deleted alpha note',
          deletedAt: new Date(3_000),
          createdAt: new Date(3_000),
        }),
      ])
      .run();
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('adminSearchFts', () => {
    it('matches including soft-deleted rows', () => {
      const hits = repo.adminSearchFts('alpha', 10, 0);
      expect(hits.map((p) => p.id).sort()).toEqual(['P1', 'P2', 'P3']);
    });

    it('respects limit/offset paging', () => {
      const all = repo.adminSearchFts('alpha', 3, 0).map((p) => p.id);
      const paged = [
        ...repo.adminSearchFts('alpha', 2, 0).map((p) => p.id),
        ...repo.adminSearchFts('alpha', 2, 2).map((p) => p.id),
      ];
      expect(paged.sort()).toEqual([...all].sort());
    });

    it('returns empty for no matches', () => {
      expect(repo.adminSearchFts('zulu', 10, 0)).toEqual([]);
    });
  });

  describe('adminList', () => {
    it('hides soft-deleted rows by default, newest first', () => {
      const rows = repo.adminList({ includeDeleted: false, limit: 10, offset: 0 });
      expect(rows.map((p) => p.id)).toEqual(['P2', 'P1']);
    });

    it('includes soft-deleted rows when asked', () => {
      const rows = repo.adminList({ includeDeleted: true, limit: 10, offset: 0 });
      expect(rows.map((p) => p.id)).toEqual(['P3', 'P2', 'P1']);
    });

    it('filters global-only and by project', () => {
      const globals = repo.adminList({
        includeDeleted: false,
        project: { kind: 'global' },
        limit: 10,
        offset: 0,
      });
      expect(globals.map((p) => p.id)).toEqual(['P1']);

      const scoped = repo.adminList({
        includeDeleted: false,
        project: { kind: 'project', projectId: 'p1' },
        limit: 10,
        offset: 0,
      });
      expect(scoped.map((p) => p.id)).toEqual(['P2']);
    });

    it('filters by agent and session prefix', () => {
      const byAgent = repo.adminList({
        includeDeleted: false,
        agent: 'claude-code',
        limit: 10,
        offset: 0,
      });
      expect(byAgent.map((p) => p.id)).toEqual(['P2']);

      const byPrefix = repo.adminList({
        includeDeleted: false,
        sessionIdPrefix: 'SESS',
        limit: 10,
        offset: 0,
      });
      expect(byPrefix.map((p) => p.id)).toEqual(['P2']);

      const noMatch = repo.adminList({
        includeDeleted: false,
        sessionIdPrefix: 'ZZZ',
        limit: 10,
        offset: 0,
      });
      expect(noMatch).toEqual([]);
    });

    it('respects limit and offset', () => {
      const rows = repo.adminList({ includeDeleted: true, limit: 1, offset: 1 });
      expect(rows.map((p) => p.id)).toEqual(['P2']);
    });
  });

  describe('adminCount', () => {
    it('mirrors the default (non-deleted) adminList filter', () => {
      expect(repo.adminCount({ includeDeleted: false })).toBe(2);
      expect(repo.adminCount({ includeDeleted: true })).toBe(3);
    });

    it('mirrors the project/global filter', () => {
      expect(repo.adminCount({ includeDeleted: false, project: { kind: 'global' } })).toBe(1);
      expect(
        repo.adminCount({
          includeDeleted: false,
          project: { kind: 'project', projectId: 'p1' },
        }),
      ).toBe(1);
    });

    it('mirrors the agent and session-prefix filter', () => {
      expect(repo.adminCount({ includeDeleted: false, agent: 'claude-code' })).toBe(1);
      expect(repo.adminCount({ includeDeleted: false, sessionIdPrefix: 'SESS' })).toBe(1);
      expect(repo.adminCount({ includeDeleted: false, sessionIdPrefix: 'ZZZ' })).toBe(0);
    });

    it('is independent of limit/offset — the true count, not a page slice', () => {
      const rows = repo.adminList({ includeDeleted: true, limit: 1, offset: 0 });
      expect(rows).toHaveLength(1);
      expect(repo.adminCount({ includeDeleted: true })).toBe(3);
    });
  });
});
