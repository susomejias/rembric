import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  QUERY_TERMS_SCHEMA,
  QUERY_TERMS_TABLE,
  QUERY_TERMS_VOCAB_TABLE,
} from '../query-tokenizer.js';

export type QueryTermFrequencies = ReadonlyMap<string, number | null>;

export class TermStatisticsRepository {
  constructor(private readonly db: Db) {}

  /** Must stay the same denominator the per-term counts are drawn from: every `memory` row, all scopes and statuses. */
  adminDocumentCount(): number {
    return this.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM memory`)?.n ?? 0;
  }

  adminQueryTermFrequencies(text: string): Map<string, number | null> {
    const table = sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE}`);
    this.db.run(sql`INSERT INTO ${table}(${sql.raw(QUERY_TERMS_TABLE)}) VALUES('delete-all')`);
    this.db.run(sql`INSERT INTO ${table}(rowid, body) VALUES (0, ${text})`);
    const rows = this.db.all<{ term: string; doc: number | null }>(sql`
      SELECT q.term AS term, v.doc AS doc
      FROM ${sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_VOCAB_TABLE}`)} q
      LEFT JOIN memory_fts_vocab v ON v.term = q.term
    `);
    return new Map(rows.map((r) => [r.term, r.doc]));
  }
}
