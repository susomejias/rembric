// How many verdicts were ever recorded on a pair AFTER one of its endpoints retired (design D10, issue #466).
// Those are the verdicts orphaning at retirement makes impossible through memory.judge: the row is already orphaned.
// Read-only on the measured database: it is opened readonly and only SELECTs run. Aggregates only, no ids or text.
// A memory's retirement time is derived, because no column stores it: the earliest of
//   - the judged `supersedes` relation that targets it (a topic_key revision or a supersedes verdict), and
//   - the non-reverted `merge`, `agent_memory_archive`, `decay` or historical `supersede` op that names it.
// Control: a scratch COPY gets one known late `not_conflict` verdict, and the late count must rise by exactly one.
// Run: RETIRE_SCRATCH=$(mktemp -d) TMPDIR=$RETIRE_SCRATCH DB_DIR=<dir holding data.db> pnpm --filter @rembric/core exec tsx ../../openspec/changes/orphan-pendings-on-retirement/measurements/retired-verdicts.mts
// DB_DIR defaults to the 50 000-memory corpus that retirement-cost.mts caches in RETIRE_SCRATCH.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.RETIRE_SCRATCH;
if (!SCRATCH) throw new Error('set RETIRE_SCRATCH to a mktemp -d directory outside the workspace');
const DB_DIR = process.env.DB_DIR ?? join(SCRATCH, 'vol-50000');
if (!existsSync(join(DB_DIR, 'data.db'))) throw new Error(`no data.db in ${DB_DIR}`);

const ROOT = new URL('../../../../', import.meta.url);
const db = await import(new URL('packages/db/src/index.ts', ROOT).href);

const RETIREMENT = `
  WITH retire_events AS (
    SELECT target_id AS id, judged_at AS at FROM memory_relations
     WHERE status = 'judged' AND relation = 'supersedes' AND judged_at IS NOT NULL
    UNION ALL
    SELECT j.value AS id, o.applied_at AS at FROM consolidation_ops o, json_each(o.affected_ids) j
     WHERE o.op_type IN ('merge', 'agent_memory_archive', 'decay', 'supersede') AND o.reverted_at IS NULL
  ),
  retired AS (
    SELECT m.id, (SELECT MIN(e.at) FROM retire_events e WHERE e.id = m.id) AS at
      FROM memory m WHERE m.status <> 'active'
  )`;

interface Counts {
  judged: number;
  touchingRetired: number;
  late: number;
  lateByRelation: Record<string, number>;
  retiredWithoutTime: number;
}

function measure(handle: any): Counts {
  const raw = handle.raw;
  // VERIFICATION READ: every judged verdict except the topic_key audit rows, which are the retirement itself.
  const judged = (
    raw
      .prepare(
        `SELECT count(*) AS n FROM memory_relations WHERE status = 'judged' AND coalesce(marked_by_kind, '') <> 'agent_topic_key'`,
      )
      .get() as { n: number }
  ).n;
  const touchingRetired = (
    raw
      .prepare(
        `${RETIREMENT}
         SELECT count(*) AS n FROM memory_relations r
          WHERE r.status = 'judged' AND coalesce(r.marked_by_kind, '') <> 'agent_topic_key'
            AND (r.source_id IN (SELECT id FROM retired) OR r.target_id IN (SELECT id FROM retired))`,
      )
      .get() as { n: number }
  ).n;
  const lateRows = raw
    .prepare(
      `${RETIREMENT}
       SELECT r.relation AS relation, count(*) AS n FROM memory_relations r
        WHERE r.status = 'judged' AND coalesce(r.marked_by_kind, '') <> 'agent_topic_key' AND r.judged_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM retired x WHERE x.at IS NOT NULL AND x.at < r.judged_at
                        AND x.id IN (r.source_id, r.target_id))
        GROUP BY r.relation ORDER BY r.relation`,
    )
    .all() as { relation: string; n: number }[];
  const retiredWithoutTime = (
    raw.prepare(`${RETIREMENT} SELECT count(*) AS n FROM retired WHERE at IS NULL`).get() as {
      n: number;
    }
  ).n;
  const lateByRelation = Object.fromEntries(lateRows.map((r) => [r.relation, r.n]));
  return {
    judged,
    touchingRetired,
    late: lateRows.reduce((s, r) => s + r.n, 0),
    lateByRelation,
    retiredWithoutTime,
  };
}

