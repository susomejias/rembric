// Dry-run count: how many pending judgments the stale pending drain would orphan, and why it keeps the rest.
// Read-only over a database COPY: it runs the drain's own selection and evaluatePair, and writes nothing.
// Run: pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/dry-run-count.mts <copy dir or data.db> [--show-slugs]
// Copy embedding-state.json with data.db: without it the vector index counts as not current, as on a server.
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = new URL('../../../../', import.meta.url);
const db = await import(new URL('packages/db/src/index.ts', ROOT).href);
const core = await import(new URL('packages/core/src/index.ts', ROOT).href);

const arg = process.argv[2];
if (!arg) throw new Error('usage: dry-run-count.mts <copy dir or data.db> [--show-slugs]');
const showSlugs = process.argv.includes('--show-slugs');
const abs = resolve(arg);
const dataDir = basename(abs) === 'data.db' ? dirname(abs) : abs;
const serverDir = resolve(process.env.REMBRIC_DATA_DIR ?? join(homedir(), '.rembric'));
if (
  dataDir === serverDir ||
  ['data', 'data-dev'].includes(basename(dataDir)) ||
  dataDir === '/data'
) {
  throw new Error(`refusing ${dataDir}: it is a server data directory. Run this on a COPY.`);
}
if (!existsSync(join(dataDir, 'data.db')) || !statSync(join(dataDir, 'data.db')).isFile()) {
  throw new Error(`no data.db in ${dataDir}`);
}

const handle = db.createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
const repos = db.createRepositories(handle.db);

// VERIFICATION READ (raw, read-only): table digests, taken after migration.
function digest(table: string): string {
  const h = createHash('sha256');
  for (const row of handle.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).raw().iterate()) {
    h.update(JSON.stringify(row, (_k, v) => (Buffer.isBuffer(v) ? v.toString('hex') : v)));
  }
  return h.digest('hex').slice(0, 16);
}
const before = { memory: digest('memory'), relations: digest('memory_relations') };

const vectorIndexCurrent: boolean = core.vectorIdentityMatches(dataDir);
const reverted: string[] = repos.consolidation.listRevertedOrphanPromoteCreatedIds();
const pendingIn = handle.raw.prepare(
  `SELECT count(*) AS n FROM memory_relations r JOIN memory ms ON ms.id = r.source_id
   WHERE r.status = 'pending' AND ms.project_id = ?`,
);

const out: string[] = [
  '# stale pending drain — dry-run count (read-only)',
  `vector index current (embedding-state.json matches this build): ${vectorIndexCurrent}${vectorIndexCurrent ? '' : ' — every rules drain is kept as unknown; copy the marker file with data.db'}`,
  `reverted orphan_promote ops excluded from the selection: ${reverted.length}`,
  '',
];
const totals = new Map<string, number>();
const add = (k: string, n = 1) => totals.set(k, (totals.get(k) ?? 0) + n);
const projectIds: string[] = repos.projects.listAllIds();
projectIds.forEach((projectId, i) => {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  let after: { createdAt: Date; judgmentId: string } | undefined;
  for (;;) {
    const page = repos.relations.listExaminablePendingInScope({
      projectId,
      ...(after ? { after } : {}),
      excludeJudgmentIds: reverted,
      limit: 1_000,
    });
    for (const pair of page) {
      const e = core.evaluatePair(repos, projectId, pair.sourceId, pair.targetId, {
        vectorIndexCurrent,
      });
      const d: string = core.drainDisposition(e);
      bump('examined');
      if (d === 'drain_rules') bump('would drain by the rules');
      else if (d === 'drain_retired') bump('would drain: endpoint retired');
      else if (d === 'keep_admitted') {
        bump(`kept admitted: ${['lexical', 'vector', 'entity'].find((c) => e[c] === 'admitted')}`);
      } else if (e.kind !== 'channels') bump(`kept unknown: ${e.kind}`);
      else if (e.vector === 'unknown') {
        bump(`kept unknown: vector ${vectorIndexCurrent ? 'missing' : 'index not current'}`);
      } else bump('kept unknown: entity extraction failed');
    }
    if (page.length < 1_000) break;
    const last = page.at(-1)!;
    after = { createdAt: last.createdAt, judgmentId: last.judgmentId };
  }
  const pending = pendingIn.get(projectId).n as number;
  if (pending === 0 && counts.size === 0) return;
  const label = showSlugs ? repos.projects.adminFindById(projectId)?.slug : `project #${i + 1}`;
  out.push(`## ${label}`, `  total pending: ${pending}`);
  add('total pending', pending);
  for (const [k, n] of [...counts].sort()) {
    out.push(`  ${k}: ${n}`);
    add(k, n);
  }
});
out.push('', '## all projects', ...[...totals].sort().map(([k, n]) => `  ${k}: ${n}`));
const after = { memory: digest('memory'), relations: digest('memory_relations') };
out.push(
  '',
  `table digests after migration, before -> after the evaluation: memory ${before.memory} -> ${after.memory}, memory_relations ${before.relations} -> ${after.relations}: ${before.memory === after.memory && before.relations === after.relations ? 'UNCHANGED' : 'CHANGED'}`,
);
handle.close();
console.log(out.join('\n'));
