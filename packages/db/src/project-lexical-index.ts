import type Database from 'better-sqlite3';

import { inheritedFts5Arguments, QUERY_TERMS_SCHEMA } from './query-tokenizer.js';

export const PROJECT_LEXICAL_INDEX_PREFIX = 'memory_fts_p_';

const OBJECT_NAME = /^memory_fts_p_((?:[0-9a-f]{2})+)(?:_(src|ai|ad|au|data|idx|docsize|config))?$/;

interface IndexObject {
  type: 'view' | 'table' | 'trigger';
  name: string;
  sql: string;
}

export function projectLexicalIndexName(projectId: string): string {
  return `${PROJECT_LEXICAL_INDEX_PREFIX}${Buffer.from(projectId, 'utf8').toString('hex')}`;
}

export function projectIdOfLexicalIndexObject(name: string): string | undefined {
  const hex = OBJECT_NAME.exec(name)?.[1];
  return hex === undefined ? undefined : Buffer.from(hex, 'hex').toString('utf8');
}

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const flatTags = (tags: string): string =>
  `coalesce((SELECT group_concat(value, ' ') FROM json_each(${tags})), '')`;

function indexObjects(sqlite: Database.Database, projectId: string): IndexObject[] {
  const t = projectLexicalIndexName(projectId);
  const id = literal(projectId);
  const declaration = sqlite
    .prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'memory_fts'`)
    .get()?.sql;
  if (!declaration) throw new Error('cannot derive a project lexical index: memory_fts is absent');
  const args = [
    'content',
    'tags',
    'title',
    ...inheritedFts5Arguments(declaration),
    `content='${t}_src'`,
    "content_rowid='rowid'",
  ].join(', ');
  const insertNew = `INSERT INTO ${t}(rowid, content, tags, title) VALUES (new.rowid, new.content, ${flatTags('new.tags')}, new.title);`;
  const deleteOld = `INSERT INTO ${t}(${t}, rowid, content, tags, title) VALUES ('delete', old.rowid, old.content, ${flatTags('old.tags')}, old.title);`;
  return [
    {
      type: 'view',
      name: `${t}_src`,
      sql: `CREATE VIEW ${t}_src AS SELECT rowid AS rowid, content, tags, title FROM memory WHERE project_id = ${id}`,
    },
    { type: 'table', name: t, sql: `CREATE VIRTUAL TABLE ${t} USING fts5(${args})` },
    {
      type: 'trigger',
      name: `${t}_ai`,
      sql: `CREATE TRIGGER ${t}_ai AFTER INSERT ON memory WHEN new.project_id = ${id} BEGIN ${insertNew} END`,
    },
    {
      type: 'trigger',
      name: `${t}_ad`,
      sql: `CREATE TRIGGER ${t}_ad AFTER DELETE ON memory WHEN old.project_id = ${id} BEGIN ${deleteOld} END`,
    },
    {
      type: 'trigger',
      name: `${t}_au`,
      sql: `CREATE TRIGGER ${t}_au AFTER UPDATE OF content, tags, title ON memory WHEN old.project_id = ${id} BEGIN ${deleteOld} ${insertNew} END`,
    },
  ];
}

function storedObjects(sqlite: Database.Database): { type: string; name: string; sql: string }[] {
  return sqlite
    .prepare<[string], { type: string; name: string; sql: string | null }>(
      `SELECT type, name, sql FROM sqlite_master WHERE substr(name, 1, ${PROJECT_LEXICAL_INDEX_PREFIX.length}) = ?`,
    )
    .all(PROJECT_LEXICAL_INDEX_PREFIX)
    .map((r) => ({ type: r.type, name: r.name, sql: r.sql ?? '' }));
}

function dropObjects(sqlite: Database.Database, projectId: string): void {
  const own = storedObjects(sqlite).filter(
    (o) => projectIdOfLexicalIndexObject(o.name) === projectId,
  );
  for (const o of own.filter((x) => x.type === 'trigger')) sqlite.exec(`DROP TRIGGER ${o.name}`);
  ensuredOn(sqlite).delete(projectId);
  const t = projectLexicalIndexName(projectId);
  if (own.some((o) => o.name === t)) sqlite.exec(`DROP TABLE ${t}`);
  if (own.some((o) => o.name === `${t}_src`)) sqlite.exec(`DROP VIEW ${t}_src`);
}

function build(sqlite: Database.Database, projectId: string, objects: IndexObject[]): void {
  const t = projectLexicalIndexName(projectId);
  for (const o of objects) sqlite.exec(o.sql);
  sqlite
    .prepare(
      `INSERT INTO ${t}(rowid, content, tags, title)
       SELECT rowid, content, ${flatTags('memory.tags')}, title FROM memory WHERE project_id = ?`,
    )
    .run(projectId);
}

const ensured = new WeakMap<Database.Database, Set<string>>();
const vocabularies = new WeakMap<Database.Database, Set<string>>();

function ensuredOn(sqlite: Database.Database): Set<string> {
  let ids = ensured.get(sqlite);
  if (!ids) ensured.set(sqlite, (ids = new Set()));
  return ids;
}

function remember(sqlite: Database.Database, projectId: string): void {
  if (!sqlite.inTransaction) ensuredOn(sqlite).add(projectId);
}

export function ensureProjectLexicalIndex(sqlite: Database.Database, projectId: string): void {
  if (ensuredOn(sqlite).has(projectId)) return;
  const present = sqlite
    .prepare<
      [string],
      { n: number }
    >(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(projectLexicalIndexName(projectId))!.n;
  if (present === 0) {
    dropObjects(sqlite, projectId);
    build(sqlite, projectId, indexObjects(sqlite, projectId));
  }
  remember(sqlite, projectId);
}

export function projectLexicalVocabulary(sqlite: Database.Database, projectId: string): string {
  ensureProjectLexicalIndex(sqlite, projectId);
  const t = projectLexicalIndexName(projectId);
  const vocab = `${QUERY_TERMS_SCHEMA}.${t}_vocab`;
  let created = vocabularies.get(sqlite);
  if (!created) vocabularies.set(sqlite, (created = new Set()));
  if (!created.has(projectId)) {
    sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vocab} USING fts5vocab(main, '${t}', 'row')`);
    created.add(projectId);
  }
  return vocab;
}

export function reconcileProjectLexicalIndexes(sqlite: Database.Database): {
  built: string[];
  dropped: string[];
} {
  const projects = sqlite
    .prepare<[], { id: string }>('SELECT id FROM projects ORDER BY id')
    .all()
    .map((r) => r.id);
  const known = new Set(projects);
  const stored = new Map(storedObjects(sqlite).map((o) => [o.name, o.sql]));
  const dropped = [
    ...new Set(
      [...stored.keys()]
        .map(projectIdOfLexicalIndexObject)
        .filter((id): id is string => id !== undefined && !known.has(id)),
    ),
  ].sort();
  const built: string[] = [];
  sqlite
    .transaction(() => {
      for (const id of dropped) dropObjects(sqlite, id);
      for (const id of projects) {
        const objects = indexObjects(sqlite, id);
        if (objects.every((o) => stored.get(o.name) === o.sql)) continue;
        dropObjects(sqlite, id);
        build(sqlite, id, objects);
        built.push(id);
      }
    })
    .immediate();
  for (const id of projects) remember(sqlite, id);
  return { built, dropped };
}
