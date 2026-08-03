import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../../test/index.js';
import { QUERY_TERMS_VOCAB_TABLE } from '../query-tokenizer.js';

import { createRepositories, type Repositories } from './index.js';

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
    // Greek final sigma and the Cyrillic breve: `unicode61` lowercases and maps
    // the final sigma but does not fold either accent, so the index's terms are
    // `στάσισ` and `майский` — neither of which an accent-stripping tokenisation
    // would have produced.
    for (let i = 0; i < 3; i++) save(`gr${i}`, 'στάσις του майский κόμβου');
    save('other', 'unrelated english prose');

    const stats = repos.termStatistics.adminQueryTermFrequencies('στάσις майский');
    expect(new Set(stats.keys())).toEqual(new Set(['майский', 'στάσισ']));
    expect(stats.get('στάσισ')).toBe(3);
    expect(stats.get('майский')).toBe(3);
    // The fabricated keys an accent-stripping tokenisation would have used are
    // NOT what the read is keyed on.
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
    expect(
      db.handle.raw
        .prepare<[], { term: string }>(`SELECT term FROM temp.${QUERY_TERMS_VOCAB_TABLE}`)
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
