import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb, TestClock } from '../test/index.js';

import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let clock: TestClock;
let projectId: string;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  projects = new ProjectsService(db.handle.db, clock.now);
  memory = new MemoryService(db.handle.db, clock.now);
  projectId = projects.findOrCreate('test-app').id;
});

afterEach(() => {
  db.cleanup();
});

describe('memory.save scope discipline', () => {
  it('rejects scope=project without projectId', () => {
    expect(() => memory.save({ scope: 'project', type: 'user', content: 'x' })).toThrow(
      /requires.*projectId/i,
    );
  });

  it('rejects scope=global with a projectId', () => {
    expect(() => memory.save({ scope: 'global', type: 'user', content: 'x', projectId })).toThrow(
      /rejects.*projectId/i,
    );
  });

  it('rejects empty content', () => {
    expect(() => memory.save({ scope: 'global', type: 'user', content: '   ' })).toThrow(
      /non-empty/,
    );
  });

  it('persists a valid project memory', () => {
    const m = memory.save({
      scope: 'project',
      projectId,
      type: 'user',
      content: 'prefers tabs',
      tags: ['editor'],
    });
    expect(m.status).toBe('active');
    expect(m.replaces).toEqual([]);
    expect(m.tags).toEqual(['editor']);
    expect(m.projectId).toBe(projectId);
  });
});

describe('memory.search FTS5', () => {
  it('finds memories by keyword', () => {
    memory.save({ scope: 'project', projectId, type: 'user', content: 'prefers tabs over spaces' });
    memory.save({ scope: 'project', projectId, type: 'user', content: 'uses pnpm not npm' });

    const results = memory.search({ scope: 'project', projectId, query: 'tabs' });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toMatch(/tabs/);
  });

  it('respects scope isolation between projects', () => {
    const otherProject = projects.findOrCreate('other-app').id;
    memory.save({ scope: 'project', projectId, type: 'user', content: 'project-a memory' });
    memory.save({
      scope: 'project',
      projectId: otherProject,
      type: 'user',
      content: 'project-b memory',
    });

    const aResults = memory.search({ scope: 'project', projectId, includeGlobal: false });
    expect(aResults.every((m) => m.projectId === projectId)).toBe(true);
  });

  it('includes globals when scope=project and includeGlobal=true', () => {
    memory.save({ scope: 'global', type: 'user', content: 'global memory' });
    memory.save({ scope: 'project', projectId, type: 'user', content: 'project memory' });

    const merged = memory.search({ scope: 'project', projectId, includeGlobal: true });
    expect(merged.length).toBe(2);
  });

  it('globals search never leaks project memories', () => {
    memory.save({ scope: 'global', type: 'user', content: 'g' });
    memory.save({ scope: 'project', projectId, type: 'user', content: 'p' });
    const results = memory.search({ scope: 'global' });
    expect(results.every((m) => m.scope === 'global')).toBe(true);
  });
});

describe('memory.get and history', () => {
  it('returns memory + head + zero predecessors for a fresh save', () => {
    const m = memory.save({
      scope: 'project',
      projectId,
      type: 'user',
      content: 'fresh',
    });
    const result = memory.getWithHistory(m.id);
    expect(result?.head.id).toBe(m.id);
    expect(result?.predecessors).toEqual([]);
    expect(result?.confirmationCount).toBe(0);
  });
});

describe('memory.confirm increments via event table', () => {
  it('records confirmations and exposes them via getWithHistory', () => {
    const m = memory.save({
      scope: 'project',
      projectId,
      type: 'user',
      content: 'count me',
    });
    memory.confirm(m.id);
    memory.confirm(m.id);
    const result = memory.getWithHistory(m.id);
    expect(result?.confirmationCount).toBe(2);
  });

  it('throws for unknown ids', () => {
    expect(() => memory.confirm('not-real')).toThrow(/not found/);
  });
});

describe('memory.archive', () => {
  it('flips active → archived', () => {
    const m = memory.save({
      scope: 'project',
      projectId,
      type: 'user',
      content: 'to archive',
    });
    memory.archive(m.id);
    const refetched = memory.getById(m.id);
    expect(refetched?.status).toBe('archived');
  });

  it('rejects archiving a non-active memory', () => {
    const m = memory.save({
      scope: 'project',
      projectId,
      type: 'user',
      content: 'x',
    });
    memory.archive(m.id);
    expect(() => memory.archive(m.id)).toThrow(/not in 'active' state/);
  });
});