function open(dir: string, readonly: boolean): any {
  return db.createDb({
    dataDir: dir,
    readonly,
    onMigrationProgress: () => {},
    onStartupLog: () => {},
  });
}

const measured = open(DB_DIR, true);
let counts: Counts;
try {
  counts = measure(measured);
} finally {
  measured.close();
}

const controlDir = join(SCRATCH, 'retired-verdicts-control');
rmSync(controlDir, { recursive: true, force: true });
mkdirSync(controlDir, { recursive: true });
copyFileSync(join(DB_DIR, 'data.db'), join(controlDir, 'data.db'));
const control = open(controlDir, false);
let controlCounts: Counts;
try {
  const raw = control.raw;
  // SCRATCH WRITE on a private copy: one not_conflict verdict recorded one second after a known retirement.
  const target = raw
    .prepare(
      `${RETIREMENT}
       SELECT x.id AS retiredId, x.at AS at, m.project_id AS projectId FROM retired x JOIN memory m ON m.id = x.id
        WHERE x.at IS NOT NULL ORDER BY x.id LIMIT 1`,
    )
    .get() as { retiredId: string; at: number; projectId: string } | undefined;
  if (!target)
    throw new Error('control needs at least one retired memory with a derivable retirement time');
  const partner = raw
    .prepare(
      `SELECT id FROM memory WHERE project_id = ? AND status = 'active' AND id <> ? AND NOT EXISTS (
         SELECT 1 FROM memory_relations r WHERE (r.source_id = memory.id AND r.target_id = ?) OR (r.target_id = memory.id AND r.source_id = ?)
       ) ORDER BY id LIMIT 1`,
    )
    .get(target.projectId, target.retiredId, target.retiredId, target.retiredId) as { id: string };
  const id = `control-late-verdict-${Date.now()}`;
  raw
    .prepare(
      `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, relation, status, marked_by_kind, judged_at, created_at)
       VALUES (?, ?, ?, ?, 'not_conflict', 'judged', 'agent', ?, ?)`,
    )
    .run(id, id, partner.id, target.retiredId, target.at + 1000, target.at - 1000);
  controlCounts = measure(control);
} finally {
  control.close();
  rmSync(controlDir, { recursive: true, force: true });
}

const fmt = (c: Counts) =>
  [
    `  judged verdicts (topic_key audit rows excluded): ${c.judged}`,
    `  of which touch a currently retired endpoint:      ${c.touchingRetired}`,
    `  of which were recorded after that retirement:     ${c.late}  ${JSON.stringify(c.lateByRelation)}`,
    `  retired memories with no derivable time:          ${c.retiredWithoutTime}`,
  ].join('\n');

console.log(`# retired-endpoint verdicts — read-only count (design D10)`);
console.log(
  `# database: ${process.env.DB_DIR ? 'DB_DIR (operator-supplied copy)' : 'synthetic corpus vol-50000'}`,
);
if (!process.env.DB_DIR) {
  console.log(
    '# CAVEAT: the corpus generator judges random pairs after all memories exist, whatever their status, so this count exercises the instrument and says nothing about real installations',
  );
}
console.log(fmt(counts));
console.log(`# control: one late not_conflict verdict added to a scratch copy`);
console.log(fmt(controlCounts));
const rose = controlCounts.late - counts.late;
console.log(`# control late delta: ${rose} (${rose === 1 ? 'PASS' : 'FAIL'})`);
if (rose !== 1) process.exitCode = 1;
