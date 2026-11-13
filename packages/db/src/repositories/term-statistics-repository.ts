import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { projectLexicalVocabulary } from '../project-lexical-index.js';
import {
  QUERY_TERMS_INSTANCE_TABLE,
  QUERY_TERMS_SCHEMA,
  QUERY_TERMS_TABLE,
  QUERY_TERMS_VOCAB_TABLE,
} from '../query-tokenizer.js';
import type { Scope } from '../scope.js';

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

  projectDocumentCount(scope: Scope): number {
    return (
      this.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM memory WHERE scope = 'project' AND project_id = ${scope.projectId}`,
      )?.n ?? 0
    );
  }

  /** Tokenises each token on its own, so a multi-term phrase is told apart from one term. */
  projectTokenTermFrequencies(scope: Scope, tokens: readonly string[]): TokenTermFrequency[][] {
    const out: TokenTermFrequency[][] = tokens.map(() => []);
    if (tokens.length === 0) return out;
    const vocab = sql.raw(projectLexicalVocabulary(this.db.$client, scope.projectId));
    const table = sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE}`);
    this.db.run(sql`INSERT INTO ${table}(${sql.raw(QUERY_TERMS_TABLE)}) VALUES('delete-all')`);
    this.db.run(
      sql`INSERT INTO ${table}(rowid, body) SELECT key, value FROM json_each(${JSON.stringify(tokens)})`,
    );
    const rows = this.db.all<{ token: number; term: string; doc: number | null }>(sql`
      SELECT i.doc AS token, i.term AS term, v.doc AS doc
      FROM ${sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_INSTANCE_TABLE}`)} i
      LEFT JOIN ${vocab} v ON v.term = i.term
      ORDER BY i.doc, i.offset
    `);
    for (const r of rows) out[r.token]!.push({ term: r.term, documentFrequency: r.doc });
    return out;
  }
}
