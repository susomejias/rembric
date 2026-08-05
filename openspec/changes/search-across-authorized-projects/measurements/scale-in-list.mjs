/**
 * Instrument I1 ISOLATED STATEMENT — how the `partition_key IN (…)` list
 * behaves as it grows, and whether the `json_each` escape
 * (`scope-clause.ts::idJsonSet`) is a like-for-like replacement at every length.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/search-across-authorized-projects/measurements/scale-in-list.mjs \
 *     --label <name> --json <outFile>
 *
 * Synthetic and in-memory, like `vec-partition-capability.mjs`: the question is
 * about SQLite's handling of the list, not about a corpus. Rows per partition
 * are held constant, so at a given length all three forms name the same
 * partitions and return the same rows — any difference between them is the list
 * and nothing else.
 *
 * The bind-ceiling probe is separate and deliberately runs against a small
 * table: `partition_key IN ('P1','NOPE')` is measured to contribute nothing for
 * an unmatched partition (`vec-partition-capability.md` §3), so a list of
 * 40 000 mostly-absent names exercises the binder without a 40 000-partition
 * corpus.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/server/package.json'),
);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const DIM = 768;
/** The shipped `computeRankWindowSize(DEFAULT_SEARCH_LIMIT, 0)`. */
const RANK_WINDOW = 64;
const ROWS_PER_PARTITION = 2;
const PARTITION_COUNTS = [8, 32, 128, 512, 2048, 8192];
/**
 * vec0 pre-allocates one chunk per partition, and the shipped table takes the
 * default 1024 rows per chunk — 3 MB of `FLOAT[768]` per partition, so 8192
 * partitions would want ~25 GB (measured: the fixture was OOM-killed at the
 * default). All three forms share this setting, so the comparison BETWEEN them
 * is untouched; the absolute times are not comparable to any figure measured on
 * a default-chunk table.
 */
