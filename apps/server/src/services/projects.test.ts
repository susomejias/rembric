import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { createTestDb, defaultProject, type TestDb } from '../test/index.js';

import { ProjectsService, SLUG_REGEX } from './projects.js';

let db: TestDb;
let projects: ProjectsService;

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(createRepositories(db.handle.db));
});

afterEach(() => {
  db.cleanup();
});

describe('ProjectsService.findBySlug / create', () => {
  it('returns undefined for unknown slugs (never auto-creates)', () => {
    expect(projects.findBySlug('does-not-exist')).toBeUndefined();
  });

  it('creates a project from an explicit slug', () => {
    const p = projects.create({ slug: 'rembric' });
    expect(p.slug).toBe('rembric');
    expect(p.id.length).toBeGreaterThan(0);
  });

  it('returns the same row via findBySlug', () => {
    const a = projects.create({ slug: 'my-app' });
    const b = projects.findBySlug('my-app');
    expect(b?.id).toBe(a.id);
  });

  it('rejects an invalid slug (uppercase)', () => {
    expect(() => projects.create({ slug: 'Bad-Slug' })).toThrow(/invalid|must match/);
  });

  it('rejects an invalid slug (underscore)', () => {
    expect(() => projects.create({ slug: 'bad_slug' })).toThrow();
  });

  it('rejects an invalid slug (leading hyphen)', () => {
    expect(() => projects.create({ slug: '-rembric' })).toThrow();
  });

  it('accepts the canonical slug shape', () => {
    expect(SLUG_REGEX.test('rembric')).toBe(true);
    expect(SLUG_REGEX.test('rembric-api')).toBe(true);
    expect(SLUG_REGEX.test('a1b2c3')).toBe(true);
  });
});

describe('ProjectsService.list / rename / archive', () => {
  it('lists active projects by default', () => {
    projects.create({ slug: 'a' });
    projects.create({ slug: 'b' });
    const archived = projects.create({ slug: 'c' });
    projects.archive(archived.id);

    const active = projects.list();
    // The system default project is an ordinary listed project, resolved by the
    // boolean that identifies it rather than by the spelling of its slug.
    expect(active.map((p) => p.slug).sort()).toEqual(
      ['a', 'b', defaultProject(db.handle).slug].sort(),
    );
  });

  it('lists archived when requested', () => {
    const p = projects.create({ slug: 'zeta' });
    projects.archive(p.id);
    expect(projects.listArchived().length).toBe(1);
  });

  it('rename updates displayName but keeps slug identity', () => {
    const p = projects.create({ slug: 'proj-1' });
    const renamed = projects.rename(p.id, 'My App');
    expect(renamed.slug).toBe('proj-1');
    expect(renamed.displayName).toBe('My App');
  });

  it('archive rejects already-archived projects', () => {
    const p = projects.create({ slug: 'pone' });
    projects.archive(p.id);
    expect(() => projects.archive(p.id)).toThrow(/already archived/);
  });

  it('assertWritable rejects archived projects', () => {
    const p = projects.create({ slug: 'parch' });
    projects.archive(p.id);
    expect(() => projects.assertWritable(p.id)).toThrow(/archived/);
  });

  it('refuses to archive the default project, and the row is untouched', () => {
    const def = defaultProject(db.handle);
    expect(() => projects.archive(def.id)).toThrow(/default project and cannot be archived/);
    const after = projects.getById(def.id);
    expect(after?.archivedAt).toBeNull();
    expect(after?.isDefault).toBe(true);
    // Control: every other project still archives, so the guard is narrow.
    const other = projects.create({ slug: 'pnotdefault' });
    expect(projects.archive(other.id).archivedAt).not.toBeNull();
  });

  it('refuses to archive at all when no row carries is_default', () => {
    const def = defaultProject(db.handle);
    db.handle.raw.prepare('UPDATE projects SET is_default = 0').run();
    // Fail closed: a database with no default is the state the guard's own
    // reason argues from, so it must refuse rather than compare against nothing.
    expect(() => projects.archive(def.id)).toThrow(/missing its default/);
    expect(projects.getById(def.id)?.archivedAt).toBeNull();
  });

  it('renames the default project without touching its slug or its flag', () => {
    const def = defaultProject(db.handle);
    const renamed = projects.rename(def.id, 'operator-renamed');
    expect(renamed.slug).toBe(def.slug);
    expect(renamed.isDefault).toBe(true);
    expect(renamed.displayName).toBe('operator-renamed');
  });
});

describe('ProjectsService.findSimilarSlugs', () => {
  it('returns near matches by Levenshtein distance', () => {
    projects.create({ slug: 'rembric' });
    projects.create({ slug: 'rembric-api' });
    projects.create({ slug: 'unrelated' });

    const suggestions = projects.findSimilarSlugs('rembic');
    expect(suggestions).toContain('rembric');
    expect(suggestions).not.toContain('unrelated');
  });

  it('returns an empty array when nothing is close', () => {
    projects.create({ slug: 'rembric' });
    expect(projects.findSimilarSlugs('totally-different-name')).toEqual([]);
  });

  it('is deterministic for identical input + state', () => {
    projects.create({ slug: 'rembric' });
    projects.create({ slug: 'rembric-api' });
    const a = projects.findSimilarSlugs('rembic');
    const b = projects.findSimilarSlugs('rembic');
    expect(a).toEqual(b);
  });

  it('caps results at the requested limit', () => {
    for (const slug of ['rembric', 'rembric-a', 'rembric-b', 'rembric-c', 'rembric-d']) {
      projects.create({ slug });
    }
    expect(projects.findSimilarSlugs('rembric-x', { limit: 2 }).length).toBe(2);
  });
});
