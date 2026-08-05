import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file's own location so the script runs from any cwd.
const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/server/package.json'),
);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const DIM = 768;
const PARTITIONS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
function rnd() {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.random() - 0.5;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
function buf(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function build(rowsPerPartition) {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(
    memory_id TEXT PRIMARY KEY, partition_key TEXT partition key,
    status TEXT, type TEXT, embedding FLOAT[${DIM}]);`);
  const ins = db.prepare(
    'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?,?,?,?,?)',
  );
  const tx = db.transaction(() => {
    let i = 0;
    for (const p of PARTITIONS)
      for (let r = 0; r < rowsPerPartition; r++)
        ins.run(`m${i++}`, p, 'active', 'decision', buf(rnd()));
  });
  tx();
  return db;
}

/** The shipped `RANK_WINDOW_FLOOR` = `RANK_CONSTANT + 4` (hybrid-search.ts). */
const RANK_WINDOW = 64;

function bench(db, label, sqlText, params, reps = 40) {
  const stmt = db.prepare(sqlText);
  const qs = Array.from({ length: reps }, () => buf(rnd()));
  let n = 0;
  for (let i = 0; i < 5; i++) n += stmt.all(qs[i % reps], ...params).length; // warm
  const times = [];
  for (const q of qs) {
    const t0 = process.hrtime.bigint();
    const rows = stmt.all(q, ...params);
    const t1 = process.hrtime.bigint();
    n = rows.length;
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return {
    label,
    rows: n,
    p50: times[Math.floor(times.length / 2)].toFixed(2),
    p90: times[Math.floor(times.length * 0.9)].toFixed(2),
  };
}

for (const per of [500, 2500, 6250]) {
  const db = build(per);
  const total = per * PARTITIONS.length;
  console.log(
    `\n=== ${PARTITIONS.length} partitions x ${per} = ${total} vectors, k=${RANK_WINDOW} ===`,
  );
  const arms = [
    [
      '1 partition (today)',
      `SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key = ? AND status = 'active' ORDER BY distance`,
      ['P1'],
    ],
    [
      'IN (2 partitions)',
      `SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key IN ('P1','P2') AND status = 'active' ORDER BY distance`,
      [],
    ],
    [
      'IN (4 partitions)',
      `SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key IN ('P1','P2','P3','P4') AND status = 'active' ORDER BY distance`,
      [],
    ],
    [
      'IN (all 8)',
      `SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key IN ('P1','P2','P3','P4','P5','P6','P7','P8') AND status = 'active' ORDER BY distance`,
      [],
    ],
    [
      'no partition pred',
      `SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND status = 'active' ORDER BY distance`,
      [],
    ],
  ];
  for (const [l, s, p] of arms) console.log(JSON.stringify(bench(db, l, s, p)));
  // N-merged control: 2 separate single-partition queries
  const s1 = db.prepare(
    `SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key = ? AND status = 'active' ORDER BY distance`,
  );
  const qs = Array.from({ length: 40 }, () => buf(rnd()));
  for (let i = 0; i < 5; i++) s1.all(qs[0], 'P1');
  const times = [];
  let rows = 0;
  for (const q of qs) {
    const t0 = process.hrtime.bigint();
    const a = s1.all(q, 'P1');
    const b = s1.all(q, 'P2');
    const t1 = process.hrtime.bigint();
    rows = a.length + b.length;
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      label: '2 separate queries merged',
      rows,
      p50: times[20].toFixed(2),
      p90: times[36].toFixed(2),
    }),
  );
  console.log(
    'EQP IN(2):',
    JSON.stringify(
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key IN ('P1','P2') AND status = 'active' ORDER BY distance`,
        )
        .all(buf(rnd()))
        .map((r) => r.detail),
    ),
  );
  console.log(
    'EQP eq:',
    JSON.stringify(
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT memory_id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW} AND partition_key = ? AND status = 'active' ORDER BY distance`,
        )
        .all(buf(rnd()), 'P1')
        .map((r) => r.detail),
    ),
  );
  db.close();
}