const CHUNK_SIZE = 8;
const WARMUP = 5;
const TIMED = 40;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function rnd() {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i += 1) {
    v[i] = Math.random() - 0.5;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  for (let i = 0; i < DIM; i += 1) v[i] /= n;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function build(partitionCount) {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(
    memory_id TEXT PRIMARY KEY, partition_key TEXT partition key,
    status TEXT, type TEXT, embedding FLOAT[${DIM}], chunk_size=${CHUNK_SIZE});`);
  const ins = db.prepare(
    'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?,?,?,?,?)',
  );
  const keys = Array.from({ length: partitionCount }, (_, i) => `P${String(i).padStart(6, '0')}`);
  const tx = db.transaction(() => {
    let i = 0;
    for (const p of keys) {
      for (let r = 0; r < ROWS_PER_PARTITION; r += 1) {
        ins.run(`m${i++}`, p, 'active', 'decision', rnd());
      }
    }
  });
  tx();
  return { db, keys };
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const round = (n) => Math.round(n * 1000) / 1000;

const label = arg('label', 'unlabelled');
const out = arg('json', '');
const lengths = [];

for (const partitionCount of PARTITION_COUNTS) {
  const { db, keys } = build(partitionCount);
  const literalList = keys.map((key) => `'${key}'`).join(',');
  const placeholders = keys.map(() => '?').join(',');
  const jsonList = JSON.stringify(keys);

  const arms = [
    {
      name: 'literal',
      stmt: db.prepare(
        `SELECT memory_id AS id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW}
         AND partition_key IN (${literalList}) AND status = 'active' ORDER BY distance`,
      ),
      params: [],
    },
    {
      name: 'bound',
      stmt: db.prepare(
        `SELECT memory_id AS id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW}
         AND partition_key IN (${placeholders}) AND status = 'active' ORDER BY distance`,
      ),
      params: keys,
    },
    {
      name: 'json_each',
      stmt: db.prepare(
        `SELECT memory_id AS id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW}
         AND partition_key IN (SELECT value FROM json_each(?)) AND status = 'active' ORDER BY distance`,
      ),
      params: [jsonList],
    },
  ];

  const queries = Array.from({ length: WARMUP + TIMED }, rnd);
  for (const arm of arms) {
    arm.samples = [];
    arm.rowsMin = Infinity;
    arm.rowsMax = 0;
    for (let i = 0; i < WARMUP; i += 1) arm.stmt.all(queries[i], ...arm.params);
  }
  for (let i = 0; i < TIMED; i += 1) {
    const q = queries[WARMUP + i];
    for (let a = 0; a < arms.length; a += 1) {
      const arm = arms[(a + i) % arms.length];
      const t0 = process.hrtime.bigint();
      const rows = arm.stmt.all(q, ...arm.params);
      const t1 = process.hrtime.bigint();
      arm.samples.push(Number(t1 - t0) / 1e6);
      arm.rowsMin = Math.min(arm.rowsMin, rows.length);
      arm.rowsMax = Math.max(arm.rowsMax, rows.length);
    }
  }

  const reduced = arms.map((arm) => {
    const sorted = [...arm.samples].sort((a, b) => a - b);
    return {
      form: arm.name,
      p50Ms: round(percentile(sorted, 50)),
      p90Ms: round(percentile(sorted, 90)),
      rowsMin: arm.rowsMin,
      rowsMax: arm.rowsMax,
    };
  });
  const byForm = Object.fromEntries(reduced.map((r) => [r.form, r]));
  lengths.push({
    partitions: partitionCount,
    vectors: partitionCount * ROWS_PER_PARTITION,
    arms: reduced,
    // The crossover the task asks for: literal against the escape, same rows.
    literalOverJsonEach: round(byForm.literal.p50Ms / byForm.json_each.p50Ms),
    boundOverJsonEach: round(byForm.bound.p50Ms / byForm.json_each.p50Ms),
    rowsAgree:
      byForm.literal.rowsMin === byForm.json_each.rowsMin &&
      byForm.literal.rowsMax === byForm.json_each.rowsMax &&
      byForm.bound.rowsMin === byForm.json_each.rowsMin,
  });
  db.close();
}

// Bind ceiling: the reason `idJsonSet` exists at all.
const { db: small, keys: smallKeys } = build(8);
const probeVector = rnd();
const bindCeiling = [];
for (const n of [1000, 32000, 32765, 32766, 32767, 40000]) {
  const names = Array.from({ length: n }, (_, i) => (i === 0 ? smallKeys[0] : `ABSENT${i}`));
  const row = { listLength: n };
  try {
    const stmt = small.prepare(
      `SELECT memory_id AS id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW}
       AND partition_key IN (${names.map(() => '?').join(',')}) AND status = 'active' ORDER BY distance`,
    );
    row.bound = { ok: true, rows: stmt.all(probeVector, ...names).length };
  } catch (err) {
    row.bound = { ok: false, error: String(err.message ?? err).slice(0, 120) };
  }
  try {
    const stmt = small.prepare(
      `SELECT memory_id AS id FROM memory_vec WHERE embedding MATCH ? AND k = ${RANK_WINDOW}
       AND partition_key IN (SELECT value FROM json_each(?)) AND status = 'active' ORDER BY distance`,
    );
    row.jsonEach = { ok: true, rows: stmt.all(probeVector, JSON.stringify(names)).length };
  } catch (err) {
    row.jsonEach = { ok: false, error: String(err.message ?? err).slice(0, 120) };
  }
  bindCeiling.push(row);
}
small.close();

const report = {
  instrument: 'I1 ISOLATED STATEMENT (synthetic, in-memory)',
  label,
  rowsPerPartition: ROWS_PER_PARTITION,
  rankWindowSize: RANK_WINDOW,
  warmup: WARMUP,
  timed: TIMED,
  node: process.version,
  lengths,
  bindCeiling,
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(out, json);
process.stdout.write(json);

const problems = [];
for (const l of lengths) {
  if (!l.rowsAgree) problems.push(`${l.partitions} partitions: the three forms disagree on rows`);
  if (l.arms.some((a) => a.rowsMin === 0)) {
    problems.push(`${l.partitions} partitions: a query returned zero rows`);
  }
}
// Non-vacuity for the ceiling probe: at least one length must succeed and at
// least one bound length must fail, or the probe measured nothing.
if (!bindCeiling.some((r) => r.bound.ok)) problems.push('no bound list succeeded');
if (!bindCeiling.some((r) => !r.bound.ok)) problems.push('no bound list hit the ceiling');
if (bindCeiling.some((r) => !r.jsonEach.ok)) problems.push('json_each failed at some length');
if (problems.length > 0) {
  console.error(`[scale-in-list] VACUOUS OR WRONG:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
