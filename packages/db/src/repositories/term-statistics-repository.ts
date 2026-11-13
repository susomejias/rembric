import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { projectLexicalVocabulary } from '../project-lexical-index.js';
import {
  QUERY_TERMS_INSTANCE_TABLE,
  QUERY_TERMS_SCHEMA,
  QUERY_TERMS_TABLE,
} from '../query-tokenizer.js';
import type { Scope } from '../scope.js';

export type QueryTermFrequencies = ReadonlyMap<string, number | null>;

export interface TokenTermFrequency {
  term: string;
  documentFrequency: number | null;
}

export interface SearchTermFrequencies {
  query: Map<string, number | null>;
  tokens: TokenTermFrequency[][];
}

export class TermStatisticsRepository {
  constructor(private readonly db: Db) {}

  /** Must stay the same denominator the per-term counts are drawn from: every `memory` row, all scopes and statuses. */
  adminDocumentCount(): number {
    return this.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM memory`)?.n ?? 0;
  }

  adminQueryTermFrequencies(text: string): Map<string, number | null> {
    return this.adminSearchTermFrequencies(text, []).query;
  }

  /** `query` is keyed in term order; each distinct term's document count is read once. */
  adminSearchTermFrequencies(query: string, tokens: readonly string[]): SearchTermFrequencies {
    const out: SearchTermFrequencies = { query: new Map(), tokens: tokens.map(() => []) };
    const table = sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE}`);
    const instances = sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_INSTANCE_TABLE}`);
    this.db.run(sql`INSERT INTO ${table}(${sql.raw(QUERY_TERMS_TABLE)}) VALUES('delete-all')`);
    this.db.run(
      sql`INSERT INTO ${table}(rowid, body) SELECT key, value FROM json_each(${JSON.stringify([query, ...tokens])})`,
    );
    const rows = this.db.all<{ row: number; term: string; doc: number | null }>(sql`
      WITH f AS MATERIALIZED (
        SELECT t.term AS term, v.doc AS doc
        FROM (SELECT DISTINCT term FROM ${instances}) t
        LEFT JOIN memory_fts_vocab v ON v.term = t.term
      )
      SELECT i.doc AS row, i.term AS term, f.doc AS doc
      FROM ${instances} i
        JOIN f ON f.term = i.term
      ORDER BY i.doc, CASE WHEN i.doc = 0 THEN i.term END, i.offset
    `);
    for (const r of rows) {
      if (r.row === 0) out.query.set(r.term, r.doc);
      else out.tokens[r.row - 1]!.push({ term: r.term, documentFrequency: r.doc });
    }
    return out;
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
