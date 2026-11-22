// Prototype DDL for the measured options. Never shipped: production code is unchanged in this phase.
//   per-project (E2): a view over one project's rows, an external-content FTS5 table over that view,
//                     and three triggers on `memory` routed by `WHEN new.project_id = '<id>'`.
//   The view exposes raw JSON tags, as `memory_fts`'s own 'rebuild' reads `memory.tags`: FTS5 cannot
//   rebuild from a view that calls json_each (`no such table: main.json_each`), and the tokenizer drops the JSON punctuation.
//   E1:               one FTS5 table over every row with a fourth `project_id` column, AND-ed into the MATCH.
type Raw = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...a: unknown[]) => any;
    all: (...a: unknown[]) => any[];
    run: (...a: unknown[]) => unknown;
  };
};

const PROJECT_ID = /^[0-9A-Za-z]{26}$/;
const FLAT = (side: 'new' | 'old') =>
  `coalesce((SELECT group_concat(value, ' ') FROM json_each(${side}.tags)), '')`;

export const projectTable = (projectId: string): string => {
  if (!PROJECT_ID.test(projectId)) throw new Error(`unexpected project id: ${projectId}`);
  return `memory_fts_p_${projectId.toLowerCase()}`;
};

export function createProjectIndex(
  raw: Raw,
  projectId: string,
  opts: { rebuild?: boolean } = {},
): void {
  const t = projectTable(projectId);
  raw.exec(`
    CREATE VIEW ${t}_src AS
      SELECT rowid AS rowid, content, tags, title FROM memory WHERE project_id = '${projectId}';
    CREATE VIRTUAL TABLE ${t} USING fts5(content, tags, title, content='${t}_src', content_rowid='rowid');
    CREATE TRIGGER ${t}_ai AFTER INSERT ON memory WHEN new.project_id = '${projectId}' BEGIN
      INSERT INTO ${t}(rowid, content, tags, title) VALUES (new.rowid, new.content, ${FLAT('new')}, new.title);
    END;
    CREATE TRIGGER ${t}_ad AFTER DELETE ON memory WHEN old.project_id = '${projectId}' BEGIN
      INSERT INTO ${t}(${t}, rowid, content, tags, title) VALUES ('delete', old.rowid, old.content, ${FLAT('old')}, old.title);
    END;
    CREATE TRIGGER ${t}_au AFTER UPDATE OF content, tags, title ON memory WHEN old.project_id = '${projectId}' BEGIN
      INSERT INTO ${t}(${t}, rowid, content, tags, title) VALUES ('delete', old.rowid, old.content, ${FLAT('old')}, old.title);
      INSERT INTO ${t}(rowid, content, tags, title) VALUES (new.rowid, new.content, ${FLAT('new')}, new.title);
    END;
  `);
  if (opts.rebuild !== false) raw.exec(`INSERT INTO ${t}(${t}) VALUES ('rebuild')`);
}

export function createProjectVocab(raw: Raw, projectId: string): string {
  const t = projectTable(projectId);
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${t}_vocab USING fts5vocab(main, '${t}', 'row')`,
  );
  return `temp.${t}_vocab`;
}

export function createE1(raw: Raw): void {
  raw.exec(`
    CREATE VIEW memory_fts_e1_src AS
      SELECT rowid AS rowid, content, tags, title, project_id FROM memory;
    CREATE VIRTUAL TABLE memory_fts_e1 USING fts5(content, tags, title, project_id, content='memory_fts_e1_src', content_rowid='rowid');
    CREATE TRIGGER memory_fts_e1_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts_e1(rowid, content, tags, title, project_id) VALUES (new.rowid, new.content, ${FLAT('new')}, new.title, new.project_id);
    END;
    CREATE TRIGGER memory_fts_e1_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts_e1(memory_fts_e1, rowid, content, tags, title, project_id) VALUES ('delete', old.rowid, old.content, ${FLAT('old')}, old.title, old.project_id);
    END;
    CREATE TRIGGER memory_fts_e1_au AFTER UPDATE OF content, tags, title ON memory BEGIN
      INSERT INTO memory_fts_e1(memory_fts_e1, rowid, content, tags, title, project_id) VALUES ('delete', old.rowid, old.content, ${FLAT('old')}, old.title, old.project_id);
      INSERT INTO memory_fts_e1(rowid, content, tags, title, project_id) VALUES (new.rowid, new.content, ${FLAT('new')}, new.title, new.project_id);
    END;
    INSERT INTO memory_fts_e1(memory_fts_e1) VALUES ('rebuild');
  `);
}

export function dropGlobalTriggers(raw: Raw): void {
  raw.exec('DROP TRIGGER memory_ai; DROP TRIGGER memory_ad; DROP TRIGGER memory_au;');
}

// The same read as TermStatisticsRepository.adminTokenTermFrequencies, joined to any vocabulary table.
export function tokenTermFrequencies(
  raw: Raw,
  vocab: string,
  tokens: readonly string[],
): { term: string; documentFrequency: number | null }[][] {
  const out: { term: string; documentFrequency: number | null }[][] = tokens.map(() => []);
  if (tokens.length === 0) return out;
  raw
    .prepare(`INSERT INTO temp.rembric_query_terms(rembric_query_terms) VALUES('delete-all')`)
    .run();
  raw
    .prepare(
      `INSERT INTO temp.rembric_query_terms(rowid, body) SELECT key, value FROM json_each(?)`,
    )
    .run(JSON.stringify(tokens));
  const rows = raw
    .prepare(
      `SELECT i.doc AS token, i.term AS term, v.doc AS doc
       FROM temp.rembric_query_terms_instance i LEFT JOIN ${vocab} v ON v.term = i.term
       ORDER BY i.doc, i.offset`,
    )
    .all();
  for (const r of rows) out[r.token]!.push({ term: r.term, documentFrequency: r.doc });
  return out;
}

export function queryTermFrequencies(raw: Raw, vocabs: readonly string[], text: string) {
  raw
    .prepare(`INSERT INTO temp.rembric_query_terms(rembric_query_terms) VALUES('delete-all')`)
    .run();
  raw.prepare(`INSERT INTO temp.rembric_query_terms(rowid, body) VALUES (0, ?)`).run(text);
  const sum = vocabs
    .map((v) => `coalesce((SELECT doc FROM ${v} WHERE term = q.term), 0)`)
    .join(' + ');
  return new Map(
    raw
      .prepare(`SELECT q.term AS term, ${sum} AS doc FROM temp.rembric_query_terms_vocab q`)
      .all()
      .map((r) => [r.term, r.doc]),
  );
}

export function bytesOf(raw: Raw, like: string, notLike?: string): number {
  return (
    raw
      .prepare(
        `SELECT coalesce(sum(pgsize), 0) AS b FROM dbstat WHERE name LIKE ? ${notLike ? 'AND name NOT LIKE ?' : ''}`,
      )
      .get(...(notLike ? [like, notLike] : [like])).b ?? 0
  );
}
