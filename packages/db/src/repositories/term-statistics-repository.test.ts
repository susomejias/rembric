import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  projectScope,
  QUERY_TERMS_VOCAB_TABLE,
  type Repositories,
} from '@rembric/db';

import { createTestDb, type TestDb } from '../test-support/db.js';

let db: TestDb;
let repos: Repositories;

function save(id: string, content: string): void {
  db.handle.raw
    .prepare(
      `INSERT INTO memory (id, scope, project_id, type, title, content, status, created_at)
       VALUES (?, 'global', NULL, 'reference', 'title', ?, 'active', 0)`,
    )
    .run(id, content);
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
});
afterEach(() => db.cleanup());

describe('adminQueryTermFrequencies keys the read on the index own terms', () => {
  it('resolves a term whose index form differs from an application-side tokenisation', () => {
    for (let i = 0; i < 3; i++) save(`gr${i}`, 'στάσις του майский κόμβου');
    save('other', 'unrelated english prose');

    const stats = repos.termStatistics.adminQueryTermFrequencies('στάσις майский');
    expect(new Set(stats.keys())).toEqual(new Set(['майский', 'στάσισ']));
    expect(stats.get('στάσισ')).toBe(3);
    expect(stats.get('майский')).toBe(3);
    expect(stats.has('стасис')).toBe(false);
    expect(stats.has('маискии')).toBe(false);
  });

  it('reports a term the index has never seen as absent, distinguishably from a held one', () => {
    save('m1', 'held term appears here');

    const stats = repos.termStatistics.adminQueryTermFrequencies('held nowherenearthecorpus');
    expect(stats.has('nowherenearthecorpus')).toBe(true);
    expect(stats.get('nowherenearthecorpus')).toBeNull();
    expect(stats.get('held')).toBe(1);
  });

  it('reports every term of an empty corpus as absent rather than failing', () => {
    const stats = repos.termStatistics.adminQueryTermFrequencies('alpha beta');
    expect(stats).toEqual(
      new Map([
        ['alpha', null],
        ['beta', null],
      ]),
    );
    expect(repos.termStatistics.adminDocumentCount()).toBe(0);
  });

  it('leaks no term between two consecutive queries with disjoint vocabularies', () => {
    save('m1', 'alpha beta gamma');
    repos.termStatistics.adminQueryTermFrequencies('alpha beta gamma');
    const second = repos.termStatistics.adminQueryTermFrequencies('delta epsilon');
    expect([...second.keys()].sort()).toEqual(['delta', 'epsilon']);

    // And the tokenising table itself holds only the last query's terms.
    const vocabSelect = `SELECT term FROM temp.${QUERY_TERMS_VOCAB_TABLE}`;

    expect(
      db.handle.raw
        .prepare<[], { term: string }>(vocabSelect)
        .all()
        .map((r) => r.term)
        .sort(),
    ).toEqual(['delta', 'epsilon']);
  });
});

