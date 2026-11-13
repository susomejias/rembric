import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  ensureProjectLexicalIndex,
  projectIdOfLexicalIndexObject,
  projectLexicalIndexName,
  projectScope,
  reconcileProjectLexicalIndexes,
  type Repositories,
} from '@rembric/db';

import { createTestDb, type TestDb } from './test-support/db.js';

let db: TestDb;
let repos: Repositories;

function seedProject(id: string): void {
  db.handle.raw
    .prepare('INSERT INTO projects (id, slug, created_at) VALUES (?, ?, 0)')
    .run(id, `slug-${Buffer.from(id).toString('hex')}`);
}

function save(id: string, projectId: string, content: string, tags: string[] = []): void {
  db.handle.raw
    .prepare(
      `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, created_at)
       VALUES (?, 'project', ?, 'reference', 'title', ?, ?, 'active', 0)`,
    )
    .run(id, projectId, content, JSON.stringify(tags));
}

function objectsOf(projectId: string): string[] {
  const prefix = projectLexicalIndexName(projectId);
  return db.handle.raw
    .prepare<[], { name: string }>(`SELECT name FROM sqlite_master ORDER BY name`)
    .all()
    .map((r) => r.name)
    .filter((n) => n === prefix || n.startsWith(`${prefix}_`));
}

function matches(projectId: string, query: string): string[] {
  const t = projectLexicalIndexName(projectId);
  return db.handle.raw
    .prepare<[string], { id: string }>(
      `SELECT m.id AS id FROM ${t} JOIN memory m ON m.rowid = ${t}.rowid
       WHERE ${t} MATCH ? ORDER BY m.id`,
    )
    .all(query)
    .map((r) => r.id);
}

function integrityCheck(projectId: string): void {
  const t = projectLexicalIndexName(projectId);
  db.handle.raw.exec(`INSERT INTO ${t}(${t}, rank) VALUES ('integrity-check', 1)`);
}

function defaultProjectId(): string {
  return db.handle.raw
    .prepare<[], { id: string }>('SELECT id FROM projects WHERE is_default = 1')
    .get()!.id;
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
});
afterEach(() => db.cleanup());

describe('the per-project index name', () => {
  it('is a safe identifier, distinct for every distinct id, and decodes back to the id', () => {
    const ids = ['01HZXAMPLEULID0000000000AB', 'abc', 'ABC', "o'neil", 'a b', 'ünï'];
    const names = ids.map(projectLexicalIndexName);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(ids.length);
    for (const [i, name] of names.entries()) {
      expect(name).toMatch(/^memory_fts_p_[0-9a-f]+$/);
      expect(projectIdOfLexicalIndexObject(name)).toBe(ids[i]);
      expect(projectIdOfLexicalIndexObject(`${name}_ai`)).toBe(ids[i]);
    }
    expect(projectIdOfLexicalIndexObject('memory_fts')).toBeUndefined();
    expect(projectIdOfLexicalIndexObject('memory_fts_vocab')).toBeUndefined();
    expect(projectIdOfLexicalIndexObject(`${names[0]}_other`)).toBeUndefined();
  });

  it('indexes a project whose id needs quoting', () => {
    const id = "o'neil project";
    seedProject(id);
    ensureProjectLexicalIndex(db.handle.raw, id);
    save('q1', id, 'quoted zephyrkite');
    expect(matches(id, 'zephyrkite')).toEqual(['q1']);
  });
});

