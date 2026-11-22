// Eval-only prototype, copied by apply.py into a scratch clone as packages/db/src/prototype-project-fts.ts.
// PROTO selects the option: a (per-project for save-time and search), b (per-project for save-time, project statistics),
// bG (per-project for save-time, global statistics), c (E1 for save-time and search). Unset = status quo.
import type { Db } from './client.js';

export const PROTO = process.env.PROTO ?? '';

type Raw = { exec: (s: string) => void; prepare: (s: string) => { get: () => unknown } };
const rawOf = (db: Db): Raw => (db as unknown as { $client: Raw }).$client;

const ensured = new WeakMap<object, Set<string>>();
function once(db: Db, key: string, ddl: () => string): void {
  const raw = rawOf(db);
  let seen = ensured.get(raw);
  if (!seen) ensured.set(raw, (seen = new Set()));
  if (seen.has(key)) return;
  const exists = raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = '${key}'`).get();
  if (!exists) raw.exec(ddl());
  seen.add(key);
}

export function projectTable(db: Db, projectId: string): string {
  if (!/^[0-9A-Za-z]{26}$/.test(projectId)) throw new Error(`unexpected project id: ${projectId}`);
  const t = `memory_fts_p_${projectId.toLowerCase()}`;
  const flat = (s: string) =>
    `coalesce((SELECT group_concat(value, ' ') FROM json_each(${s}.tags)), '')`;
  once(
    db,
    t,
    () => `
    CREATE VIEW ${t}_src AS SELECT rowid AS rowid, content, tags, title FROM memory WHERE project_id = '${projectId}';
    CREATE VIRTUAL TABLE ${t} USING fts5(content, tags, title, content='${t}_src', content_rowid='rowid');
    CREATE TRIGGER ${t}_ai AFTER INSERT ON memory WHEN new.project_id = '${projectId}' BEGIN
      INSERT INTO ${t}(rowid, content, tags, title) VALUES (new.rowid, new.content, ${flat('new')}, new.title);
    END;
    CREATE TRIGGER ${t}_ad AFTER DELETE ON memory WHEN old.project_id = '${projectId}' BEGIN
      INSERT INTO ${t}(${t}, rowid, content, tags, title) VALUES ('delete', old.rowid, old.content, ${flat('old')}, old.title);
    END;
    CREATE TRIGGER ${t}_au AFTER UPDATE OF content, tags, title ON memory WHEN old.project_id = '${projectId}' BEGIN
      INSERT INTO ${t}(${t}, rowid, content, tags, title) VALUES ('delete', old.rowid, old.content, ${flat('old')}, old.title);
      INSERT INTO ${t}(rowid, content, tags, title) VALUES (new.rowid, new.content, ${flat('new')}, new.title);
    END;
    INSERT INTO ${t}(${t}) VALUES ('rebuild');`,
  );
  return t;
}

export function projectVocab(db: Db, projectId: string): string {
  const t = projectTable(db, projectId);
  rawOf(db).exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${t}_vocab USING fts5vocab(main, '${t}', 'row')`,
  );
  return `temp.${t}_vocab`;
}

export function e1Table(db: Db): string {
  const flat = (s: string) =>
    `coalesce((SELECT group_concat(value, ' ') FROM json_each(${s}.tags)), '')`;
  once(
    db,
    'memory_fts_e1',
    () => `
    CREATE VIEW memory_fts_e1_src AS SELECT rowid AS rowid, content, tags, title, project_id FROM memory;
    CREATE VIRTUAL TABLE memory_fts_e1 USING fts5(content, tags, title, project_id, content='memory_fts_e1_src', content_rowid='rowid');
    CREATE TRIGGER memory_fts_e1_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts_e1(rowid, content, tags, title, project_id) VALUES (new.rowid, new.content, ${flat('new')}, new.title, new.project_id);
    END;
    CREATE TRIGGER memory_fts_e1_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts_e1(memory_fts_e1, rowid, content, tags, title, project_id) VALUES ('delete', old.rowid, old.content, ${flat('old')}, old.title, old.project_id);
    END;
    CREATE TRIGGER memory_fts_e1_au AFTER UPDATE OF content, tags, title ON memory BEGIN
      INSERT INTO memory_fts_e1(memory_fts_e1, rowid, content, tags, title, project_id) VALUES ('delete', old.rowid, old.content, ${flat('old')}, old.title, old.project_id);
      INSERT INTO memory_fts_e1(rowid, content, tags, title, project_id) VALUES (new.rowid, new.content, ${flat('new')}, new.title, new.project_id);
    END;
    INSERT INTO memory_fts_e1(memory_fts_e1) VALUES ('rebuild');`,
  );
  return 'memory_fts_e1';
}
