// Instrument: wall clock (performance.now) of one save-time lexical statement shape, p50 of 3 warm
// repetitions per probe, then p50 over 10 probes. Fidelity: top-20 (id, score) list compared with shape A.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/plans.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories } = await load('@rembric/db');
const {
  COMMON_TERM_DOCUMENT_RATIO,
  ftsQueryTokens,
  joinFtsTokens,
  pruneCommonTokens,
  sanitizeFtsQuery,
} = await load('@rembric/core');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = [1_000, 20_000, 50_000];
const PROBES = 10;
const REPS = 3;

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
const p50 = (fn: () => unknown): number => {
  const ts: number[] = [];
  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return quantile(ts, 0.5);
};

const FILTER = `m.id != @x AND m.scope = 'project' AND m.project_id IN (@p) AND m.status = 'active'
  AND m.id NOT IN (SELECT value FROM json_each('[]'))`;
const SQL = {
  A: `SELECT m.id AS id, memory_fts.rank AS rank FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH @m AND ${FILTER} ORDER BY rank LIMIT 20`,
  B2: `SELECT m.id AS id, bm25(memory_fts) AS rank FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
       WHERE memory_fts MATCH @m AND +memory_fts.rowid IN (
         SELECT rowid FROM memory WHERE scope = 'project' AND project_id IN (@p) AND status = 'active')
       AND ${FILTER} ORDER BY bm25(memory_fts) LIMIT 20`,
  E1: `SELECT m.id AS id, e1.rank AS rank FROM temp.e1 JOIN memory m ON m.rowid = e1.rowid
       WHERE e1 MATCH @e AND ${FILTER} ORDER BY rank LIMIT 20`,
  E2: `SELECT m.id AS id, e2.rank AS rank FROM temp.e2 JOIN memory m ON m.rowid = e2.rowid
       WHERE e2 MATCH @m AND ${FILTER} ORDER BY rank LIMIT 20`,
  floor: `SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH @m`,
};
const SHAPES = ['A', 'B', 'B2', 'E1', 'E2', 'floor'] as const;

const out = [
  '# Save-time lexical statement shapes — cost by project share, and fidelity to shape A',
  'instrument: statement wall clock (performance.now), p50 of 3 warm repetitions per probe, then p50 over 10 probes; one instrument for every cell',
  'probes: the 10 most recent active memories of the target project, used verbatim as the saved text (each is indexed and excluded from its own results)',
  'corpora: the skewed generator (corpus:build --skew) and the skewed realistic control; project shares 2% / 20% / 60% of all rows (corpora.mts SHARE_SLOTS)',
  'expressions: unpruned = sanitizeFtsQuery(content, 16 terms); pruned = the shipped pruneCommonTokens expression',
  'shapes:',
  '  A     today: ORDER BY rank, which FTS5 consumes (plan INDEX 32:M3), so it scores and sorts every match of every project',
  '  B     this change: ORDER BY bm25(memory_fts), so the join filters first and bm25 runs on in-project matches only (the production repository call)',
  '  B2    B plus +rowid IN (the project rowids from the covering scope index), so out-of-project matches skip the memory row lookup',
  '  E1    simulated derived-index change: a project_id column in the FTS table, AND-ed into the MATCH, rank = bm25(1,1,1,0)',
  '  E2    simulated derived-index change: an FTS table holding only the target project rows (idf over the project only)',
  '  floor FTS5 iterating the match set alone (count(*), no join, no bm25), for reference',
  'fidelity: "ids+scores" = identical (id, score) top-20 to A; "ids" = identical id order only',
  '',
];