describe('boot reconciliation', () => {
  it("builds the index of migration 0031's hex-id default project", () => {
    const id = defaultProjectId();
    expect(id).toMatch(/^[0-9a-f]{26}$/);
    expect(objectsOf(id)).toContain(projectLexicalIndexName(id));
    save('d1', id, 'default zephyrkite');
    expect(matches(id, 'zephyrkite')).toEqual(['d1']);
  });

  it('creates a missing index and populates it from existing rows', () => {
    seedProject('p1');
    save('m1', 'p1', 'existing zephyrkite', ['ledger']);
    expect(objectsOf('p1')).toEqual([]);

    expect(reconcileProjectLexicalIndexes(db.handle.raw).built).toEqual(['p1']);
    expect(matches('p1', 'zephyrkite')).toEqual(['m1']);
    expect(matches('p1', 'ledger')).toEqual(['m1']);
    integrityCheck('p1');
  });

  it('recreates an index whose stored DDL drifted from the recipe, and rebuilds it', () => {
    seedProject('p1');
    ensureProjectLexicalIndex(db.handle.raw, 'p1');
    const t = projectLexicalIndexName('p1');
    db.handle.raw.exec(`DROP TRIGGER ${t}_ai`);
    db.handle.raw.exec(`CREATE TRIGGER ${t}_ai AFTER INSERT ON memory BEGIN SELECT 1; END`);
    save('m1', 'p1', 'drifted zephyrkite');
    expect(matches('p1', 'zephyrkite')).toEqual([]);

    expect(reconcileProjectLexicalIndexes(db.handle.raw).built).toEqual(['p1']);
    expect(matches('p1', 'zephyrkite')).toEqual(['m1']);
    save('m2', 'p1', 'later zephyrkite');
    expect(matches('p1', 'zephyrkite')).toEqual(['m1', 'm2']);
  });

  it('leaves a clean schema untouched', () => {
    seedProject('p1');
    ensureProjectLexicalIndex(db.handle.raw, 'p1');
    expect(reconcileProjectLexicalIndexes(db.handle.raw)).toEqual({ built: [], dropped: [] });
  });

  it('drops every object of a project whose row no longer exists', () => {
    seedProject('gone');
    ensureProjectLexicalIndex(db.handle.raw, 'gone');
    expect(objectsOf('gone').length).toBeGreaterThan(0);
    db.handle.raw.prepare('DELETE FROM projects WHERE id = ?').run('gone');

    expect(reconcileProjectLexicalIndexes(db.handle.raw).dropped).toEqual(['gone']);
    expect(objectsOf('gone')).toEqual([]);
  });
});

