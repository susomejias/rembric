import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file's own location so the script runs from any cwd.
const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/server/package.json'),
);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database(':memory:');
sqliteVec.load(db);
db.exec(
  `CREATE VIRTUAL TABLE memory_vec USING vec0(memory_id TEXT PRIMARY KEY, partition_key TEXT partition key, status TEXT, type TEXT, embedding FLOAT[8]);`,
);
const vec = (a, b) => {
  const v = new Float32Array(8);
  v[0] = a;
  v[1] = b;
  return Buffer.from(v.buffer);
};
const ins = db.prepare('INSERT INTO memory_vec VALUES (?,?,?,?,?)');
ins.run('p1-near', 'P1', 'active', 'd', vec(1, 0));
ins.run('p1-far', 'P1', 'active', 'd', vec(0, 1));
ins.run('p2-mid', 'P2', 'active', 'd', vec(0.7, 0.7));
ins.run('p3-x', 'P3', 'active', 'd', vec(-1, 0));
const q = vec(1, 0);
const show = (l, s, ...p) => {
  try {
    const r = db.prepare(s).all(...p);
    console.log(l, '=>', JSON.stringify(r.map((x) => [x.memory_id, +x.distance.toFixed(3)])));
  } catch (e) {
    console.log(l, '=> THROWS', e.message);
  }
};
show(
  'bound params IN (?,?)',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key IN (?,?) AND status='active' ORDER BY distance`,
  q,
  'P1',
  'P2',
);
show(
  'k=2, IN(2) row count',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key IN ('P1','P2') AND status='active' ORDER BY distance`,
  q,
);
show(
  'k=2, single partition',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key='P1' AND status='active' ORDER BY distance`,
  q,
);
show(
  'IN with a partition that has no rows',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key IN ('P1','NOPE') AND status='active' ORDER BY distance`,
  q,
);
show(
  'IN with a single element',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key IN ('P1') AND status='active' ORDER BY distance`,
  q,
);
show(
  'empty IN list',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key IN () AND status='active' ORDER BY distance`,
  q,
);
show(
  'json_each subquery',
  `SELECT memory_id,distance FROM memory_vec WHERE embedding MATCH ? AND k = 2 AND partition_key IN (SELECT value FROM json_each(?)) AND status='active' ORDER BY distance`,
  q,
  JSON.stringify(['P1', 'P2']),
);
