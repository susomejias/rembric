// Validations 1, 3 and 7 on the labelled save-time fixture; phase `no-embedder` is the no-inference check.
// Instrument: pending rows of the fixture scope and the drain decision per pair (not a timing).
// Run: DRAIN_SCRATCH=$(mktemp -d) pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/fixture-drain.mts [main|no-embedder]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';

const SCRATCH = process.env.DRAIN_SCRATCH;
if (!SCRATCH) throw new Error('set DRAIN_SCRATCH to a mktemp -d directory outside the workspace');
const PHASE = process.argv[2] ?? 'main';

const dlopened: string[] = [];
if (PHASE === 'no-embedder') {
  const original = process.dlopen;
  process.dlopen = function (this: unknown, module: unknown, filename: string, ...rest: unknown[]) {
    dlopened.push(filename);
    return (original as any).call(this, module, filename, ...rest);
  } as typeof process.dlopen;
  register(
    'data:text/javascript,' +
      encodeURIComponent(
        `export async function resolve(s, c, next) {
           if (/@huggingface\\/transformers|onnxruntime/.test(s)) throw new Error('blocked model runtime import: ' + s);
           return next(s, c);
         }`,
      ),
  );
}

const P = await import('./drain-prototype.mts');
const { SAVE_TIME_BASE, SAVE_TIME_SAVES } = await import(
  new URL('packages/core/src/test-support/retrieval/save-time-fixture.ts', P.ROOT).href
);

const BATCH = 50;
const SNAPSHOT_DIR = join(SCRATCH, 'fixture-prod-f000-snapshot');
const DECISIONS_JSON = join(SCRATCH, 'fixture-prod-f000-decisions.json');

interface FixtureMeta {
  kind: 'base' | 'near-duplicate' | 'expanded-rewrite' | 'contradiction' | 'unrelated';
  title: string;
  expects?: string;
}
const META = new Map<string, FixtureMeta>([
  ...SAVE_TIME_BASE.map((b: any) => [b.id, { kind: 'base', title: b.title }] as const),
  ...SAVE_TIME_SAVES.map(
    (s: any) => [s.id, { kind: s.class, title: s.title, expects: s.expects }] as const,
  ),
]);

interface BuiltFixture {
  handle: any;
  repos: any;
  projectId: string;
  fixtureIdById: Map<string, string>;
  baseRows: number;
  labelledRows: number;
}

async function buildFixture(dataDir: string, embedder: any, floor: number): Promise<BuiltFixture> {
  mkdirSync(dataDir, { recursive: true });
  const handle = P.openDb(dataDir);
  const repos = P.db.createRepositories(handle.db);
  const project = new P.core.ProjectsService(repos).create({
    slug: 'save-time',
    displayName: 'Save-time fixture',
  });
  const scope = P.db.projectScope(project.id);
  const clock = new P.TestClock();
  const memory = new P.core.MemoryService(repos, handle.db, clock.now);
  const relations = new P.core.RelationsService(repos, handle.db, clock.now);
  const worker = embedder ? new P.core.EmbeddingWorker({ repos, embedder }) : null;
  const deps = {
    relations,
    repos,
    candidates: { perSaveMax: 5, lexicalFloor: floor },
    ...(worker
      ? {
          embedNow: (id: string, title: string, content: string, projectId: string) =>
            worker.embedNow(id, title, content, projectId),
        }
      : {}),
  };
  const fixtureIdById = new Map<string, string>();
  const save = async (item: any): Promise<number> => {
    clock.set(new Date(clock.now().getTime() + 60_000));
    const { memory: saved } = memory.saveWithTopicKey(
      { type: item.type, title: item.title, content: item.content },
      scope,
    );
    fixtureIdById.set(saved.id, item.id);
    const { candidates } = await P.core.runPostSaveSteps(deps, saved, scope);
    return candidates.length;
  };
  let baseRows = 0;
  let labelledRows = 0;
  for (const item of SAVE_TIME_BASE) baseRows += await save(item);
  for (const item of SAVE_TIME_SAVES) labelledRows += await save(item);
  return { handle, repos, projectId: project.id, fixtureIdById, baseRows, labelledRows };
}

