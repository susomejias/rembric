import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/index.js';
import { ALL_TABLES, SHADOW_TABLE_NAMES } from '../test/schema-inventory.js';

import {
  createQueryTokenizerTables,
  deriveQueryTokenizerDdl,
  inheritedFts5Arguments,
  QUERY_TERMS_TABLE,
  QUERY_TERMS_VOCAB_TABLE,
  UnrecognisedFts5OptionError,
} from './query-tokenizer.js';
import { createRepositories, type Repositories } from './repositories/index.js';

/**
 * The tokenising table's declaration comes from `memory_fts`'s own, read out of
 * `sqlite_master`, so the two cannot be edited into disagreement — memory/spec.md,
 * "The tokenising table inherits the index's declared tokenizer".
 */
describe('the query-tokenising declaration is derived, not restated', () => {
  let scratchDir: string;
  let raw: Database.Database;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'rembric-qtok-'));
  });

  afterEach(() => {
    try {
      raw?.close();
    } catch {
      // ignore double-close
    }
    rmSync(scratchDir, { recursive: true, force: true });
  });

  /** A database whose only content is a `memory_fts` declared exactly as given. */
  function withIndexDeclaredAs(args: string): Database.Database {
    raw = new Database(join(scratchDir, 'data.db'));
    raw.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(${args})`);
    raw.exec(`CREATE VIRTUAL TABLE memory_fts_vocab USING fts5vocab('memory_fts','row')`);
    return raw;
  }

  function termsOf(db: Database.Database, text: string): string[] {
    db.prepare(`INSERT INTO temp.${QUERY_TERMS_TABLE}(rowid, body) VALUES (0, ?)`).run(text);
    return db
      .prepare<[], { term: string }>(
        `SELECT term FROM temp.${QUERY_TERMS_VOCAB_TABLE} ORDER BY term`,
      )
      .all()
      .map((r) => r.term);
  }

  it('carries a tokenizer option the index declares', () => {
    const db = withIndexDeclaredAs(
      `content, tags, content='memory', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2"`,
    );
    const inherited = createQueryTokenizerTables(db);
    expect(inherited).toEqual([`tokenize="unicode61 remove_diacritics 2"`]);
    // `remove_diacritics 2` folds the Vietnamese horn+hook; the default does not.
    expect(termsOf(db, 'phở')).toEqual(['pho']);
  });

  it('CONTROL: the shipped declaration carries no tokenizer, and the same text does not fold', () => {
    const db = withIndexDeclaredAs(`content, tags, content='memory', content_rowid='rowid'`);
    expect(createQueryTokenizerTables(db)).toEqual([]);
    expect(termsOf(db, 'phở')).toEqual(['phở']);
  });

  it('fails naming an option the derivation does not recognise, rather than dropping it', () => {
    const declaration = `CREATE VIRTUAL TABLE memory_fts USING fts5(content, tokenchars='-_')`;
    expect(() => inheritedFts5Arguments(declaration)).toThrow(UnrecognisedFts5OptionError);
    expect(() => inheritedFts5Arguments(declaration)).toThrow(/tokenchars/);
  });

  it('fails at startup, not on the first query', () => {
    // `contentless_delete` is a real fts5 option a later migration could add,
    // and one whose omission changes behaviour — so it must not be dropped.
    const db = withIndexDeclaredAs(`content, content='', contentless_delete=1`);
    expect(() => createQueryTokenizerTables(db)).toThrow(/contentless_delete/);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >(`SELECT count(*) AS n FROM temp.sqlite_master WHERE name = ?`)
        .get(QUERY_TERMS_TABLE)!.n,
    ).toBe(0);
  });

  it('drops the content options and replaces the index columns with one body column', () => {
    const { statements, inherited } = deriveQueryTokenizerDdl(
      `CREATE VIRTUAL TABLE \`memory_fts\` USING fts5(
         content,
         tags,
         content='memory',
         content_rowid='rowid',
         prefix='2 3',
         detail=full
      )`,
    );
    expect(inherited).toEqual([`prefix='2 3'`, 'detail=full']);
    expect(statements[0]).toBe(
      `CREATE VIRTUAL TABLE temp.${QUERY_TERMS_TABLE} USING fts5(body, content='', prefix='2 3', detail=full)`,
    );
    expect(statements[0]).not.toMatch(/content='memory'/);
    expect(statements[0]).not.toMatch(/content_rowid/);
  });

  it('splits on unquoted commas only, so a tokenizer argument list survives intact', () => {
    expect(
      inheritedFts5Arguments(
        `CREATE VIRTUAL TABLE x USING fts5(a, tokenize = 'porter unicode61 remove_diacritics 1', detail=none)`,
      ),
    ).toEqual([`tokenize = 'porter unicode61 remove_diacritics 1'`, 'detail=none']);
  });
});

