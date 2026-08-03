import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  QUERY_TERMS_SCHEMA,
  QUERY_TERMS_TABLE,
  QUERY_TERMS_VOCAB_TABLE,
} from '../query-tokenizer.js';

/**
 * `null` means the index reported no such term — evidence, not a missing map
 * key. Every term the tokenizer produced is a key here, so the maximum weight
 * an absent term carries is applied on what the index said.
 */
export type QueryTermFrequencies = ReadonlyMap<string, number | null>;

/**
 * Corpus-wide term statistics behind the relevance level's IDF weighting, read
 * from `memory_fts_vocab` (the `fts5vocab` view over the postings `memory_fts`
 * already maintains).
 *
 * Deliberately unscoped — memory/spec.md, "The relevance level's term statistics
 * MUST come from the search index" — hence `admin*`, and both call sites are
 * pinned by name in data-access/spec.md, which also carries the argument for
 * admitting an agent-facing one.
 */
export class TermStatisticsRepository {
  constructor(private readonly db: Db) {}

  /** Must stay the same denominator the per-term counts are drawn from: every `memory` row, all scopes and statuses. */
  adminDocumentCount(): number {
    return this.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM memory`)?.n ?? 0;
  }

  /**
   * Tokenises `text` through the index's own tokenizer and resolves each term's
   * document frequency in the same read — memory/spec.md, "Term-statistics
   * lookups MUST be keyed on the index's own terms". The `LEFT JOIN` is what
   * makes an absent term reportable rather than inferable from a gap.
   */
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