describe('projectTokenTermFrequencies tokenises each token through the index tokenizer', () => {
  const scope = projectScope('p1');
  const saveIn = (id: string, content: string) =>
    db.handle.raw
      .prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, status, created_at)
         VALUES (?, 'project', 'p1', 'reference', 'title', ?, 'active', 0)`,
      )
      .run(id, content);

  beforeEach(() => {
    db.handle.raw
      .prepare(`INSERT INTO projects (id, slug, created_at) VALUES ('p1', 'p1', 0)`)
      .run();
  });

  it("returns every token's term instances in order, each with its document frequency", () => {
    saveIn('m1', 'στάσις apps core held');
    saveIn('m2', 'apps held');

    expect(
      repos.termStatistics.projectTokenTermFrequencies(scope, ['apps/core-12', 'στάσις', 'held']),
    ).toEqual([
      [
        { term: 'apps', documentFrequency: 2 },
        { term: 'core', documentFrequency: 1 },
        { term: '12', documentFrequency: null },
      ],
      [{ term: 'στάσισ', documentFrequency: 1 }],
      [{ term: 'held', documentFrequency: 2 }],
    ]);
  });

  it('counts a token made of one repeated term as two instances', () => {
    saveIn('m1', 'ha');
    expect(repos.termStatistics.projectTokenTermFrequencies(scope, ['ha-ha'])).toEqual([
      [
        { term: 'ha', documentFrequency: 1 },
        { term: 'ha', documentFrequency: 1 },
      ],
    ]);
  });

  it('returns an empty list for a token the tokenizer yields no term for, and for no tokens', () => {
    expect(repos.termStatistics.projectTokenTermFrequencies(scope, ['--', 'alpha'])).toEqual([
      [],
      [{ term: 'alpha', documentFrequency: null }],
    ]);
    expect(repos.termStatistics.projectTokenTermFrequencies(scope, [])).toEqual([]);
  });

  it('leaks no token between consecutive reads or into the per-text read', () => {
    saveIn('m1', 'alpha beta');
    repos.termStatistics.projectTokenTermFrequencies(scope, ['alpha', 'beta', 'gamma']);
    expect(repos.termStatistics.projectTokenTermFrequencies(scope, ['delta'])).toEqual([
      [{ term: 'delta', documentFrequency: null }],
    ]);
    expect([...repos.termStatistics.adminQueryTermFrequencies('epsilon').keys()]).toEqual([
      'epsilon',
    ]);
  });
});

describe('adminSearchTermFrequencies reads the query and its tokens in one statement', () => {
  it("returns the query's terms in term order, each with its global document frequency", () => {
    save('m1', 'zeta alpha');
    save('m2', 'zeta mid');
    save('m3', 'zeta');

    const { query } = repos.termStatistics.adminSearchTermFrequencies('zeta alpha zeta Mid gone', [
      'zeta',
      'alpha',
    ]);
    expect([...query]).toEqual([
      ['alpha', 1],
      ['gone', null],
      ['mid', 1],
      ['zeta', 3],
    ]);
  });

  it("returns each token's term instances in order, with null for a term the index lacks", () => {
    save('m1', 'two space notes');
    save('m2', 'notes');

    const { tokens } = repos.termStatistics.adminSearchTermFrequencies(
      'two-space notes absentterm',
      ['two-space', 'notes', 'absentterm', '¿'],
    );
    expect(tokens).toEqual([
      [
        { term: 'two', documentFrequency: 1 },
        { term: 'space', documentFrequency: 1 },
      ],
      [{ term: 'notes', documentFrequency: 2 }],
      [{ term: 'absentterm', documentFrequency: null }],
      [],
    ]);
  });

  it('counts a token made of one repeated term as two instances', () => {
    save('m1', 'ha');
    const { tokens } = repos.termStatistics.adminSearchTermFrequencies('ha-ha', ['ha-ha']);
    expect(tokens).toEqual([
      [
        { term: 'ha', documentFrequency: 1 },
        { term: 'ha', documentFrequency: 1 },
      ],
    ]);
  });

  it('keeps the per-text read equal to the query half of the combined read', () => {
    save('m1', 'alpha beta');
    save('m2', 'beta gamma');
    const text = 'gamma beta unknownword alpha';
    expect(repos.termStatistics.adminQueryTermFrequencies(text)).toEqual(
      repos.termStatistics.adminSearchTermFrequencies(text, ['gamma']).query,
    );
    expect([...repos.termStatistics.adminQueryTermFrequencies(text).keys()]).toEqual([
      'alpha',
      'beta',
      'gamma',
      'unknownword',
    ]);
  });

  it('leaks no term or token between consecutive reads', () => {
    save('m1', 'alpha beta delta');
    repos.termStatistics.adminSearchTermFrequencies('alpha beta', ['alpha', 'beta']);
    const second = repos.termStatistics.adminSearchTermFrequencies('delta', ['delta']);
    expect([...second.query.keys()]).toEqual(['delta']);
    expect(second.tokens).toEqual([[{ term: 'delta', documentFrequency: 1 }]]);
  });

  it('joins each distinct term to the vocabulary once, by the term-constrained seek', () => {
    save('m1', 'alpha beta');
    const raw = db.handle.raw;
    const prepare = raw.prepare.bind(raw);
    const texts: string[] = [];
    raw.prepare = (text: string) => {
      texts.push(text);
      return prepare(text);
    };
    try {
      repos.termStatistics.adminSearchTermFrequencies('alpha beta alpha', ['alpha', 'beta']);
    } finally {
      raw.prepare = prepare;
    }
    const read = texts.find((t) => /memory_fts_vocab/.test(t));
    expect(read).toBeDefined();
    const plan = prepare<[], { detail: string }>(`EXPLAIN QUERY PLAN ${read!}`)
      .all()
      .map((r) => r.detail);
    expect(plan.filter((d) => /memory_fts_vocab|SCAN v /.test(d))).toEqual([
      'SCAN v VIRTUAL TABLE INDEX 259: LEFT-JOIN',
    ]);
    expect(plan.some((d) => /MATERIALIZE f/.test(d))).toBe(true);
  });
});
