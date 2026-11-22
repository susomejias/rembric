// Save-time lexical statement per option, by project share, with fidelity to the status quo (d).
// Instruments, never tabulated together:
//   statement — wall clock (performance.now) of the candidate statement, p50 of 3 warm repetitions per probe, then p50 over 10 probes;
//   lookup    — the pruning read (document count + per-token frequencies), same repetition scheme;
//   build     — single-run wall clock of building each index from the populated table (migration body);
//   storage   — dbstat page bytes of each index's shadow tables.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/scope-save-time-lexical-index-per-project/measurements/options.mts <corpus-cache-dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const P = await import(new URL('./prototype.mts', import.meta.url).href);
const { createDb, createRepositories } = await load('@rembric/db');
const {
  COMMON_TERM_DOCUMENT_RATIO,
  LEXICAL_CANDIDATE_FLOOR,
  ftsQueryTokens,
  joinFtsTokens,
  lexicalOverlap,
  pruneCommonTokens,
  tokenSet,
} = await load('@rembric/core');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = (process.env.SIZES ?? '1000,20000,50000').split(',').map(Number);
const PROBES = 10;
const REPS = 3;
const POOL = 20;
const GLOBAL_FTS = `name IN ('memory_fts_data','memory_fts_idx','memory_fts_docsize','memory_fts_config')`;

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0
    ? NaN
    : s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
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
const once = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

const FILTER = `m.id != @x AND m.scope = 'project' AND m.project_id = @p AND m.status = 'active'`;
const SHAPES = ['d', 'b', 'bG', 'c'] as const;
type Shape = (typeof SHAPES)[number];

const out = [
  '# Save-time lexical statement per option — cost by project share, fidelity to the status quo (d)',
  'statement instrument: wall clock (performance.now), p50 of 3 warm repetitions per probe, then p50 over 10 probes',
  'lookup instrument: the pruning read alone (document count + per-token frequencies), same scheme; a separate instrument, never added to the statement',
  'corpora: the skewed generator and the skewed realistic control (corpora.mts), project shares 2% / 20% / 60%',
  'shapes (all with the shipped ORDER BY bm25(...) LIMIT 20 and the #469 pruning):',
  '  d   status quo after #469: memory_fts, pruned with global statistics (the production repository call)',
  '  b   per-project table (options a and b), pruned with the PROJECT table statistics',
  '  bG  per-project table, pruned with global statistics (isolates the table from the pruning source)',
  '  c   E1: one table with a project_id column, `{content tags title} : (expr) AND project_id : "<id>"`, pruned with global statistics',
  'probes:',
  '  verbatim  the 10 most recent active memories of the project, saved text = the memory (self excluded): cost and fidelity',
  '  prefix80  a new row holding the first 80% of each of those memories, inserted in a rolled-back transaction: is the source memory surfaced?',
  'fidelity: "top20" = probes whose top-20 ids equal d\'s; "cand" = post-floor lexical candidates summed over probes, then lost/gained against d',
  '',
];