function pairKey(fx: BuiltFixture, p: { sourceId: string; targetId: string }): string {
  return `${fx.fixtureIdById.get(p.sourceId)} -> ${fx.fixtureIdById.get(p.targetId)}`;
}

function fmtCheck(d: any): string {
  const c = d.check;
  const lex = c.lexical === null ? '—' : c.lexical.toFixed(3);
  const vec = c.vector === null ? '—' : c.vector === 'missing' ? 'missing' : c.vector.toFixed(3);
  const ent = c.shared === null ? '—' : c.shared.length > 0 ? c.shared.join(',') : 'none';
  const re =
    c.reextracted === null
      ? ''
      : ` | re-extracted ${c.reextracted.length > 0 ? c.reextracted.join(',') : 'none'}`;
  return `lex ${lex} | vec ${vec} | stored entity ${ent}${re}`;
}

function report(
  arm: string,
  fx: BuiltFixture,
  before: any[],
  decisions: any[],
  out: string[],
): void {
  const byId = new Map(decisions.map((d) => [d.judgmentId, d]));
  const kindOf = (id: string) => META.get(fx.fixtureIdById.get(id)!)!.kind;
  const drained = decisions.filter((d) => d.verdict === 'drained');
  const kept = decisions.filter((d) => d.verdict === 'kept');
  const other = decisions.filter((d) => d.verdict !== 'drained' && d.verdict !== 'kept');
  out.push(
    `## ${arm}`,
    `pendings before: ${before.length} (base saves wrote ${fx.baseRows}; labelled saves wrote ${fx.labelledRows} — control: the committed sweep reports 135 at floor 0.00 in both arms)`,
    `drained: ${drained.length} (stale ${drained.filter((d) => d.reason === 'drained:stale').length}, retired endpoint ${drained.filter((d) => d.reason === 'drained:retired').length})`,
    `kept: ${kept.length}`,
    `other verdicts (not-pending / write-failed): ${other.length}`,
    '',
    'kept by primary reason (first admitting channel in the order lexical, vector, entity; else the fail-safe):',
  );
  const reasons = new Map<string, number>();
  for (const d of kept) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
  for (const [r, n] of [...reasons].sort()) out.push(`  ${r.padEnd(32)} ${P.pad(n, 4)}`);
  out.push('', 'kept by exact admitting-channel combination:');
  const combos = new Map<string, number>();
  for (const d of kept) {
    const k = d.check.admitted.length > 0 ? d.check.admitted.join('+') : d.reason;
    combos.set(k, (combos.get(k) ?? 0) + 1);
  }
  for (const [r, n] of [...combos].sort()) out.push(`  ${r.padEnd(32)} ${P.pad(n, 4)}`);

  out.push('', 'by pair class (source kind -> target kind): pending / drained / kept');
  const classes = new Map<string, { pending: number; drained: number; kept: number }>();
  for (const p of before) {
    const k = `${kindOf(p.sourceId)} -> ${kindOf(p.targetId)}`;
    const e = classes.get(k) ?? { pending: 0, drained: 0, kept: 0 };
    e.pending += 1;
    const v = byId.get(p.judgmentId)?.verdict;
    if (v === 'drained') e.drained += 1;
    if (v === 'kept') e.kept += 1;
    classes.set(k, e);
  }
  for (const [k, e] of [...classes].sort()) {
    out.push(`  ${k.padEnd(40)} ${P.pad(e.pending, 4)} ${P.pad(e.drained, 4)} ${P.pad(e.kept, 4)}`);
  }

  const expected = before.filter((p) => {
    const src = META.get(fx.fixtureIdById.get(p.sourceId)!)!;
    return src.expects !== undefined && src.expects === fx.fixtureIdById.get(p.targetId);
  });
  const falseDrains = expected.filter((p) => byId.get(p.judgmentId)?.verdict !== 'kept');
  out.push(
    '',
    `labelled pairs (save -> its expected base item) pending before the drain: ${expected.length} of ${SAVE_TIME_SAVES.filter((s: any) => s.expects).length}`,
    `FALSE DRAINS (a labelled pair not kept): ${falseDrains.length}`,
  );
  for (const p of expected) {
    const d = byId.get(p.judgmentId);
    out.push(
      `  ${d.verdict.padEnd(8)} ${pairKey(fx, p).padEnd(34)} ${d.reason.padEnd(26)} ${fmtCheck(d)}`,
    );
  }

  const unrelated = before.filter((p) => kindOf(p.sourceId) === 'unrelated');
  const unrelatedDrained = unrelated.filter((p) => byId.get(p.judgmentId)?.verdict === 'drained');
  out.push(
    '',
    `pairs whose source is an unrelated save: ${unrelated.length}; drained ${unrelatedDrained.length}; kept ${unrelated.length - unrelatedDrained.length}`,
  );
  const unrelatedKept = unrelated.filter((q) => byId.get(q.judgmentId)?.verdict !== 'drained');
  for (const p of unrelatedKept.filter(
    (q) => !byId.get(q.judgmentId).reason.startsWith('fail-safe'),
  )) {
    const d = byId.get(p.judgmentId);
    out.push(`  kept     ${pairKey(fx, p).padEnd(34)} ${d.reason.padEnd(26)} ${fmtCheck(d)}`);
  }
  const unrelatedFailSafe = unrelatedKept.filter((q) =>
    byId.get(q.judgmentId).reason.startsWith('fail-safe'),
  ).length;
  if (unrelatedFailSafe > 0) out.push(`  (${unrelatedFailSafe} kept by a fail-safe, not listed)`);
  const drainedSources = new Map<string, number>();
  for (const d of drained) {
    drainedSources.set(kindOf(d.sourceId), (drainedSources.get(kindOf(d.sourceId)) ?? 0) + 1);
  }
  out.push(
    `drained pairs by source kind: ${[...drainedSources].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
  );

  const listed = kept.filter((d) => !d.reason.startsWith('fail-safe'));
  out.push(
    '',
    `every kept pair not kept by a fail-safe, by title (${kept.length - listed.length} fail-safe keeps not listed):`,
  );
  for (const d of listed) {
    const s = META.get(fx.fixtureIdById.get(d.sourceId)!)!;
    const t = META.get(fx.fixtureIdById.get(d.targetId)!)!;
    out.push(`  [${d.reason}] "${s.title}" -> "${t.title}" (${fmtCheck(d)})`);
  }
  out.push('', 'sample of drained pairs, by title (every 8th in judgment_id order):');
  drained.forEach((d, i) => {
    if (i % 8 !== 0) return;
    const s = META.get(fx.fixtureIdById.get(d.sourceId)!)!;
    const t = META.get(fx.fixtureIdById.get(d.targetId)!)!;
    out.push(`  "${s.title}" -> "${t.title}" (${fmtCheck(d)})`);
  });
}

function verifyAndControl(fx: BuiltFixture, before: any[], decisions: any[], out: string[]): void {
  const map = new Map(decisions.map((d) => [d.judgmentId, d]));
  const v = P.verifyDrain(fx.handle, fx.projectId, before, map);
  out.push(
    '### validation 3 — consistency (independent recomputation over raw read-only queries)',
    `pairs checked ${v.pairs}; recomputed stale drain ${v.expectedDrained}, retired drain ${v.expectedRetired}, keep ${v.expectedKept}; mismatches ${v.mismatches.length}`,
    `max |lexical(drain) - lexical(recomputed)| = ${v.maxLexicalDelta.toExponential(2)}; max |cosine(drain, sqlite-vec) - cosine(recomputed, float64)| = ${v.maxVectorDelta.toExponential(2)}`,
    `pairs within 1e-4 of the vector threshold: ${v.nearVectorThreshold}; exactly at the lexical floor: ${v.nearLexicalFloor}`,
    ...v.mismatches.slice(0, 20).map((m) => `  MISMATCH ${m}`),
  );
  const flipped = new Map(map);
  const aDrained = decisions.find((d) => d.verdict === 'drained');
  const aKept = decisions.find((d) => d.verdict === 'kept');
  if (aDrained) flipped.set(aDrained.judgmentId, { ...aDrained, verdict: 'kept' });
  if (aKept) flipped.set(aKept.judgmentId, { ...aKept, verdict: 'drained' });
  const c = P.verifyDrain(fx.handle, fx.projectId, before, flipped);
  const expectedFlags = (aDrained ? 1 : 0) + (aKept ? 1 : 0);
  out.push(
    `control (must flag): one drained and one kept decision flipped in a copy of the log -> ${c.mismatches.length} mismatch(es) flagged, expected ${expectedFlags}: ${c.mismatches.length === expectedFlags ? 'PASS' : 'FAIL'}`,
  );
}

function relationRow(handle: any, judgmentId: string): any {
  // VERIFICATION READ (raw, read-only)
  return handle.raw
    .prepare(
      'SELECT status, relation, reason, marked_by_kind AS markedByKind, judged_at AS judgedAt FROM memory_relations WHERE judgment_id = ?',
    )
    .get(judgmentId);
}

function undoValidation(fx: BuiltFixture, before: any[], pass: any, out: string[]): void {
  const drainedIds = pass.decisions
    .filter((d: any) => d.verdict === 'drained')
    .map((d: any) => d.judgmentId);
  const preDrain = new Set(before.map((p) => p.judgmentId));
  const pendingNow = P.pendingIds(fx.handle, fx.projectId).length;
  const drainRuns = pass.runs.filter((r: any) => r.drained > 0);
  let reverted = 0;
  let skipped = 0;
  const [first, ...rest] = drainRuns;
  if (first) {
    for (const op of fx.repos.consolidation.listActiveOps(first.runId)) {
      const r = P.core.undoOp(fx.repos, fx.handle.db, op.id);
      reverted += 1;
      skipped += r.skipped.length;
    }
  }
  for (const run of [...rest].reverse()) {
    const r = P.core.undoRun(fx.repos, fx.handle.db, run.runId);
    reverted += r.reverted.length;
    skipped += r.skipped.length;
  }
  const after = new Set(P.pendingIds(fx.handle, fx.projectId));
  const restored = drainedIds.filter((id: string) => {
    const row = relationRow(fx.handle, id);
    return (
      row.status === 'pending' &&
      row.relation === null &&
      row.reason === null &&
      row.markedByKind === null &&
      row.judgedAt === null
    );
  });
  // VERIFICATION READ (raw, read-only)
  const activeDrainOps = fx.handle.raw
    .prepare(
      `SELECT count(*) AS n FROM consolidation_ops WHERE op_type = 'orphan_promote' AND reverted_at IS NULL AND reasoning LIKE 'orphaned: ${P.DRAIN_REASON_PREFIX}:%'`,
    )
    .get().n;
  const sameSet = after.size === preDrain.size && [...preDrain].every((id) => after.has(id));
  out.push(
    "### validation 7 — undo through the dashboard's service path (first run op by op with undoOp, the rest with undoRun)",
    `before undo: pending ${pendingNow}, drained ${drainedIds.length} (control: pending + drained = ${pendingNow + drainedIds.length}, pre-drain pending ${preDrain.size})`,
    `ops reverted ${reverted} (expected ${drainedIds.length}); topic-slot skips ${skipped}; drain ops still active ${activeDrainOps}`,
    `drained rows back to a clean pending state (status, relation, reason, marked_by_kind, judged_at): ${restored.length}/${drainedIds.length}`,
    `pending after undo ${after.size}; identical to the pre-drain pending set: ${sameSet ? 'yes' : 'NO'}`,
  );
  const again = P.drainOnePass(P.createContext(fx.handle), fx.projectId, BATCH);
  const redrained = again.decisions.filter((d: any) => d.verdict === 'drained').length;
  const excluded = again.decisions.filter((d: any) => d.reason === 'excluded:operator-undo').length;
  out.push(
    `the next drain pass after the undo: re-drained ${redrained}, excluded as operator-undo ${excluded}/${drainedIds.length} (undo is final, rules v3; under v2 the same pass re-drained all ${drainedIds.length}, see v2-fixture-drain.txt)`,
  );
}

async function main(): Promise<void> {
  const out: string[] = [
    '# stale pending drain — labelled save-time fixture, rules v3',
    `fixture: ${SAVE_TIME_BASE.length} base memories, ${SAVE_TIME_SAVES.length} labelled saves; saved through runPostSaveSteps with lexicalFloor 0 (pre-floor behaviour), per-save cap 5`,
    `rules v3: lexical >= ${P.LEXICAL_FLOOR} (tokenContainment), vector >= ${P.VEC_THRESHOLD} (1 - clamp(vec_distance_cosine)), any shared entity in the stored links OR in a fresh extractEntities of both endpoints; a superseded/archived endpoint is drained as 'endpoint retired'; a pair is excluded once any orphan_promote op on it was reverted; fail-safe keeps missing endpoints, an endpoint over DRAIN_MAX_PAIR_CHARS = ${P.DRAIN_MAX_PAIR_CHARS}, missing vectors, a stale vector index, a failed extraction and errors`,
    `drain batch B = ${BATCH}, cursor carried in memory between runs; scratch root ${SCRATCH}`,
    '',
  ];
  const embedder = P.memoized(await P.core.loadEmbedder());
  out.push(`embedding model: ${embedder.modelId}`, '');

  const prod = await buildFixture(join(SCRATCH, 'fixture-prod-f000'), embedder, 0);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  await prod.handle.raw.backup(join(SNAPSHOT_DIR, 'data.db'));
  const before = P.pendingPairs(prod.handle, prod.projectId);
  const pass = P.drainOnePass(P.createContext(prod.handle), prod.projectId, BATCH);
  out.push(
    `runs in the first pass: ${pass.runs.length} (${pass.runs.map((r: any) => `${r.examined}/${r.drained}`).join(' ')} examined/drained)`,
  );
  const second = P.drainOnePass(P.createContext(prod.handle), prod.projectId, BATCH);
  out.push(
    `second full pass: ${second.runs.length} runs, examined ${second.decisions.length}, drained ${second.decisions.filter((d: any) => d.verdict === 'drained').length} (fixpoint after one pass)`,
    '',
  );
  report('validation 1 — production arm (real embedder)', prod, before, pass.decisions, out);
  out.push('');
  verifyAndControl(prod, before, pass.decisions, out);
  writeFileSync(
    DECISIONS_JSON,
    JSON.stringify(
      Object.fromEntries(
        pass.decisions.map((d: any) => [d.judgmentId, `${d.verdict}|${d.reason}`]),
      ),
    ),
  );

  const f060 = await buildFixture(join(SCRATCH, 'fixture-prod-f060'), embedder, P.LEXICAL_FLOOR);
  const p60 = P.pendingPairs(f060.handle, f060.projectId).map((p) => pairKey(f060, p));
  const keptKeys = new Set(
    pass.decisions.filter((d: any) => d.verdict === 'kept').map((d: any) => pairKey(prod, d)),
  );
  const missing = p60.filter((k) => !keptKeys.has(k));
  const extra = pass.decisions.filter(
    (d: any) => d.verdict === 'kept' && !p60.includes(pairKey(prod, d)),
  );
  out.push(
    '',
    '### superset check against the shipped floor (same fixture saved at lexicalFloor 0.60, production arm)',
    `pending pairs written at 0.60: ${p60.length}; kept by the drain: ${keptKeys.size}; written at 0.60 and kept: ${p60.length - missing.length}; written at 0.60 but NOT kept: ${missing.length}`,
    ...missing.map((k) => `  NOT KEPT ${k}`),
    `kept but not written at 0.60: ${extra.length}`,
    ...extra.map(
      (d: any) => `  ${pairKey(prod, d).padEnd(34)} ${d.reason.padEnd(26)} ${fmtCheck(d)}`,
    ),
  );
  f060.handle.close();

  out.push('');
  undoValidation(prod, before, pass, out);
  prod.handle.close();

  const lex = await buildFixture(join(SCRATCH, 'fixture-lex-f000'), null, 0);
  const lexBefore = P.pendingPairs(lex.handle, lex.projectId);
  const lexPass = P.drainOnePass(P.createContext(lex.handle), lex.projectId, BATCH);
  out.push('');
  report(
    'validation 1 — lexical-only arm (no embedder, so no stored vectors)',
    lex,
    lexBefore,
    lexPass.decisions,
    out,
  );
  out.push('');
  verifyAndControl(lex, lexBefore, lexPass.decisions, out);
  lex.handle.close();
  console.log(out.join('\n'));
}

async function noEmbedder(): Promise<void> {
  const out: string[] = [
    '# stale pending drain — no model inference (fresh process, no embedder loaded)',
    `snapshot: ${SNAPSHOT_DIR} (the production-arm fixture database copied before its drain)`,
    'guards installed before any module loads: a resolve hook that throws on @huggingface/transformers and onnxruntime, and a process.dlopen recorder',
    '',
  ];
  const expected: Record<string, string> = JSON.parse(readFileSync(DECISIONS_JSON, 'utf8'));
  const handle = P.openDb(SNAPSHOT_DIR);
  const spy = P.throwingEmbedder();
  const repos = P.db.createRepositories(handle.db);
  const insertEmbedding = repos.vectors.insertEmbedding.bind(repos.vectors);
  let vectorWrites = 0;
  repos.vectors.insertEmbedding = (...args: unknown[]) => {
    vectorWrites += 1;
    return insertEmbedding(...args);
  };
  // VERIFICATION READ (raw, read-only)
  const vecCount = () => handle.raw.prepare('SELECT count(*) AS n FROM memory_vec').get().n;
  const project = repos.projects.findBySlug('save-time');
  const vecBefore = vecCount();
  const pass = P.drainOnePass(
    P.createContext(handle, { repos, embedder: spy.embedder }),
    project.id,
    BATCH,
  );
  const got = Object.fromEntries(
    pass.decisions.map((d: any) => [d.judgmentId, `${d.verdict}|${d.reason}`]),
  );
  const keys = new Set([...Object.keys(expected), ...Object.keys(got)]);
  const diffs = [...keys].filter((k) => expected[k] !== got[k]);
  out.push(
    `decisions: ${Object.keys(got).length} in this process, ${Object.keys(expected).length} in the embedder-loaded process; differing: ${diffs.length}`,
    `drained ${pass.decisions.filter((d: any) => d.verdict === 'drained').length}, kept ${pass.decisions.filter((d: any) => d.verdict === 'kept').length}`,
    `spy embedder calls: ${spy.calls()}; VectorsRepository.insertEmbedding calls: ${vectorWrites}; memory_vec rows ${vecBefore} -> ${vecCount()}`,
    ...diffs.slice(0, 10).map((k) => `  DIFF ${k}: expected ${expected[k]}, got ${got[k]}`),
  );
  let control = 'not attempted';
  try {
    await P.core.loadEmbedder();
    control = 'FAIL: the embedder loaded, so the guard is not active';
  } catch (err) {
    control = `PASS: loadEmbedder() was refused (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
  }
  out.push(
    `control (must be refused): calling loadEmbedder() in this process -> ${control}`,
    `native addons loaded in this process: ${dlopened.map((f) => f.split('/').slice(-1)[0]).join(', ') || 'none'}`,
  );
  handle.close();
  console.log(out.join('\n'));
}

await (PHASE === 'no-embedder' ? noEmbedder() : main());
