# Applies the eval-only prototype to a SCRATCH CLONE of the repository (never to a checkout under review).
# Usage: python3 -I apply.py <clone-root>; then `pnpm --filter @rembric/db build` in the clone and run the evals with PROTO=a|b|bG|c.
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1])
here = pathlib.Path(__file__).resolve().parent


def edit(rel, old, new):
    p = root / rel
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'anchor not found in {rel}: {old[:60]!r}')
    p.write_text(s.replace(old, new, 1))


shutil.copy(here / 'prototype-project-fts.mts', root / 'packages/db/src/prototype-project-fts.ts')
edit('packages/db/src/index.ts', "export * from './scope.js';", "export * from './scope.js';\nexport * from './prototype-project-fts.js';")

mr = 'packages/db/src/repositories/memory-repository.ts'
edit(mr, "import { idJsonSet,", "import { PROTO, e1Table, projectTable, projectVocab } from '../prototype-project-fts.js';\nimport { idJsonSet,")
edit(mr, """    }>(
      sql`
        SELECT m.id AS id, bm25(memory_fts) AS rank, m.title AS title, m.content AS content,
               m.topic_key AS topicKey
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}""", """    }>(
      sql`
        SELECT m.id AS id, ${protoRank} AS rank, m.title AS title, m.content AS content,
               m.topic_key AS topicKey
        FROM ${protoT}
          JOIN memory m ON m.rowid = ${protoT}.rowid
        WHERE ${protoT} MATCH ${protoMatch}""")
edit(mr, """        ORDER BY bm25(memory_fts)
        LIMIT ${opts.limit}""", """        ORDER BY ${protoRank}
        LIMIT ${opts.limit}""")
edit(mr, """  }): { id: string; rank: number; title: string; content: string; topicKey: string | null }[] {
""", """  }): { id: string; rank: number; title: string; content: string; topicKey: string | null }[] {
    const tName = PROTO === 'a' || PROTO === 'b' || PROTO === 'bG' ? projectTable(this.db, opts.projectId) : PROTO === 'c' ? e1Table(this.db) : 'memory_fts';
    const protoT = sql.raw(tName);
    const protoRank = sql.raw(PROTO === 'c' ? `bm25(${tName}, 1.0, 1.0, 1.0, 0.0)` : `bm25(${tName})`);
    const protoMatch = PROTO === 'c' ? `{content tags title} : (${opts.matchExpr}) AND project_id : "${opts.projectId}"` : opts.matchExpr;
""")
edit(mr, """    const rank = sql`bm25(memory_fts, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE})`;
    const matched = sql`
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}""", """    if (PROTO === 'a') {
      const subs = projectIdsOf(opts.scope).map((pid) => {
        const t = sql.raw(projectTable(this.db, pid));
        return sql`SELECT * FROM (SELECT m.id AS id, bm25(${t}, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE}) AS rank
          FROM ${t} JOIN memory m ON m.rowid = ${t}.rowid
          WHERE ${t} MATCH ${opts.matchExpr} AND ${scopeWhere(opts.scope, 'm')} ${statusClause} ${typeClause} ${tagClause} ${topicKeyClause}
          ORDER BY rank LIMIT ${opts.limit})`;
      });
      return this.db.all<{ id: string; rank: number }>(sql`SELECT id, rank FROM (${sql.join(subs, sql` UNION ALL `)}) ORDER BY rank`);
    }
    const tName = PROTO === 'c' ? e1Table(this.db) : 'memory_fts';
    const t = sql.raw(tName);
    const protoMatch = PROTO === 'c'
      ? `{content tags title} : (${opts.matchExpr}) AND project_id : (${projectIdsOf(opts.scope).map((i) => `"${i}"`).join(' OR ')})`
      : opts.matchExpr;
    const rank = PROTO === 'c'
      ? sql`bm25(${t}, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE}, 0.0)`
      : sql`bm25(${t}, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE})`;
    const matched = sql`
        FROM ${t}
          JOIN memory m ON m.rowid = ${t}.rowid
        WHERE ${t} MATCH ${protoMatch}""")
# projectVocab is imported for the term-statistics file below; keep the import used.
edit(mr, "const FTS_WEIGHT_CONTENT = 1.0;", "void projectVocab;\nconst FTS_WEIGHT_CONTENT = 1.0;")

