import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb, TestClock } from '../test/index.js';

import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { SCOPE_GLOBAL, projectScope } from './scope.js';

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

describe('memory.save', () => {
  it('persists with the scope passed in (project)', () => {
    const m = memory.save(
      { type: 'user', content: 'prefers tabs', tags: ['editor'] },
      projectScope(projectId),
    );
    expect(m.scope).toBe('project');
    expect(m.projectId).toBe(projectId);
    expect(m.status).toBe('active');
    expect(m.tags).toEqual(['editor']);
  });

  it('persists with the scope passed in (global)', () => {
    const m = memory.save({ type: 'user', content: 'dark mode' }, SCOPE_GLOBAL);
    expect(m.scope).toBe('global');
    expect(m.projectId).toBeNull();
  });

  it('rejects empty content', () => {
    expect(() => memory.save({ type: 'user', content: '   ' }, SCOPE_GLOBAL)).toThrow(/non-empty/);
  });
});

describe('memory.search', () => {
  it('FTS5 keyword match within scope', () => {
    memory.save({ type: 'user', content: 'prefers tabs over spaces' }, projectScope(projectId));
    memory.save({ type: 'user', content: 'uses pnpm not npm' }, projectScope(projectId));

    const results = memory.search({ query: 'tabs' }, projectScope(projectId));
    expect(results.length).toBe(1);
    expect(results[0]!.content).toMatch(/tabs/);
  });

  it('never leaks across projects', () => {
    const otherId = projects.findOrCreate('other-app').id;
    memory.save({ type: 'user', content: 'in project A' }, projectScope(projectId));
    memory.save({ type: 'user', content: 'in project B' }, projectScope(otherId));

    const a = memory.search({}, projectScope(projectId));
    expect(a.every((m) => m.projectId === projectId)).toBe(true);
    expect(a.some((m) => m.content.includes('B'))).toBe(false);
  });

  it("global scope returns globals only — projects don't leak", () => {
    memory.save({ type: 'user', content: 'global one' }, SCOPE_GLOBAL);
    memory.save({ type: 'user', content: 'project one' }, projectScope(projectId));

    const globals = memory.search({}, SCOPE_GLOBAL);
    expect(globals.every((m) => m.scope === 'global')).toBe(true);
  });

  it("project scope returns project only — globals don't leak", () => {
    memory.save({ type: 'user', content: 'global g' }, SCOPE_GLOBAL);
    memory.save({ type: 'user', content: 'project p' }, projectScope(projectId));

    const proj = memory.search({}, projectScope(projectId));
    expect(proj.every((m) => m.scope === 'project' && m.projectId === projectId)).toBe(true);
  });
});

describe('memory.get', () => {
  it('returns memory + history when in scope', () => {
    const saved = memory.save({ type: 'user', content: 'fresh' }, projectScope(projectId));
    const result = memory.get(saved.id, projectScope(projectId));
    expect(result?.memory.id).toBe(saved.id);
    expect(result?.predecessors).toEqual([]);
    expect(result?.confirmationCount).toBe(0);
  });

  it('returns null for a global id when scope is project', () => {
    const g = memory.save({ type: 'user', content: 'g' }, SCOPE_GLOBAL);
    const result = memory.get(g.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for a project id when scope is global', () => {
    const p = memory.save({ type: 'user', content: 'p' }, projectScope(projectId));
    const result = memory.get(p.id, SCOPE_GLOBAL);
    expect(result).toBeNull();
  });

  it('returns null for a memory in a different project', () => {
    const otherId = projects.findOrCreate('other').id;
    const m = memory.save({ type: 'user', content: 'in other' }, projectScope(otherId));
    const result = memory.get(m.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(memory.get('does-not-exist', SCOPE_GLOBAL)).toBeNull();
  });
});

describe('memory.confirm', () => {
  it('records confirmations against the head', () => {
    const m = memory.save({ type: 'user', content: 'count me' }, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId));
    const result = memory.get(m.id, projectScope(projectId));
    expect(result?.confirmationCount).toBe(2);
  });

  it('throws not_found for cross-scope ids', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    expect(() => memory.confirm(m.id, SCOPE_GLOBAL)).toThrow(/not found/);
  });

  it('throws not_found for unknown ids', () => {
    expect(() => memory.confirm('nope', SCOPE_GLOBAL)).toThrow(/not found/);
  });
});

describe('memory.archive', () => {
  it('flips active → archived when in scope', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));
    const refetched = memory.unsafeGetById(m.id);
    expect(refetched?.status).toBe('archived');
  });

  it('refuses to archive an out-of-scope memory', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    expect(() => memory.archive(m.id, SCOPE_GLOBAL)).toThrow(/not found/);
  });

  it('refuses to archive a non-active memory', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));
    expect(() => memory.archive(m.id, projectScope(projectId))).toThrow(/not in 'active'/);
  });
});