for (const corpus of ['generator-skew', 'realistic-skew'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const handle = createDb({ dataDir: dir, ...quiet });
    const raw = handle.raw;
    const repos = createRepositories(handle.db);
    const n = repos.termStatistics.adminDocumentCount();
    raw.exec(
      `CREATE VIRTUAL TABLE temp.e1 USING fts5(content, tags, title, project_id, content='')`,
    );
    raw.exec(
      `INSERT INTO temp.e1(rowid, content, tags, title, project_id) SELECT rowid, content, tags, title, project_id FROM memory`,
    );
    raw.exec(`INSERT INTO temp.e1(e1, rank) VALUES('rank', 'bm25(1.0, 1.0, 1.0, 0.0)')`);
    out.push(`## ${corpus}, ${size} rows`);
    for (const [share, slot] of Object.entries(SHARE_SLOTS)) {
      const project = repos.projects.findBySlug(slugForSlot(corpus, slot));
      raw.exec('DROP TABLE IF EXISTS temp.e2');
      raw.exec(`CREATE VIRTUAL TABLE temp.e2 USING fts5(content, tags, title, content='')`);
      raw
        .prepare(
          `INSERT INTO temp.e2(rowid, content, tags, title) SELECT rowid, content, tags, title FROM memory WHERE project_id = ?`,
        )
        .run(project.id);
      const stmts = Object.fromEntries(Object.entries(SQL).map(([k, s]) => [k, raw.prepare(s)]));
      const rows = repos.memory.recentForContext({
        projectId: project.id,
        includeArchived: false,
        limit: PROBES,
      });
      const projectRows = raw
        .prepare('SELECT count(*) AS n FROM memory WHERE project_id = ?')
        .get(project.id).n;
      for (const variant of ['unpruned', 'pruned'] as const) {
        const times = new Map<string, number[]>(SHAPES.map((s) => [s, []]));
        const exact = new Map<string, number>(SHAPES.map((s) => [s, 0]));
        const idsOnly = new Map<string, number>(SHAPES.map((s) => [s, 0]));
        for (const r of rows) {
          const tokens = ftsQueryTokens(r.content, { maxTerms: 16 });
          const expr =
            variant === 'unpruned'
              ? sanitizeFtsQuery(r.content, { maxTerms: 16 })
              : joinFtsTokens(
                  pruneCommonTokens(
                    tokens,
                    repos.termStatistics.adminTokenTermFrequencies(tokens),
                    n,
                    COMMON_TERM_DOCUMENT_RATIO,
                  ),
                );
          const args = {
            m: expr,
            e: `{content tags title} : (${expr}) AND project_id : "${project.id}"`,
            x: r.id,
            p: project.id,
          };
          const run = (shape: string) => () =>
            shape === 'B'
              ? repos.memory.searchBm25Candidates({
                  matchExpr: expr,
                  excludeId: r.id,
                  projectId: project.id,
                  excludeIds: [],
                  limit: 20,
                })
              : shape === 'floor'
                ? stmts.floor.get({ m: expr })
                : stmts[shape].all(args);
          const reference = stmts.A.all(args) as { id: string; rank: number }[];
          for (const shape of SHAPES) {
            times.get(shape)!.push(p50(run(shape)));
            if (shape === 'floor') continue;
            const got = run(shape)() as { id: string; rank: number }[];
            const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();
            const pairs = (xs: { id: string; rank: number }[]) =>
              JSON.stringify(xs.map((x) => [x.id, x.rank]));
            if (ids(got) === ids(reference)) idsOnly.set(shape, idsOnly.get(shape)! + 1);
            if (pairs(got) === pairs(reference)) exact.set(shape, exact.get(shape)! + 1);
          }
        }
        const cells = SHAPES.map((s) => {
          const t = `${s} ${quantile(times.get(s)!, 0.5).toFixed(2)} ms`;
          return s === 'floor' ? t : `${t} (${exact.get(s)}/${idsOnly.get(s)})`;
        });
        out.push(
          `  share ${share.padStart(3)} (${String(projectRows).padStart(5)} rows) ${variant.padEnd(8)}  ${cells.join('  ')}`,
        );
      }
    }
    out.push('  (x/y) = probes whose top-20 matched A as ids+scores / as ids', '');
    handle.close();
  }
}
console.log(out.join('\n'));
