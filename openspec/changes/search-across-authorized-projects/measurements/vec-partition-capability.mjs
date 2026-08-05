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
db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  partition_key TEXT partition key,
  status TEXT,
  type TEXT,
  embedding FLOAT[8]);`);
const vec = (a, b) => {
  const v = new Float32Array(8);
  v[0] = a;
  v[1] = b;
  return Buffer.from(v.buffer);
};
const ins = db.prepare(
  'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?,?,?,?,?)',
);
ins.run('a', 'P1', 'active', 'user', vec(1, 0));
ins.run('b', 'P1', 'active', 'user', vec(0.9, 0.1));
ins.run('c', 'P2', 'active', 'user', vec(0.99, 0.01));
ins.run('d', 'P3', 'active', 'user', vec(0.5, 0.5));
ins.run('e', 'P2', 'superseded', 'user', vec(1, 0));

const q = vec(1, 0);
const arms = {
  'control: partition_key = P1': `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = 10 AND partition_key = 'P1' AND status = 'active' ORDER BY distance`,
  'A: no partition_key predicate at all': `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = 10 AND status = 'active' ORDER BY distance`,
  'B: partition_key IN (P1,P2)': `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = 10 AND partition_key IN ('P1','P2') AND status = 'active' ORDER BY distance`,
  'C: partition_key OR': `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = 10 AND (partition_key = 'P1' OR partition_key = 'P2') AND status = 'active' ORDER BY distance`,
  'D: LIMIT instead of k, no partition': `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND status = 'active' ORDER BY distance LIMIT 10`,
  'E: subquery partition_key IN (SELECT)': `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = 10 AND partition_key IN (SELECT 'P1' UNION SELECT 'P2') AND status = 'active' ORDER BY distance`,
};
for (const [name, sqlText] of Object.entries(arms)) {
  try {
    const rows = db.prepare(sqlText).all(q);
    console.log(`${name} => OK: ${JSON.stringify(rows.map((r) => r.memory_id))}`);
  } catch (e) {
    console.log(`${name} => THROWS: ${e.code ?? ''} ${e.message}`);
  }
}
console.log('sqlite-vec version:', db.prepare('select vec_version() as v').get().v);
