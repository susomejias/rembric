import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/index.js';

import { ProjectsService } from './projects.js';

let db: TestDb;
let projects: ProjectsService;

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(db.handle.db);
});

afterEach(() => {
  db.cleanup();
});

describe('ProjectsService.findOrCreate', () => {
  it('creates a project on first call', () => {
    const p = projects.findOrCreate('/Users/x/repo');
    expect(p.path).toBe('/Users/x/repo');
    expect(p.id.length).toBeGreaterThan(0);
  });

  it('returns the same row on subsequent calls', () => {
    const a = projects.findOrCreate('my-app');
    const b = projects.findOrCreate('my-app');
    expect(a.id).toBe(b.id);
  });

  it('rejects an empty path', () => {
    expect(() => projects.findOrCreate('  ')).toThrow(/non-empty/);
  });
});

describe('ProjectsService.list / rename / archive', () => {
  it('lists active projects by default', () => {
    projects.findOrCreate('a');
    projects.findOrCreate('b');
    const archived = projects.findOrCreate('c');
    projects.archive(archived.id);

    const active = projects.list();
    expect(active.map((p) => p.path).sort()).toEqual(['a', 'b']);
  });

  it('lists archived when requested', () => {
    const p = projects.findOrCreate('z');
    projects.archive(p.id);
    expect(projects.listArchived().length).toBe(1);
  });

  it('rename updates displayName but keeps path identity', () => {
    const p = projects.findOrCreate('proj-1');
    const renamed = projects.rename(p.id, 'My App');
    expect(renamed.path).toBe('proj-1');
    expect(renamed.displayName).toBe('My App');
  });

  it('archive rejects already-archived projects', () => {
    const p = projects.findOrCreate('p');
    projects.archive(p.id);
    expect(() => projects.archive(p.id)).toThrow(/already archived/);
  });

  it('assertWritable rejects archived projects', () => {
    const p = projects.findOrCreate('p');
    projects.archive(p.id);
    expect(() => projects.assertWritable(p.id)).toThrow(/archived/);
  });
});