describe('the query-tokenising table on the real migrated schema', () => {
  let db: TestDb;
  let repos: Repositories;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
  });
  afterEach(() => db.cleanup());

  const tempObjects = (): string[] =>
    db.handle.raw
      .prepare<[], { name: string }>(`SELECT name FROM temp.sqlite_master ORDER BY name`)
      .all()
      .map((r) => r.name);

  it('exists before any query runs, and inherits what the migrations declared', () => {
    expect(db.handle.queryTokenizer).toEqual([]);
    expect(tempObjects()).toContain(QUERY_TERMS_TABLE);
    expect(tempObjects()).toContain(QUERY_TERMS_VOCAB_TABLE);
  });

  it('stores no text: the contentless declaration means there is no content shadow table', () => {
    repos.termStatistics.adminQueryTermFrequencies('alpha beta gamma');
    expect(tempObjects()).not.toContain(`${QUERY_TERMS_TABLE}_content`);
    expect(
      db.handle.raw
        .prepare<
          [string],
          { n: number }
        >(`SELECT count(*) AS n FROM temp.sqlite_master WHERE sql LIKE ?`)
        .get('%alpha beta gamma%')!.n,
    ).toBe(0);
  });

  it('is absent from the durable schema, the migration ledger and the drift inventory', () => {
    const durable = db.handle.raw
      .prepare<[], { name: string }>(`SELECT name FROM main.sqlite_master`)
      .all()
      .map((r) => r.name);
    expect(durable).not.toContain(QUERY_TERMS_TABLE);
    expect(durable).not.toContain(QUERY_TERMS_VOCAB_TABLE);
    // Control: the durable vocabulary read IS in the schema, so the assertion
    // above is about the temp table and not about an empty list.
    expect(durable).toContain('memory_fts_vocab');

    const ledger = db.handle.raw
      .prepare<[], { filename: string }>(`SELECT filename FROM _migrations`)
      .all()
      .map((r) => r.filename);
    expect(ledger).toContain('0030_memory_fts_vocab.sql');
    expect(ledger.some((f) => f.includes('query_term'))).toBe(false);

    for (const name of [QUERY_TERMS_TABLE, QUERY_TERMS_VOCAB_TABLE]) {
      expect(ALL_TABLES).not.toContain(name);
      expect(SHADOW_TABLE_NAMES).not.toContain(name);
    }
    expect(ALL_TABLES).toContain('memory_fts_vocab');
  });

  it('does not grow the durable database or its WAL across many tokenisations', () => {
    const sizes = () => {
      const of = (suffix: string) => {
        try {
          return statSync(join(db.dataDir, `data.db${suffix}`)).size;
        } catch {
          return 0;
        }
      };
      return { db: of(''), wal: of('-wal') };
    };

    repos.termStatistics.adminQueryTermFrequencies('warmup query');
    const before = sizes();
    for (let i = 0; i < 2_000; i++) {
      repos.termStatistics.adminQueryTermFrequencies(`query ${i} with distinct term t${i}`);
    }
    expect(sizes()).toEqual(before);

    // Control: a durable write DOES move one of those numbers, so the equality
    // above is a property of the temp schema and not of the measurement.
    db.handle.raw
      .prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, status, created_at)
         VALUES ('grow', 'global', NULL, 'reference', 't', 'c', 'active', 0)`,
      )
      .run();
    const after = sizes();
    expect(after.db + after.wal).toBeGreaterThan(before.db + before.wal);
  });
});
