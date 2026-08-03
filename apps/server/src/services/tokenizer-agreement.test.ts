import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inheritedFts5Arguments } from '../db/query-tokenizer.js';
import { createTestDb } from '../test/index.js';
import { CORPUS } from '../test/retrieval/corpus.js';
import { QUERIES } from '../test/retrieval/queries.js';

import { indexTerms, tokenSet } from './hybrid-search.js';

/**
 * What this measures: the ROW-MEMBERSHIP half of the lexical component agrees
 * with the index over the committed corpus — the corpus every retrieval number
 * in this repo is drawn from. It is NOT evidence of agreement in general, and
 * must not be read as such: `CORPUS` and `QUERIES` are English and Spanish,
 * where the divergence measures 0%, while outside single-diacritic Latin it runs
 * from 17% of terms (Arabic) to 100% (Japanese, Cyrillic with `й`/`ё`).
 *
 * The query half is no longer asserted here because it is no longer produced
 * here — it comes from the index itself (`adminQueryTermFrequencies`). The guards
 * that carry the general property are `db/query-tokenizer.test.ts` (the
 * declaration is derived, an unrecognised option fails startup),
 * `db/repositories/term-statistics-repository.test.ts` (an absent term is
 * reported, not inferred) and `lexical-asymmetry.test.ts` (a row-side
 * disagreement may only under-count).
 */
describe('indexTerms agrees with the index over the committed corpus', () => {
  const TEXTS = [
    ...CORPUS.flatMap((m) => [m.title, m.content, (m.tags ?? []).join(' ')]),
    ...QUERIES.map((q) => q.text),
  ].filter((t) => t.length > 0);

  let db: Database.Database;
  let ftsTerms: Set<string>;
  let ftsTermsByRow: Map<number, string[]>;

  beforeAll(() => {
    // The probe's tokenizer is not restated: it is whatever `memory_fts` declares
    // in the migrated schema, so a `tokenize=` added by a later migration reaches
    // this test rather than silently bypassing it.
    const migrated = createTestDb();
    const declaration = migrated.handle.raw
      .prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'memory_fts'`)
      .get()!.sql;
    const inherited = inheritedFts5Arguments(declaration);
    migrated.cleanup();

    db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(${['body', ...inherited].join(', ')})`);
    db.exec(`CREATE VIRTUAL TABLE t_vocab USING fts5vocab('t','row')`);
    db.exec(`CREATE VIRTUAL TABLE t_inst USING fts5vocab('t','instance')`);
    const insert = db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)');
    TEXTS.forEach((text, i) => insert.run(i + 1, text));

    ftsTerms = new Set(
      db
        .prepare<[], { term: string }>('SELECT term FROM t_vocab')
        .all()
        .map((r) => r.term),
    );
    ftsTermsByRow = new Map();
    for (const row of db
      .prepare<
        [],
        { doc: number; term: string }
      >('SELECT DISTINCT doc, term FROM t_inst ORDER BY doc, term')
      .all()) {
      const list = ftsTermsByRow.get(row.doc);
      if (list) list.push(row.term);
      else ftsTermsByRow.set(row.doc, [row.term]);
    }
  });

  afterAll(() => db.close());

  it('covers the whole committed corpus and query set, not a sample', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
    expect(QUERIES.length).toBeGreaterThanOrEqual(24);
    expect(TEXTS.length).toBeGreaterThanOrEqual(CORPUS.length * 2);
    expect(ftsTerms.size).toBeGreaterThan(500);
    expect(QUERIES.some((q) => q.bilingual === true)).toBe(true);
  });

  it('produces the same term set the index stores for this corpus', () => {
    const appTerms = new Set(TEXTS.flatMap((text) => indexTerms(text)));
    expect({
      appOnly: [...appTerms].filter((t) => !ftsTerms.has(t)).sort(),
      indexOnly: [...ftsTerms].filter((t) => !appTerms.has(t)).sort(),
    }).toEqual({ appOnly: [], indexOnly: [] });
  });

  it('is the vocabulary `tokenSet` decides row membership with, not merely a function beside it', () => {
    // `tokenSet` is what `relevanceComponents` compares a row's text with, and
    // what the save-time candidate detector shares. Point it at the MATCH
    // tokenizer and the two paths disagree about what a token is.
    const viaTokenSet = new Set(TEXTS.flatMap((text) => [...tokenSet(text)]));
    expect({
      appOnly: [...viaTokenSet].filter((t) => !ftsTerms.has(t)).sort(),
      indexOnly: [...ftsTerms].filter((t) => !viaTokenSet.has(t)).sort(),
    }).toEqual({ appOnly: [], indexOnly: [] });
  });

  it('agrees text by text, not merely in aggregate', () => {
    const disagreements: { text: string; index: string[]; app: string[] }[] = [];
    TEXTS.forEach((text, i) => {
      const index = ftsTermsByRow.get(i + 1) ?? [];
      const app = [...new Set(indexTerms(text))].sort();
      if (JSON.stringify(index) !== JSON.stringify(app)) disagreements.push({ text, index, app });
    });
    expect(disagreements).toEqual([]);
  });

  it('does not fabricate a rare term out of punctuation or a diacritic', () => {
    expect(indexTerms('ejecución;')).toEqual(['ejecucion']);
    expect(indexTerms('"Prisma:"')).toEqual(['prisma']);
    for (const term of ['ejecucion', 'prisma']) expect(ftsTerms.has(term)).toBe(true);
  });
});
