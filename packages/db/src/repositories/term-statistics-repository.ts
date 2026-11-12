import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  QUERY_TERMS_INSTANCE_TABLE,
  QUERY_TERMS_SCHEMA,
  QUERY_TERMS_TABLE,
  QUERY_TERMS_VOCAB_TABLE,
} from '../query-tokenizer.js';

export type QueryTermFrequencies = ReadonlyMap<string, number | null>;

export interface TokenTermFrequency {
  term: string;
  documentFrequency: number | null;
}

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

  /** Tokenises each token on its own, so a multi-term phrase is told apart from one term. */
  adminTokenTermFrequencies(tokens: readonly string[]): TokenTermFrequency[][] {
    const out: TokenTermFrequency[][] = tokens.map(() => []);
    if (tokens.length === 0) return out;
    const table = sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE}`);
    this.db.run(sql`INSERT INTO ${table}(${sql.raw(QUERY_TERMS_TABLE)}) VALUES('delete-all')`);
    this.db.run(
      sql`INSERT INTO ${table}(rowid, body) SELECT key, value FROM json_each(${JSON.stringify(tokens)})`,
    );
    const rows = this.db.all<{ token: number; term: string; doc: number | null }>(sql`
      SELECT i.doc AS token, i.term AS term, v.doc AS doc
      FROM ${sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_INSTANCE_TABLE}`)} i
      LEFT JOIN memory_fts_vocab v ON v.term = i.term
      ORDER BY i.doc, i.offset
    `);
    for (const r of rows) out[r.token]!.push({ term: r.term, documentFrequency: r.doc });
    return out;
  }
}