ts = 'packages/db/src/repositories/term-statistics-repository.ts'
edit(ts, "import type { Db } from '../client.js';", "import type { Db } from '../client.js';\nimport { projectVocab } from '../prototype-project-fts.js';")
edit(ts, """  /** Tokenises each token on its own""", """  adminDocumentCountIn(projectIds: readonly string[]): number {
    return (
      this.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM memory WHERE project_id IN (SELECT value FROM json_each(${JSON.stringify(projectIds)}))`,
      )?.n ?? 0
    );
  }

  adminQueryTermFrequenciesIn(projectIds: readonly string[], text: string): Map<string, number | null> {
    const table = sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE}`);
    this.db.run(sql`INSERT INTO ${table}(${sql.raw(QUERY_TERMS_TABLE)}) VALUES('delete-all')`);
    this.db.run(sql`INSERT INTO ${table}(rowid, body) VALUES (0, ${text})`);
    const sum = projectIds
      .map((pid) => `coalesce((SELECT doc FROM ${projectVocab(this.db, pid)} WHERE term = q.term), 0)`)
      .join(' + ');
    const rows = this.db.all<{ term: string; doc: number }>(
      sql`SELECT q.term AS term, ${sql.raw(sum)} AS doc FROM ${sql.raw(`${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_VOCAB_TABLE}`)} q`,
    );
    return new Map(rows.map((r) => [r.term, r.doc === 0 ? null : r.doc]));
  }

  adminTokenTermFrequenciesIn(projectId: string, tokens: readonly string[]): TokenTermFrequency[][] {
    const out: TokenTermFrequency[][] = tokens.map(() => []);
    if (tokens.length === 0) return out;
    const vocab = sql.raw(projectVocab(this.db, projectId));
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

  /** Tokenises each token on its own""")

sc = 'packages/core/src/services/save-time-candidates.ts'
edit(sc, """    saved.content,
    opts.commonTermRatio === undefined ? COMMON_TERM_DOCUMENT_RATIO : opts.commonTermRatio,
  );""", """    saved.content,
    opts.commonTermRatio === undefined ? COMMON_TERM_DOCUMENT_RATIO : opts.commonTermRatio,
    projectId,
  );""")
edit(sc, """  content: string,
  commonTermRatio: number | null,
): string {
  const tokens = ftsQueryTokens(content, { maxTerms: 16 });
  if (tokens.length === 0 || commonTermRatio === null) return joinFtsTokens(tokens);""", """  content: string,
  commonTermRatio: number | null,
  projectId?: string,
): string {
  const tokens = ftsQueryTokens(content, { maxTerms: 16 });
  if (tokens.length === 0 || commonTermRatio === null) return joinFtsTokens(tokens);
  if ((PROTO === 'a' || PROTO === 'b') && projectId !== undefined) {
    const stats = termStatistics as unknown as {
      adminTokenTermFrequenciesIn: (p: string, t: readonly string[]) => TokenTermFrequency[][];
      adminDocumentCountIn: (p: readonly string[]) => number;
    };
    return joinFtsTokens(
      pruneCommonTokens(
        tokens,
        stats.adminTokenTermFrequenciesIn(projectId, tokens),
        stats.adminDocumentCountIn([projectId]),
        commonTermRatio,
      ),
    );
  }""")
edit(sc, "import {", "import { PROTO } from '@rembric/db';\nimport {")

hs = 'packages/core/src/services/hybrid-search.ts'
edit(hs, """  const documentCount = opts.repos.termStatistics.adminDocumentCount();
  const documentFrequencies = opts.repos.termStatistics.adminQueryTermFrequencies(opts.query);""", """  const statsIn = opts.repos.termStatistics as unknown as {
    adminDocumentCountIn: (p: readonly string[]) => number;
    adminQueryTermFrequenciesIn: (p: readonly string[], q: string) => Map<string, number | null>;
  };
  const documentCount =
    PROTO === 'a'
      ? statsIn.adminDocumentCountIn(projectIdsOf(opts.scope))
      : opts.repos.termStatistics.adminDocumentCount();
  const documentFrequencies =
    PROTO === 'a'
      ? statsIn.adminQueryTermFrequenciesIn(projectIdsOf(opts.scope), opts.query)
      : opts.repos.termStatistics.adminQueryTermFrequencies(opts.query);""")
edit(hs, "import {", "import { PROTO, projectIdsOf } from '@rembric/db';\nimport {")
print('applied')
