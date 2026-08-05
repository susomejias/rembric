/**
 * Turns the run JSONs `scale-run.sh` produced into the markdown tables in
 * scale.md, so no figure in that file is retyped by hand.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/retire-the-global-scope/measurements/scale-summarize.mjs \
 *     <resultsDir>
 *
 * Reps are reduced with the MEDIAN. Min would flatter the migration (it is the
 * one boot an operator gets, not the best of three) and the mean would let a
 * single checkpoint-unlucky rep set the figure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: scale-summarize.mjs <resultsDir>');

const MB = (b) => (b / 1048576).toFixed(0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const runs = new Map();
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const m =
    /^(\d+)-(set|loop|rebuild|id-is-partition|runner|boot|insert-first)(?:-(\d+|vacuum))?\.json$/.exec(
      f,
    );
  if (!m) continue;
  const [, n, variant, rep] = m;
  const key = `${n}|${variant}|${rep === 'vacuum' ? 'vacuum' : 'rep'}`;
  if (!runs.has(key)) runs.set(key, []);
  runs.get(key).push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const magnitudes = [...new Set([...runs.keys()].map((k) => Number(k.split('|')[0])))].sort(
  (a, b) => a - b,
);
const pick = (n, variant, kind = 'rep') => runs.get(`${n}|${variant}|${kind}`) ?? [];
const med = (rs, f) => (rs.length ? median(rs.map(f)) : null);
const fmt = (v, d = 0) => (v === null ? '—' : v.toFixed(d));

const out = [];

out.push('### I1 BODY-ISOLATED — whole body, per variant (median of reps)\n');
out.push('| global rows | reps | set-based (ms) | per-row loop (ms) | loop ÷ set |');
out.push('| ---: | ---: | ---: | ---: | ---: |');
for (const n of magnitudes) {
  const s = pick(n, 'set');
  const l = pick(n, 'loop');
  const ms = med(s, (r) => r.totalMs);
  const ml = med(l, (r) => r.totalMs);
  out.push(
    `| ${n.toLocaleString('en-US')} | ${s.length} | ${fmt(ms)} | ${fmt(ml)} | ${ms && ml ? (ml / ms).toFixed(2) : '—'} |`,
  );
}

out.push('\n### I1 BODY-ISOLATED — statement-group breakdown, set-based variant (median ms)\n');
const groupOrder = [
  'alter-projects-is_default',
  'insert-default-project',
  'update-memory',
  'update-memory_entities',
  'update-sessions',
  'update-prompts',
  'update-consolidation_runs',
  'vec-create-stash',
  'vec-fill-stash',
  'vec-delete-global',
  'vec-insert-repointed',
  'vec-drop-stash',
  'foreign_key_check',
  'COMMIT',
];
out.push(`| statement group | ${magnitudes.map((n) => n.toLocaleString('en-US')).join(' | ')} |`);
out.push(`| --- | ${magnitudes.map(() => '---:').join(' | ')} |`);
for (const g of groupOrder) {
  const cells = magnitudes.map((n) =>
    fmt(
      med(pick(n, 'set'), (r) => r.timingMs[g] ?? 0),
      1,
    ),
  );
  out.push(`| \`${g}\` | ${cells.join(' | ')} |`);
}
out.push(
  `| **whole body** | ${magnitudes.map((n) => `**${fmt(med(pick(n, 'set'), (r) => r.totalMs))}**`).join(' | ')} |`,
);

out.push('\n### I1 BODY-ISOLATED — statement-group breakdown, per-row loop variant (median ms)\n');
const loopOrder = [
  'update-memory',
  'update-memory_entities',
  'loop-read-global-rows',
  'loop-delete-insert',
  'foreign_key_check',
  'COMMIT',
];
out.push(`| statement group | ${magnitudes.map((n) => n.toLocaleString('en-US')).join(' | ')} |`);
out.push(`| --- | ${magnitudes.map(() => '---:').join(' | ')} |`);
for (const g of loopOrder) {
  const cells = magnitudes.map((n) =>
    fmt(
      med(pick(n, 'loop'), (r) => r.timingMs[g] ?? 0),
      1,
    ),
  );
  out.push(`| \`${g}\` | ${cells.join(' | ')} |`);
}
out.push(
  `| **whole body** | ${magnitudes.map((n) => `**${fmt(med(pick(n, 'loop'), (r) => r.totalMs))}**`).join(' | ')} |`,
);

out.push('\n### I2 RUNNER-WHOLE-BODY and I3 FULL-BOOT (median ms)\n');
out.push('| global rows | I1 set-based body | I2 real `migrate()` | I3 real `createDb()` |');
out.push('| ---: | ---: | ---: | ---: |');
for (const n of magnitudes) {
  out.push(
    `| ${n.toLocaleString('en-US')} | ${fmt(med(pick(n, 'set'), (r) => r.totalMs))} | ${fmt(med(pick(n, 'runner'), (r) => r.totalMs))} | ${fmt(med(pick(n, 'boot'), (r) => r.totalMs))} |`,
  );
}

out.push('\n### Transaction size and disk (set-based; median of reps)\n');
out.push(
  '| global rows | db before | WAL high-water | db after body | growth | freelist after | after VACUUM | VACUUM ms |',
);
out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const n of magnitudes) {
  const s = pick(n, 'set');
  const v = pick(n, 'set', 'vacuum')[0];
  const before = med(s, (r) => r.bytes.dbBeforeBody);
  const afterB = med(s, (r) => r.bytes.dbAfterBody);
  const free = med(s, (r) => r.pages.freelistCount * r.pages.pageSize);
  out.push(
    `| ${n.toLocaleString('en-US')} | ${MB(before)} MB | ${MB(med(s, (r) => r.bytes.walPeak))} MB | ${MB(afterB)} MB | +${MB(afterB - before)} MB (+${(((afterB - before) / before) * 100).toFixed(0)}%) | ${MB(free)} MB | ${v ? `${MB(v.bytes.dbAfterBody === 0 ? 0 : v.vacuum.bytesAfter)} MB` : '—'} | ${v ? v.vacuum.ms : '—'} |`,
  );
}

out.push('\n### Transaction size and disk (per-row loop; median of reps)\n');
out.push('| global rows | db before | WAL high-water | db after body | growth |');
out.push('| ---: | ---: | ---: | ---: | ---: |');
for (const n of magnitudes) {
  const l = pick(n, 'loop');
  if (!l.length) continue;
  const before = med(l, (r) => r.bytes.dbBeforeBody);
  const afterB = med(l, (r) => r.bytes.dbAfterBody);
  out.push(
    `| ${n.toLocaleString('en-US')} | ${MB(before)} MB | ${MB(med(l, (r) => r.bytes.walPeak))} MB | ${MB(afterB)} MB | +${MB(afterB - before)} MB (+${(((afterB - before) / before) * 100).toFixed(0)}%) |`,
  );
}

out.push('\n### The four ways to repoint `memory_vec` (I1 BODY-ISOLATED, median ms / MB)\n');
out.push('| global rows | | A per-row loop | B set-based | D full rebuild | E id = `__global__` |');
out.push('| ---: | --- | ---: | ---: | ---: | ---: |');
for (const n of magnitudes) {
  const cells = (f) => ['loop', 'set', 'rebuild', 'id-is-partition'].map((v) => f(pick(n, v)));
  const body = cells((rs) => fmt(med(rs, (r) => r.totalMs)));
  const wal = cells((rs) => (rs.length ? `${MB(med(rs, (r) => r.bytes.walPeak))} MB` : '—'));
  const grow = cells((rs) =>
    rs.length
      ? `+${MB(med(rs, (r) => r.bytes.dbAfterBody) - med(rs, (r) => r.bytes.dbBeforeBody))} MB`
      : '—',
  );
  out.push(`| ${n.toLocaleString('en-US')} | whole body (ms) | ${body.join(' | ')} |`);
  out.push(`| | WAL high-water | ${wal.join(' | ')} |`);
  out.push(`| | db growth | ${grow.join(' | ')} |`);
}

out.push('\n### Correctness — aggregated over every run at every magnitude\n');
out.push(
  '| global rows | variant | runs | assertions per run | failures | blob samples byte-identical / cosine 0 | kNN rows, new partition (min) | kNN rows, control partition (min) |',
);
out.push('| ---: | --- | ---: | ---: | --- | ---: | ---: | ---: |');
for (const n of magnitudes) {
  for (const variant of ['set', 'loop', 'rebuild', 'id-is-partition', 'runner', 'boot']) {
    const rs = pick(n, variant).filter((r) => !r.failed);
    if (!rs.length) continue;
    const fails = rs.flatMap((r) => r.failures);
    const checked = rs.reduce((a, r) => a + r.blobs.checked, 0);
    const identical = rs.reduce((a, r) => a + r.blobs.byteIdentical, 0);
    const cosine = rs.reduce((a, r) => a + r.blobs.cosineZero, 0);
    out.push(
      `| ${n.toLocaleString('en-US')} | ${variant} | ${rs.length} | ${(() => {
        const c = rs.map((r) => r.assertions.length);
        const lo = Math.min(...c);
        const hi = Math.max(...c);
        return lo === hi ? `${lo}` : `${lo}–${hi}`;
      })()} | ${fails.length ? [...new Set(fails)].join('; ') : '**none**'} | ${identical}/${checked} / ${cosine}/${checked} | ${Math.min(...rs.map((r) => r.knnRows))} | ${Math.min(...rs.map((r) => r.controlKnnRows))} |`,
    );
  }
}

process.stdout.write(`${out.join('\n')}\n`);
