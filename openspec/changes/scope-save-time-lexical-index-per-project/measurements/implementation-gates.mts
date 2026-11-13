// Phase 2 gates against the implementation as shipped, on corpora built by the base commit (an upgrade).
// Instruments, never tabulated together:
//   upgrade — single-run wall clock of the first createDb on a base-built database (migrations are a no-op, the
//             reconciler builds every project index), then of a second open; file sizes of data.db and its WAL;
//   recall  — prefix80 probes (80% of each of the 10 most recent memories, inserted in a rolled-back transaction):
//             is the source memory surfaced by findSaveTimeCandidates (lexical channel, no embedder), with the
//             shipped pruning and with pruning off (commonTermRatio: null)?
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/scope-save-time-lexical-index-per-project/measurements/implementation-gates.mts <corpus-cache-dir>
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories } = await load('@rembric/db');
const { findSaveTimeCandidates } = await load('@rembric/core');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = (process.env.SIZES ?? '1000,20000,50000').split(',').map(Number);
const PROBES = 10;
const mb = (path: string) => (existsSync(path) ? statSync(path).size / 1048576 : 0);

const out = [
  '# Phase 2 gates — upgrade cost and prefix80 recall, implementation as shipped',
  'upgrade instrument: single-run wall clock of createDb on a base-built copy (first open builds every project index), then a second open; data.db and WAL sizes after each',
  'recall instrument: prefix80 probes through findSaveTimeCandidates (no embedder, perSaveMax 100 so no cap hides a target); "surfaced" = the source memory is an fts candidate',
  'compare with options.txt (prototype b: generator 71/90, realistic 89/90; status quo d: the same)',
  '',
];

for (const corpus of ['generator-skew', 'realistic-skew'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const db = join(dir, 'data.db');
    const before = mb(db) + mb(`${db}-wal`);
    const lines: string[] = [];
    let t0 = performance.now();
    let handle = createDb({ dataDir: dir, ...quiet, onStartupLog: (l: string) => lines.push(l) });
    const first = performance.now() - t0;
    const afterFirst = { db: mb(db), wal: mb(`${db}-wal`) };
    handle.close();
    t0 = performance.now();
    handle = createDb({ dataDir: dir, ...quiet });
    const second = performance.now() - t0;
    out.push(`## ${corpus}, ${size} rows`);
    out.push(
      `upgrade: first open ${first.toFixed(0)} ms (${lines.filter((l) => l.includes('lexical')).join('; ') || 'no reconciler line'}), second open ${second.toFixed(0)} ms; data.db+WAL ${before.toFixed(1)} MB before, data.db ${afterFirst.db.toFixed(1)} MB + WAL ${afterFirst.wal.toFixed(1)} MB after the first open`,
    );
    const raw = handle.raw;
    const repos = createRepositories(handle.db);
    for (const [share, slot] of Object.entries(SHARE_SLOTS)) {
      const pid: string = repos.projects.findBySlug(slugForSlot(corpus, slot)).id;
      const probes = repos.memory.recentForContext({
        projectId: pid,
        includeArchived: false,
        limit: PROBES,
      });
      const insert = raw.prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at)
         VALUES (@id, 'project', @p, 'fact', @title, @content, '[]', 'active', '[]', @at)`,
      );
      let pruned = 0;
      let unpruned = 0;
      let same = 0;
      raw.exec('BEGIN');
      try {
        probes.forEach((r: { id: string; title: string; content: string }, i: number) => {
          const words = r.content.split(/\s+/);
          const content = words.slice(0, Math.max(1, Math.floor(words.length * 0.8))).join(' ');
          insert.run({ id: `probe-${i}`, p: pid, title: r.title, content, at: Date.now() });
          const saved = repos.memory.unsafeGetByIds([`probe-${i}`])[0];
          const ids = (ratio: number | null | undefined) => {
            const res = findSaveTimeCandidates(repos, saved, {
              perSaveMax: 100,
              ...(ratio === null ? { commonTermRatio: null } : {}),
            });
            return new Set(
              [...res.candidates, ...res.related]
                .filter((c: { source: string }) => c.source === 'fts')
                .map((c: { targetId: string }) => c.targetId),
            );
          };
          const a = ids(undefined);
          const b = ids(null);
          if (a.has(r.id)) pruned += 1;
          if (b.has(r.id)) unpruned += 1;
          if ([...a].sort().join() === [...b].sort().join()) same += 1;
        });
      } finally {
        raw.exec('ROLLBACK');
      }
      out.push(
        `  share ${share.padStart(3)} prefix80 source surfaced: pruned ${pruned}/${probes.length}, pruning off ${unpruned}/${probes.length}; fts candidate sets identical ${same}/${probes.length}`,
      );
    }
    out.push('');
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(out.join('\n'));