for (const corpus of ['generator-skew', 'realistic-skew'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const handle = createDb({ dataDir: dir, ...quiet });
    const raw = handle.raw;
    const repos = createRepositories(handle.db);
    const projects = raw
      .prepare('SELECT DISTINCT project_id AS id FROM memory WHERE project_id IS NOT NULL')
      .all()
      .map((r: { id: string }) => r.id);

    const tGlobal = once(() => raw.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`));
    const tPer = once(() => {
      for (const id of projects) P.createProjectIndex(raw, id);
    });
    const tE1 = once(() => P.createE1(raw));
    const gBytes = raw.prepare(`SELECT sum(pgsize) AS b FROM dbstat WHERE ${GLOBAL_FTS}`).get().b;
    const pBytes = P.bytesOf(raw, 'memory_fts_p_%');
    const eBytes = P.bytesOf(raw, 'memory_fts_e1_%');
    const memBytes = raw
      .prepare(`SELECT sum(pgsize) AS b FROM dbstat WHERE name = 'memory'`)
      .get().b;
    const n = repos.termStatistics.adminDocumentCount();
    out.push(`## ${corpus}, ${size} rows, ${projects.length} projects`);
    out.push(
      `build (single run): memory_fts rebuild ${tGlobal.toFixed(0)} ms | every per-project index created+rebuilt ${tPer.toFixed(0)} ms | E1 created+rebuilt ${tE1.toFixed(0)} ms`,
    );
    out.push(
      `storage (dbstat): memory table ${mb(memBytes)} | memory_fts ${mb(gBytes)} | all per-project indexes ${mb(pBytes)} | E1 ${mb(eBytes)}`,
    );

    for (const [share, slot] of Object.entries(SHARE_SLOTS)) {
      const project = repos.projects.findBySlug(slugForSlot(corpus, slot));
      const pid: string = project.id;
      const table = P.projectTable(pid);
      const vocab = P.createProjectVocab(raw, pid);
      const projectRows = raw
        .prepare('SELECT count(*) AS n FROM memory WHERE project_id = ?')
        .get(pid).n;
      const stmts = {
        b: raw.prepare(
          `SELECT m.id AS id, m.title AS title, m.content AS content FROM ${table} t JOIN memory m ON m.rowid = t.rowid
           WHERE ${table} MATCH @m AND ${FILTER} ORDER BY bm25(${table}) LIMIT ${POOL}`,
        ),
        c: raw.prepare(
          `SELECT m.id AS id, m.title AS title, m.content AS content FROM memory_fts_e1 t JOIN memory m ON m.rowid = t.rowid
           WHERE memory_fts_e1 MATCH @e AND ${FILTER} ORDER BY bm25(memory_fts_e1, 1, 1, 1, 0) LIMIT ${POOL}`,
        ),
        count: raw.prepare('SELECT count(*) AS n FROM memory WHERE project_id = ?'),
      };
      const exprs = (content: string) => {
        const tokens = ftsQueryTokens(content, { maxTerms: 16 });
        const global = joinFtsTokens(
          pruneCommonTokens(
            tokens,
            repos.termStatistics.adminTokenTermFrequencies(tokens),
            n,
            COMMON_TERM_DOCUMENT_RATIO,
          ),
        );
        const local = joinFtsTokens(
          pruneCommonTokens(
            tokens,
            P.tokenTermFrequencies(raw, vocab, tokens),
            stmts.count.get(pid).n,
            COMMON_TERM_DOCUMENT_RATIO,
          ),
        );
        return { tokens, global, local, unpruned: joinFtsTokens(tokens) };
      };
      const runner = (shape: Shape, id: string, e: ReturnType<typeof exprs>, unpruned: boolean) => {
        const g = unpruned ? e.unpruned : e.global;
        const l = unpruned ? e.unpruned : e.local;
        if (shape === 'd')
          return () =>
            repos.memory.searchBm25Candidates({
              matchExpr: g,
              excludeId: id,
              projectId: pid,
              excludeIds: [],
              limit: POOL,
            });
        if (shape === 'b') return () => stmts.b.all({ m: l, x: id, p: pid });
        if (shape === 'bG') return () => stmts.b.all({ m: g, x: id, p: pid });
        return () =>
          stmts.c.all({
            e: `{content tags title} : (${g}) AND project_id : "${pid}"`,
            x: id,
            p: pid,
          });
      };
      const admitted = (
        content: string,
        rows: { id: string; title: string; content: string }[],
      ) => {
        const q = tokenSet(content);
        return new Set(
          rows.filter((r) => lexicalOverlap(q, r) >= LEXICAL_CANDIDATE_FLOOR).map((r) => r.id),
        );
      };

      const probes = repos.memory.recentForContext({
        projectId: pid,
        includeArchived: false,
        limit: PROBES,
      });
      const lookupG: number[] = [];
      const lookupL: number[] = [];
      for (const variant of ['pruned', 'unpruned'] as const) {
        const times = new Map<Shape, number[]>(SHAPES.map((s) => [s, []]));
        const top = new Map<Shape, number>(SHAPES.map((s) => [s, 0]));
        const cand = new Map<Shape, { n: number; lost: number; gained: number }>(
          SHAPES.map((s) => [s, { n: 0, lost: 0, gained: 0 }]),
        );
        for (const r of probes) {
          const e = exprs(r.content);
          if (variant === 'pruned') {
            lookupG.push(
              p50(() => {
                repos.termStatistics.adminDocumentCount();
                repos.termStatistics.adminTokenTermFrequencies(e.tokens);
              }),
            );
            lookupL.push(
              p50(() => {
                stmts.count.get(pid);
                P.tokenTermFrequencies(raw, vocab, e.tokens);
              }),
            );
          }
          const ref = runner('d', r.id, e, variant === 'unpruned')() as { id: string }[];
          const refSet = admitted(r.content, ref as never);
          for (const s of SHAPES) {
            const run = runner(s, r.id, e, variant === 'unpruned');
            times.get(s)!.push(p50(run));
            const got = run() as { id: string; title: string; content: string }[];
            if (got.map((x) => x.id).join() === ref.map((x) => x.id).join())
              top.set(s, top.get(s)! + 1);
            const set = admitted(r.content, got);
            const c = cand.get(s)!;
            c.n += set.size;
            for (const id of refSet) if (!set.has(id)) c.lost += 1;
            for (const id of set) if (!refSet.has(id)) c.gained += 1;
          }
        }
        const cells = SHAPES.map((s) => {
          const c = cand.get(s)!;
          const t = `${s} ${quantile(times.get(s)!, 0.5).toFixed(2)} ms`;
          return s === 'd'
            ? `${t} [cand ${c.n}]`
            : `${t} [top20 ${top.get(s)}/${probes.length}, cand ${c.n} -${c.lost}+${c.gained}]`;
        });
        out.push(
          `  share ${share.padStart(3)} (${String(projectRows).padStart(5)} rows) ${variant.padEnd(8)} ${cells.join('  ')}`,
        );
      }
      out.push(
        `  share ${share.padStart(3)} lookup p50: global ${quantile(lookupG, 0.5).toFixed(3)} ms | project ${quantile(lookupL, 0.5).toFixed(3)} ms`,
      );

      raw.exec('BEGIN');
      try {
        const insert = raw.prepare(
          `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at)
           VALUES (@id, 'project', @p, 'fact', @title, @content, '[]', 'active', '[]', @at)`,
        );
        const surfaced = new Map<Shape, number>(SHAPES.map((s) => [s, 0]));
        const cand = new Map<Shape, { n: number; lost: number; gained: number }>(
          SHAPES.map((s) => [s, { n: 0, lost: 0, gained: 0 }]),
        );
        probes.forEach((r: { id: string; title: string; content: string }, i: number) => {
          const words = r.content.split(/\s+/);
          const content = words.slice(0, Math.max(1, Math.floor(words.length * 0.8))).join(' ');
          const id = `probe-${i}`;
          insert.run({ id, p: pid, title: r.title, content, at: Date.now() });
          const e = exprs(content);
          const refSet = admitted(content, runner('d', id, e, false)() as never);
          for (const s of SHAPES) {
            const set = admitted(content, runner(s, id, e, false)() as never);
            if (set.has(r.id)) surfaced.set(s, surfaced.get(s)! + 1);
            const c = cand.get(s)!;
            c.n += set.size;
            for (const x of refSet) if (!set.has(x)) c.lost += 1;
            for (const x of set) if (!refSet.has(x)) c.gained += 1;
          }
        });
        out.push(
          `  share ${share.padStart(3)} prefix80 source surfaced: ${SHAPES.map((s) => {
            const c = cand.get(s)!;
            return (
              `${s} ${surfaced.get(s)}/${probes.length}` +
              (s === 'd' ? ` [cand ${c.n}]` : ` [cand ${c.n} -${c.lost}+${c.gained}]`)
            );
          }).join('  ')}`,
        );
      } finally {
        raw.exec('ROLLBACK');
      }
    }
    out.push('');
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(out.join('\n'));
