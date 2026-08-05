/**
 * Turns the raw runs under a results directory into the tables of
 * `vec-partition-scale.md`. No figure in that document is retyped.
 *
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/search-across-authorized-projects/measurements/scale-summarize.mjs \
 *     <resultsDir>
 *
 * Repeats are printed individually and reduced with the MEDIAN, never the mean:
 * averaging is what hid the bimodal cell corrected in
 * `vec-partition-capability.md` §4.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: scale-summarize.mjs <resultsDir>');
  process.exit(2);
}

const files = readdirSync(dir).sort();
const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const num = (n) => (n === undefined || n === null ? '—' : n.toFixed(2));

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function group(prefix) {
  const out = new Map();
  for (const f of files.filter((f) => f.startsWith(prefix) && f.endsWith('.json'))) {
    const m = /-(\d+)-([a-z0-9-]+)-rep(\d+)\.json$/.exec(f);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(load(f));
  }
  return out;
}

const magnitudeOrder = (a, b) => Number(a.split('|')[0]) - Number(b.split('|')[0]);

console.log('## I2 / I3 END-TO-END — narrow against widened\n');
const e2e = [...group('e2e-').entries()].sort(([a], [b]) => magnitudeOrder(a, b));
for (const [key, runs] of e2e) {
  const [magnitude, home] = key.split('|');
  const first = runs[0];
  console.log(
    `### ${Number(magnitude).toLocaleString('en-US')} memories, home \`${home}\` ` +
      `(${first.home.memories.toLocaleString('en-US')} of ${first.corpusMemories.toLocaleString('en-US')} rows), ` +
      `${runs.length} process runs\n`,
  );
  console.log(
    '| arm | projects | p50 per repeat (ms) | median p50 | median p90 | ×narrow | rows | foreign rows |',
  );
  console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  const narrowMedian = median(
    runs.map((r) => r.arms.find((a) => a.name === 'shipped-narrow').p50Ms),
  );
  for (const armName of first.arms.map((a) => a.name)) {
    const cells = runs.map((r) => r.arms.find((a) => a.name === armName));
    const p50 = median(cells.map((c) => c.p50Ms));
    console.log(
      `| \`${armName}\` | ${cells[0].projects} | ${cells.map((c) => num(c.p50Ms)).join(' / ')} | ` +
        `${num(p50)} | ${num(median(cells.map((c) => c.p90Ms)))} | ${num(p50 / narrowMedian)} | ` +
        `${cells[0].rowsReturnedTotal} | ${cells.map((c) => c.foreignScopeRows).join('/')} |`,
    );
  }
  const controls = runs.map((r) => r.singleElementInControl);
  console.log(
    `\nSingle-element \`IN\` id control: ${controls.every((c) => c.idsIdentical) ? 'IDENTICAL' : 'DIVERGED'} ` +
      `on all ${controls.reduce((n, c) => n + c.comparedQueries, 0)} compared pages, ` +
      `${controls.reduce((n, c) => n + c.nonEmptyPages, 0)} of them non-empty.\n`,
  );
}

console.log('\n## Dense pool composition (untimed) — what each window policy hands to fusion\n');
for (const [key, runs] of e2e) {
  const [magnitude, home] = key.split('|');
  console.log(`### ${Number(magnitude).toLocaleString('en-US')} memories, home \`${home}\`\n`);
  console.log('| arm | k per partition | dense candidates per query | home share | per project |');
  console.log('| --- | ---: | ---: | ---: | --- |');
  for (const c of runs[0].densePoolComposition ?? []) {
    console.log(
      `| \`${c.arm}\` | ${c.kPerPartition} | ${c.candidatesPerQuery} | ${(c.homeShare * 100).toFixed(1)}% | ` +
        `${c.perProjectPerQuery.map(([slug, n]) => `${slug} ${n}`).join(', ')} |`,
    );
  }
  console.log('');
}

console.log('\n## I1 ISOLATED STATEMENT — the two branches\n');
const stmt = [...group('stmt-').entries()].sort(([a], [b]) => magnitudeOrder(a, b));
for (const branch of ['dense', 'lexical', 'textByIds']) {
  console.log(`### ${branch} branch\n`);
  console.log(
    '| magnitude | home | arm | projects | p50 per repeat (ms) | median p50 | ×shipped |',
  );
  console.log('| ---: | --- | --- | ---: | --- | ---: | ---: |');
  for (const [key, runs] of stmt) {
    const [magnitude, home] = key.split('|');
    const first = runs[0];
    const base = median(runs.map((r) => r[branch][0].p50Ms));
    for (const armName of first[branch].map((a) => a.name)) {
      const cells = runs.map((r) => r[branch].find((a) => a.name === armName));
      const p50 = median(cells.map((c) => c.p50Ms));
      console.log(
        `| ${Number(magnitude).toLocaleString('en-US')} | \`${home}\` | \`${armName}\` | ${cells[0].projects} | ` +
          `${cells.map((c) => num(c.p50Ms)).join(' / ')} | ${num(p50)} | ${num(p50 / base)} |`,
      );
    }
  }
  console.log('');
}

console.log('\n### Query plans (recorded, not used to decide anything)\n');
if (stmt.length > 0) {
  for (const p of stmt[stmt.length - 1][1][0].plans) {
    console.log(`- \`${p.arm}\` → ${p.plan.map((d) => `\`${d}\``).join(' + ')}`);
  }
}

console.log('\n\n## I1 ISOLATED STATEMENT — `IN`-list length\n');
const inlist = files.filter((f) => f.startsWith('inlist-') && f.endsWith('.json')).map(load);
if (inlist.length > 0) {
  console.log(
    `Synthetic, in-memory, ${inlist[0].rowsPerPartition} rows per partition, ` +
      `\`chunk_size=8\`, ${inlist.length} process runs.\n`,
  );
  console.log(
    '| named partitions | vectors | literal p50 (ms) | bound p50 | `json_each` p50 | literal ÷ `json_each` | bound ÷ `json_each` | rows agree |',
  );
  console.log('| ---: | ---: | --- | --- | --- | ---: | ---: | --- |');
  for (let i = 0; i < inlist[0].lengths.length; i += 1) {
    const cells = inlist.map((r) => r.lengths[i]);
    const forms = (name) =>
      cells.map((c) => num(c.arms.find((a) => a.form === name).p50Ms)).join(' / ');
    const ratio = (field) => num(median(cells.map((c) => c[field])));
    console.log(
      `| ${cells[0].partitions} | ${cells[0].vectors} | ${forms('literal')} | ${forms('bound')} | ` +
        `${forms('json_each')} | ${ratio('literalOverJsonEach')} | ${ratio('boundOverJsonEach')} | ` +
        `${cells.every((c) => c.rowsAgree) ? 'yes' : 'NO'} |`,
    );
  }
  console.log('\n| list length | bound parameters | `json_each` |');
  console.log('| ---: | --- | --- |');
  for (let i = 0; i < inlist[0].bindCeiling.length; i += 1) {
    const c = inlist[0].bindCeiling[i];
    const show = (x) => (x.ok ? `ok, ${x.rows} rows` : `**${x.error}**`);
    console.log(`| ${c.listLength} | ${show(c.bound)} | ${show(c.jsonEach)} |`);
  }
}

console.log('\n\n## Task 2.6 — the committed capability harness, repeated\n');
const scaleRuns = files.filter((f) => f.startsWith('vec-partition-scale-rep'));
if (scaleRuns.length > 0) {
  const byBlock = new Map();
  for (const f of scaleRuns) {
    let block = null;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const header = /^=== (\d+) partitions x (\d+) = (\d+) vectors/.exec(line);
      if (header) block = header[3];
      if (!line.startsWith('{') || block === null) continue;
      const row = JSON.parse(line);
      const key = `${block}|${row.label}`;
      if (!byBlock.has(key)) byBlock.set(key, []);
      byBlock.get(key).push(row);
    }
  }
  console.log(`${scaleRuns.length} process runs of \`vec-partition-scale.mjs\`, unmodified.\n`);
  console.log('| vectors | arm | p50 per repeat (ms) | median | ×1 partition | rows |');
  console.log('| ---: | --- | --- | ---: | ---: | ---: |');
  const blocks = [...new Set([...byBlock.keys()].map((k) => k.split('|')[0]))].sort(
    (a, b) => Number(a) - Number(b),
  );
  for (const block of blocks) {
    const base = median(byBlock.get(`${block}|1 partition (today)`).map((r) => Number(r.p50)));
    for (const [key, rows] of byBlock) {
      if (!key.startsWith(`${block}|`)) continue;
      const p50 = median(rows.map((r) => Number(r.p50)));
      console.log(
        `| ${Number(block).toLocaleString('en-US')} | ${key.split('|')[1]} | ` +
          `${rows.map((r) => r.p50).join(' / ')} | ${num(p50)} | ${num(p50 / base)} | ${rows[0].rows} |`,
      );
    }
  }
}
