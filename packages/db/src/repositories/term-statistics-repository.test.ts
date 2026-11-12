import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, QUERY_TERMS_VOCAB_TABLE, type Repositories } from '@rembric/db';

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

  it('takes the term-constrained seek on both sides of the join', () => {
    const plan = db.handle.raw
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT q.term AS term, v.doc AS doc
         FROM temp.${QUERY_TERMS_VOCAB_TABLE} q
         LEFT JOIN memory_fts_vocab v ON v.term = q.term`,
      )
      .all()
      .map((r) => r.detail);
    expect(plan).toEqual([
      'SCAN q VIRTUAL TABLE INDEX 1:',
      'SCAN v VIRTUAL TABLE INDEX 259: LEFT-JOIN',
    ]);
  });
});

describe('adminTokenTermFrequencies tokenises each token through the index tokenizer', () => {
  it("returns every token's term instances in order, each with its document frequency", () => {
    save('m1', 'στάσις apps core held');
    save('m2', 'apps held');

    expect(
      repos.termStatistics.adminTokenTermFrequencies(['apps/core-12', 'στάσις', 'held']),
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
    save('m1', 'ha');
    expect(repos.termStatistics.adminTokenTermFrequencies(['ha-ha'])).toEqual([
      [
        { term: 'ha', documentFrequency: 1 },
        { term: 'ha', documentFrequency: 1 },
      ],
    ]);
  });

  it('returns an empty list for a token the tokenizer yields no term for, and for no tokens', () => {
    expect(repos.termStatistics.adminTokenTermFrequencies(['--', 'alpha'])).toEqual([
      [],
      [{ term: 'alpha', documentFrequency: null }],
    ]);
    expect(repos.termStatistics.adminTokenTermFrequencies([])).toEqual([]);
  });

  it('leaks no token between consecutive reads or into the per-text read', () => {
    save('m1', 'alpha beta');
    repos.termStatistics.adminTokenTermFrequencies(['alpha', 'beta', 'gamma']);
    expect(repos.termStatistics.adminTokenTermFrequencies(['delta'])).toEqual([
      [{ term: 'delta', documentFrequency: null }],
    ]);
    expect([...repos.termStatistics.adminQueryTermFrequencies('epsilon').keys()]).toEqual([
      'epsilon',
    ]);
  });
});
