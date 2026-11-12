// Write-side cost of each option: one memory INSERT (the triggers are the whole FTS maintenance), project creation, connection open.
// Instruments, never tabulated together:
//   insert   — wall clock of one INSERT INTO memory, 200 rows per configuration, p50/p90:
//              "in-tx" times each INSERT inside one transaction that is rolled back (CPU of the triggers);
//              "commit" times each INSERT as its own autocommit transaction (WAL, synchronous=NORMAL, as production);
//   create   — wall clock of creating one project's index (view + FTS table + 3 triggers) on an existing database, p50;
//   open     — wall clock of opening a connection and preparing the save-time statement (schema parse), p50 of 5.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/scope-save-time-lexical-index-per-project/measurements/write-cost.mts <corpus-cache-dir>
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const P = await import(new URL('./prototype.mts', import.meta.url).href);
const { createDb, createRepositories } = await load('@rembric/db');
const { ProjectsService } = await load('@rembric/core');
const Database = createRequire(new URL('../../../../packages/db/package.json', import.meta.url))(
  'better-sqlite3',
);

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZE = Number(process.env.SIZE ?? 50_000);
const ROWS = 200;

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
const f = (xs: number[]) =>
  `p50 ${quantile(xs, 0.5).toFixed(3)} ms, p90 ${quantile(xs, 0.9).toFixed(3)} ms`;

const out = [
  `# Write-side cost per option, ${SIZE} rows`,
  'insert instrument: wall clock of one INSERT INTO memory (the FTS triggers fire inside it), 200 rows per configuration;',
  '  in-tx = each INSERT timed inside one rolled-back transaction; commit = each INSERT its own autocommit transaction (WAL, synchronous=NORMAL)',
  'create instrument: wall clock of creating one empty project index (view + FTS5 table + 3 triggers), p50 over the projects created',
  'open instrument: wall clock of new Database() + preparing the save-time statement (forces the schema parse), p50 of 5',
  "rows inserted: the content and title of the 2% project's rows, cycled, into the 2% project",
  'configurations:',
  '  d      status quo: memory_fts and its 3 triggers',
  '  b@P    d plus one per-project index per project (P projects in total; the extra projects are empty)',
  '  a@6    per-project indexes only: the global triggers dropped',
  '  c      E1 only: the global triggers dropped, E1 and its 3 triggers added',
  '',
];

function measure(label: string, dir: string, raw: any, pid: string): void {
  const src = raw
    .prepare('SELECT title, content, tags FROM memory WHERE project_id = ? ORDER BY rowid LIMIT 50')
    .all(pid);
  const insert = raw.prepare(
    `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at)
     VALUES (@id, 'project', @p, 'fact', @title, @content, @tags, 'active', '[]', @at)`,
  );
  const row = (i: number, tag: string) => ({
    ...src[i % src.length],
    id: `w-${tag}-${i}`,
    p: pid,
    at: Date.now(),
  });
  const inTx: number[] = [];
  raw.exec('BEGIN');
  for (let i = 0; i < ROWS; i += 1) {
    const t0 = performance.now();
    insert.run(row(i, 'tx'));
    inTx.push(performance.now() - t0);
  }
  raw.exec('ROLLBACK');
  const commit: number[] = [];
  for (let i = 0; i < ROWS; i += 1) {
    const t0 = performance.now();
    insert.run(row(i, 'c'));
    commit.push(performance.now() - t0);
  }
  raw.prepare(`DELETE FROM memory WHERE id LIKE 'w-c-%'`).run();
  const opens: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const db = new Database(join(dir, 'data.db'), { readonly: true });
    db.prepare(
      `SELECT m.id FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid WHERE memory_fts MATCH 'x' ORDER BY bm25(memory_fts) LIMIT 20`,
    );
    opens.push(performance.now() - t0);
    db.close();
  }
  const objects = raw.prepare('SELECT count(*) AS n FROM sqlite_master').get().n;
  out.push(
    `  ${label.padEnd(7)} insert in-tx ${f(inTx)} | insert commit ${f(commit)} | open p50 ${quantile(opens, 0.5).toFixed(2)} ms | schema objects ${objects}`,
  );
}

for (const corpus of ['generator-skew', 'realistic-skew'] as const) {
  out.push(`## ${corpus}`);
  const open = () => {
    const dir = freshCopy(CACHE, corpus, SIZE);
    const handle = createDb({ dataDir: dir, ...quiet });
    const repos = createRepositories(handle.db);
    const pid = repos.projects.findBySlug(slugForSlot(corpus, SHARE_SLOTS['2%'])).id;
    const ids: string[] = handle.raw
      .prepare('SELECT DISTINCT project_id AS id FROM memory WHERE project_id IS NOT NULL')
      .all()
      .map((r: { id: string }) => r.id);
    return { dir, handle, repos, raw: handle.raw, pid, ids };
  };

  {
    const { dir, handle, repos, raw, pid, ids } = open();
    measure('d', dir, raw, pid);
    for (const id of ids) P.createProjectIndex(raw, id);
    measure(`b@${ids.length}`, dir, raw, pid);
    const projects = new ProjectsService(repos);
    let total = ids.length;
    for (const target of [200, 1000]) {
      const creates: number[] = [];
      for (; total < target; total += 1) {
        const id = projects.create({ slug: `extra-${total}`, displayName: null }).id;
        const t0 = performance.now();
        P.createProjectIndex(raw, id, { rebuild: false });
        creates.push(performance.now() - t0);
      }
      measure(`b@${target}`, dir, raw, pid);
      out.push(`          create one project index (up to ${target} projects): ${f(creates)}`);
    }
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const { dir, handle, raw, pid, ids } = open();
    for (const id of ids) P.createProjectIndex(raw, id);
    P.dropGlobalTriggers(raw);
    measure(`a@${ids.length}`, dir, raw, pid);
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
  {
    const { dir, handle, raw, pid } = open();
    P.createE1(raw);
    P.dropGlobalTriggers(raw);
    measure('c', dir, raw, pid);
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
  out.push('');
}
console.log(out.join('\n'));