describe('project creation', () => {
  it('creates the index when the repository inserts the project', () => {
    repos.projects.insert({ id: 'new-project', slug: 'new-project', createdAt: new Date(0) });
    expect(objectsOf('new-project')).toContain(projectLexicalIndexName('new-project'));
    save('n1', 'new-project', 'fresh zephyrkite');
    expect(matches('new-project', 'zephyrkite')).toEqual(['n1']);
  });

  it("rolls the index back with the project when the caller's transaction aborts", () => {
    expect(() =>
      db.handle.db.transaction(() => {
        repos.projects.insert({ id: 'aborted', slug: 'aborted', createdAt: new Date(0) });
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(repos.projects.findById('aborted')).toBeUndefined();
    expect(objectsOf('aborted')).toEqual([]);

    repos.projects.insert({ id: 'aborted', slug: 'aborted', createdAt: new Date(0) });
    save('n1', 'aborted', 'retried zephyrkite');
    expect(matches('aborted', 'zephyrkite')).toEqual(['n1']);
  });
});

describe('trigger maintenance', () => {
  beforeEach(() => {
    seedProject('pa');
    seedProject('pb');
    ensureProjectLexicalIndex(db.handle.raw, 'pa');
    ensureProjectLexicalIndex(db.handle.raw, 'pb');
  });

  it("indexes a write to project A in A's table only", () => {
    save('a1', 'pa', 'alpha zephyrkite', ['tagged']);
    expect(matches('pa', 'zephyrkite')).toEqual(['a1']);
    expect(matches('pa', 'tagged')).toEqual(['a1']);
    expect(matches('pb', 'zephyrkite')).toEqual([]);
    expect(matches('pb', 'tagged')).toEqual([]);
    integrityCheck('pa');
    integrityCheck('pb');
  });

  it('a purge leaves no posting behind, tags included', () => {
    save('a1', 'pa', 'alpha zephyrkite', ['tagged']);
    db.handle.raw.prepare('DELETE FROM memory WHERE id = ?').run('a1');
    expect(matches('pa', 'zephyrkite')).toEqual([]);
    expect(matches('pa', 'tagged')).toEqual([]);
    integrityCheck('pa');
  });

  it('a tag update replaces the old tag postings with the new ones', () => {
    save('a1', 'pa', 'alpha zephyrkite', ['before']);
    db.handle.raw
      .prepare('UPDATE memory SET tags = ? WHERE id = ?')
      .run(JSON.stringify(['after']), 'a1');
    expect(matches('pa', 'before')).toEqual([]);
    expect(matches('pa', 'after')).toEqual(['a1']);
    expect(matches('pb', 'after')).toEqual([]);
    integrityCheck('pa');
  });
});

describe('the save-time statement reads the project index', () => {
  const candidates = (projectId: string, matchExpr: string) =>
    repos.memory
      .searchBm25Candidates({ matchExpr, excludeId: 'none', projectId, excludeIds: [], limit: 20 })
      .map((r) => [r.id, r.rank]);

  function reference(projectId: string, matchExpr: string): [string, number][] {
    const raw = db.handle.raw;
    raw.exec(`CREATE VIRTUAL TABLE temp.ref USING fts5(content, tags, title, content='')`);
    raw
      .prepare(
        `INSERT INTO temp.ref(rowid, content, tags, title)
         SELECT rowid, content, coalesce((SELECT group_concat(value, ' ') FROM json_each(tags)), ''),
                title FROM memory WHERE project_id = ?`,
      )
      .run(projectId);
    const rows = raw
      .prepare<[string, string], { id: string; rank: number }>(
        `SELECT m.id AS id, bm25(ref) AS rank FROM temp.ref JOIN memory m ON m.rowid = ref.rowid
         WHERE ref MATCH ? AND m.project_id = ? AND m.status = 'active' ORDER BY bm25(ref) LIMIT 20`,
      )
      .all(matchExpr, projectId)
      .map((r): [string, number] => [r.id, r.rank]);
    raw.exec('DROP TABLE temp.ref');
    return rows;
  }

  beforeEach(() => {
    seedProject('pa');
    seedProject('pb');
    save('a1', 'pa', 'zephyrkite ledger amber', ['kite']);
    save('a2', 'pa', 'zephyrkite birch');
    save('a3', 'pa', 'ledger cedar dune');
    save('b-shared', 'pb', 'zephyrkite zephyrkite kite');
  });

  it('returns exactly the scores of an index holding only that project', () => {
    const expr = '"zephyrkite" OR "ledger" OR "kite"';
    expect(candidates('pa', expr)).toEqual(reference('pa', expr));
    expect(candidates('pa', expr)).toHaveLength(3);
  });

  it('is unchanged by rows added to another project', () => {
    const expr = '"zephyrkite" OR "ledger"';
    const before = candidates('pa', expr);
    for (let i = 0; i < 30; i++) save(`b${i}`, 'pb', `zephyrkite ledger filler ${i}`);
    expect(candidates('pa', expr)).toEqual(before);
    expect(candidates('pb', expr)).toHaveLength(20);
  });

  it('builds the index first when the project has none', () => {
    seedProject('raw-only');
    save('r1', 'raw-only', 'zephyrkite unindexed');
    expect(objectsOf('raw-only')).toEqual([]);
    expect(candidates('raw-only', '"zephyrkite"').map(([id]) => id)).toEqual(['r1']);
    expect(objectsOf('raw-only')).toContain(projectLexicalIndexName('raw-only'));
  });
});

describe('project-scoped term statistics', () => {
  beforeEach(() => {
    seedProject('pa');
    seedProject('pb');
    save('a1', 'pa', 'apps core held');
    save('a2', 'pa', 'apps held');
    db.handle.raw.prepare(`UPDATE memory SET status = 'archived' WHERE id = ?`).run('a2');
    for (let i = 0; i < 5; i++) save(`b${i}`, 'pb', 'apps core held elsewhere');
  });

  it("counts the project's rows in every status and no other project's", () => {
    expect(repos.termStatistics.projectDocumentCount(projectScope('pa'))).toBe(2);
    expect(repos.termStatistics.projectDocumentCount(projectScope('pb'))).toBe(5);
  });

  it("reads each token's terms and the project's own document frequencies", () => {
    expect(
      repos.termStatistics.projectTokenTermFrequencies(projectScope('pa'), [
        'apps/core-12',
        'held',
        'elsewhere',
      ]),
    ).toEqual([
      [
        { term: 'apps', documentFrequency: 2 },
        { term: 'core', documentFrequency: 1 },
        { term: '12', documentFrequency: null },
      ],
      [{ term: 'held', documentFrequency: 2 }],
      [{ term: 'elsewhere', documentFrequency: null }],
    ]);
  });
});
