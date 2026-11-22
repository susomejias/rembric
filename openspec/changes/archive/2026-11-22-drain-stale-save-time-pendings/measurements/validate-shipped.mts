// Re-runs the prototype's fixture, corpus, undo and no-inference validations against the SHIPPED drain:
// ConsolidationRunner.runScope with decay and deadline orphaning neutralized, so only the drain step writes.
// Instrument: pending rows and the drain outcome per pair (not a timing).
// Run: DRAIN_SCRATCH=$(mktemp -d) TMPDIR=$DRAIN_SCRATCH pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/validate-shipped.mts fixture|corpus|no-embedder
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';

const SCRATCH = process.env.DRAIN_SCRATCH;
if (!SCRATCH) throw new Error('set DRAIN_SCRATCH to a mktemp -d directory outside the workspace');
const PHASE = process.argv[2] ?? 'fixture';

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
const { db, core } = P;

const CENTURY_MS = 100 * 365 * 86_400_000;
const NO_DECAY = { thresholdByType: {}, defaultThresholdMs: CENTURY_MS, confidenceFloor: 0 };
const SNAPSHOT_DIR = join(SCRATCH, 'shipped-fixture-snapshot');
const OUTCOMES_JSON = join(SCRATCH, 'shipped-fixture-outcomes.json');

interface Pair {
  judgmentId: string;
  sourceId: string;
  targetId: string;
}

interface Outcome extends Pair {
  disposition: string;
  reason: string;
  evaluation: any;
  status: string;
  prefix: string | null;
}

function shippedRunner(handle: any, repos: any = db.createRepositories(handle.db)): any {
  return new core.ConsolidationRunner({
    repos,
    tx: handle.db,
    relations: new core.RelationsService(repos, handle.db),
    projects: new core.ProjectsService(repos),
    agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
    decay: NO_DECAY,
    orphanDeadlineMs: CENTURY_MS,
    vectorIndexCurrent: () => true,
  });
}

function reasonOf(e: any, disposition: string): string {
  if (disposition === 'keep_admitted') {
    return ['lexical', 'vector', 'entity'].find((c) => e[c] === 'admitted')!;
  }
  if (disposition === 'keep_unknown') {
    if (e.kind !== 'channels') return `unknown:${e.kind}`;
    return `unknown:${['vector', 'entity', 'lexical'].find((c) => e[c] === 'unknown')}`;
  }
  return disposition;
}

/** Runs the shipped step until every pair pending at the start has been examined once. */
function drainPass(handle: any, projectId: string): { outcomes: Outcome[]; runs: any[] } {
  const repos = db.createRepositories(handle.db);
  const before: Pair[] = P.pendingPairs(handle, projectId);
  const predicted = new Map(
    before.map((p) => {
      const evaluation = core.evaluatePair(repos, projectId, p.sourceId, p.targetId, {
        vectorIndexCurrent: true,
      });
      return [p.judgmentId, { evaluation, disposition: core.drainDisposition(evaluation) }];
    }),
  );
  const runner = shippedRunner(handle, repos);
  const runs: any[] = [];
  let examined = 0;
  while (examined < before.length) {
    const r = runner.runScope({ projectId });
    runs.push(r.drain);
    examined += r.drain.examined;
    if (r.drain.examined === 0) break;
  }
  // VERIFICATION READS (raw, read-only)
  const status = handle.raw.prepare('SELECT status FROM memory_relations WHERE judgment_id = ?');
  const op = handle.raw.prepare(
    `SELECT reasoning FROM consolidation_ops WHERE op_type = 'orphan_promote' AND created_id = ? AND reverted_at IS NULL`,
  );
  const outcomes = before.map((p) => {
    const { evaluation, disposition } = predicted.get(p.judgmentId)!;
    const reasoning = op.get(p.judgmentId)?.reasoning as string | undefined;
    return {
      ...p,
      evaluation,
      disposition,
      reason: reasonOf(evaluation, disposition),
      status: status.get(p.judgmentId).status,
      prefix: reasoning === undefined ? null : reasoning.split(':')[1]!.trim(),
    };
  });
  return { outcomes, runs };
}

function mechanicsMismatches(outcomes: Outcome[]): string[] {
  const out: string[] = [];
  for (const o of outcomes) {
    const want =
      o.disposition === 'drain_rules'
        ? ['orphaned', P.STALE_PREFIX]
        : o.disposition === 'drain_retired'
          ? ['orphaned', P.RETIRED_PREFIX]
          : ['pending', null];
    if (o.status !== want[0] || o.prefix !== want[1]) {
      out.push(`${o.judgmentId}: ${o.disposition} but relation ${o.status}, op ${o.prefix}`);
    }
  }
  return out;
}

/** The prototype's independent recomputation (verifyDrain) over the shipped outcome. */
function independent(handle: any, projectId: string, outcomes: Outcome[]): any {
  const decisions = new Map(
    outcomes.map((o) => [
      o.judgmentId,
      {
        ...o,
        verdict: o.status === 'orphaned' ? 'drained' : 'kept',
        reason: o.disposition === 'drain_retired' ? 'drained:retired' : 'drained:stale',
        check: {
          lexical: o.evaluation.kind === 'channels' ? o.evaluation.lexicalSimilarity : null,
          vector: o.evaluation.kind === 'channels' ? o.evaluation.vectorSimilarity : null,
          shared: null,
        },
      },
    ]),
  );
  return P.verifyDrain(handle, projectId, outcomes, decisions);
}

function tally(outcomes: Outcome[]): string {
  const drained = outcomes.filter((o) => o.status === 'orphaned');
  const kept = outcomes.filter((o) => o.status === 'pending');
  const reasons = new Map<string, number>();
  for (const o of kept) reasons.set(o.reason, (reasons.get(o.reason) ?? 0) + 1);
  return [
    `drained: ${drained.length} (rules ${drained.filter((o) => o.disposition === 'drain_rules').length}, retired endpoint ${drained.filter((o) => o.disposition === 'drain_retired').length})`,
    `kept: ${kept.length} (by first admitting channel or unknown reason: ${
      [...reasons]
        .sort()
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    })`,
  ].join('\n');
}

async function fixture(): Promise<void> {
  const { SAVE_TIME_BASE, SAVE_TIME_SAVES } = await import(
    new URL('packages/core/src/test-support/retrieval/save-time-fixture.ts', P.ROOT).href
  );
  const kindOf = new Map<string, string>([
    ...SAVE_TIME_BASE.map((b: any) => [b.id, 'base'] as const),
    ...SAVE_TIME_SAVES.map((s: any) => [s.id, s.class] as const),
  ]);
  const expects = new Map<string, string>(
    SAVE_TIME_SAVES.filter((s: any) => s.expects).map((s: any) => [s.id, s.expects]),
  );

  async function build(dir: string, embedder: any, floor: number) {
    mkdirSync(dir, { recursive: true });
    const handle = P.openDb(dir);
    const repos = db.createRepositories(handle.db);
    const project = new core.ProjectsService(repos).create({ slug: 'save-time' });
    const scope = db.projectScope(project.id);
    const clock = new P.TestClock();
    const memory = new core.MemoryService(repos, handle.db, clock.now);
    const relations = new core.RelationsService(repos, handle.db, clock.now);
    const worker = embedder ? new core.EmbeddingWorker({ repos, embedder }) : null;
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
    const fixtureId = new Map<string, string>();
    for (const item of [...SAVE_TIME_BASE, ...SAVE_TIME_SAVES]) {
      clock.set(new Date(clock.now().getTime() + 60_000));
      const { memory: saved } = memory.saveWithTopicKey(
        { type: item.type, title: item.title, content: item.content },
        scope,
      );
      fixtureId.set(saved.id, item.id);
      await core.runPostSaveSteps(deps, saved, scope);
    }
    return { handle, repos, projectId: project.id, fixtureId };
  }

  const out: string[] = [
    '# stale pending drain — SHIPPED step on the labelled save-time fixture',
    `fixture: ${SAVE_TIME_BASE.length} base memories, ${SAVE_TIME_SAVES.length} labelled saves; saved through runPostSaveSteps with lexicalFloor 0 (pre-floor behaviour), per-save cap 5`,
    'drain: ConsolidationRunner.runScope, run until every pending pair was examined once; decay and deadline orphaning neutralized (no threshold reached), vectorIndexCurrent true, the shipped DRAIN_ROW_CAP, DRAIN_BUDGET_MS and wall clock',
    `per-pair reasons: core.evaluatePair + core.drainDisposition, the functions the step calls; scratch root ${SCRATCH}`,
    '',
  ];
  const embedder = P.memoized(await core.loadEmbedder());
  out.push(`embedding model: ${embedder.modelId}`, '');

  const prod = await build(join(SCRATCH, 'shipped-fixture-f000'), embedder, 0);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  await prod.handle.raw.backup(join(SNAPSHOT_DIR, 'data.db'));
  const pass = drainPass(prod.handle, prod.projectId);
  const outcomes = pass.outcomes;
  writeFileSync(
    OUTCOMES_JSON,
    JSON.stringify(
      Object.fromEntries(outcomes.map((o) => [o.judgmentId, `${o.status}|${o.prefix}`])),
    ),
  );
  const key = (o: Pair) => `${prod.fixtureId.get(o.sourceId)} -> ${prod.fixtureId.get(o.targetId)}`;
  out.push(
    '## validation 1 — production arm (real embedder)',
    `pendings before: ${outcomes.length}`,
    `runs in the pass: ${pass.runs.length} (${pass.runs.map((r) => `${r.examined}/${r.drainedRules + r.drainedRetired}`).join(' ')} examined/drained)`,
    tally(outcomes),
    `mechanics: relation status and journal prefix match the predicted disposition for every pair — mismatches ${mechanicsMismatches(outcomes).length}`,
    '',
    'by pair class (source kind -> target kind): pending / drained / kept',
  );
  const classes = new Map<string, number[]>();
  for (const o of outcomes) {
    const k = `${kindOf.get(prod.fixtureId.get(o.sourceId)!)} -> ${kindOf.get(prod.fixtureId.get(o.targetId)!)}`;
    const e = classes.get(k) ?? [0, 0, 0];
    e[0]! += 1;
    if (o.status === 'orphaned') e[1]! += 1;
    else e[2]! += 1;
    classes.set(k, e);
  }
  for (const [k, e] of [...classes].sort()) {
    out.push(`  ${k.padEnd(40)} ${e.map((n) => P.pad(n, 4)).join(' ')}`);
  }
  const labelled = outcomes.filter(
    (o) => expects.get(prod.fixtureId.get(o.sourceId)!) === prod.fixtureId.get(o.targetId),
  );
  const falseDrains = labelled.filter((o) => o.status !== 'pending');
  out.push(
    '',
    `labelled pairs (save -> its expected base item) pending before the drain: ${labelled.length} of ${expects.size}`,
    `FALSE DRAINS (a labelled pair not kept): ${falseDrains.length}`,
    ...labelled.map((o) => `  ${o.status.padEnd(8)} ${key(o).padEnd(34)} ${o.reason}`),
  );
  const v = independent(prod.handle, prod.projectId, outcomes);
  out.push(
    '',
    '### independent recomputation (the prototype verifyDrain: own tokenizer, float64 cosine, raw entity links, fresh extraction)',
    `pairs checked ${v.pairs}; recomputed rules drain ${v.expectedDrained}, retired drain ${v.expectedRetired}, keep ${v.expectedKept}; mismatches ${v.mismatches.length}; max cosine delta ${v.maxVectorDelta.toExponential(1)}; pairs within 1e-4 of the vector threshold ${v.nearVectorThreshold}`,
    ...v.mismatches.slice(0, 10).map((m: string) => `  MISMATCH ${m}`),
  );

  const f060 = await build(join(SCRATCH, 'shipped-fixture-f060'), embedder, P.LEXICAL_FLOOR);
  const written = new Set(
    P.pendingPairs(f060.handle, f060.projectId).map(
      (p: Pair) => `${f060.fixtureId.get(p.sourceId)} -> ${f060.fixtureId.get(p.targetId)}`,
    ),
  );
  const keptKeys = new Set(outcomes.filter((o) => o.status === 'pending').map(key));
  out.push(
    '',
    '### superset check against the shipped floor (same fixture saved at lexicalFloor 0.60)',
    `pending pairs written at 0.60: ${written.size}; kept by the drain: ${keptKeys.size}; written at 0.60 but NOT kept: ${[...written].filter((k) => !keptKeys.has(k)).length}; kept but not written at 0.60: ${[...keptKeys].filter((k) => !written.has(k)).length}`,
  );
  f060.handle.close();

  const drainedIds = outcomes.filter((o) => o.status === 'orphaned').map((o) => o.judgmentId);
  const runIds = prod.handle.raw
    .prepare(
      `SELECT DISTINCT run_id AS id FROM consolidation_ops WHERE op_type = 'orphan_promote' ORDER BY run_id`,
    )
    .all()
    .map((r: any) => r.id);
  let reverted = 0;
  let kept = 0;
  const [first, ...rest] = runIds;
  for (const op of first ? prod.repos.consolidation.listActiveOps(first) : []) {
    const r = core.undoOp(prod.repos, prod.handle.db, op.id);
    reverted += 1;
    kept += r.keptVerdicts.length;
  }
  for (const id of [...rest].reverse()) {
    const r = core.undoRun(prod.repos, prod.handle.db, id);
    reverted += r.reverted.length;
    kept += r.keptVerdicts.length;
  }
  const row = prod.handle.raw.prepare(
    'SELECT status, relation, reason, marked_by_kind AS kind, judged_at AS at FROM memory_relations WHERE judgment_id = ?',
  );
  const clean = drainedIds.filter((id) => {
    const r = row.get(id);
    return (
      r.status === 'pending' &&
      r.relation === null &&
      r.reason === null &&
      r.kind === null &&
      r.at === null
    );
  });
  const after = drainPass(prod.handle, prod.projectId);
  out.push(
    '',
    "### undo through the dashboard's service path (first run op by op with undoOp, the rest with undoRun)",
    `ops reverted ${reverted} (expected ${drainedIds.length}); kept verdicts reported ${kept}`,
    `drained rows back to a clean pending state: ${clean.length}/${drainedIds.length}`,
    `the next shipped run after the undo examines ${after.runs[0]?.examined ?? 0} pairs, the never-drained ones (undo is final for the drain: undone rows are excluded inside the selection); drained over the next ${after.runs.length} runs: ${after.outcomes.filter((o) => o.status === 'orphaned').length}`,
  );
  prod.handle.close();

  const lex = await build(join(SCRATCH, 'shipped-fixture-lex'), null, 0);
  const lexPass = drainPass(lex.handle, lex.projectId);
  out.push(
    '',
    '## validation 1 — lexical-only arm (no embedder, so no stored vectors)',
    `pendings before: ${lexPass.outcomes.length}`,
    tally(lexPass.outcomes),
    `mechanics mismatches ${mechanicsMismatches(lexPass.outcomes).length}`,
  );
  lex.handle.close();
  console.log(out.join('\n'));
}

async function corpus(): Promise<void> {
  const { CORPUS, PROJECTS } = await import(
    new URL('packages/core/src/test-support/retrieval/corpus.ts', P.ROOT).href
  );
  const { ingestCorpus } = await import(
    new URL('packages/core/src/test-support/retrieval/ingest.ts', P.ROOT).href
  );
  const embedder = P.memoized(await core.loadEmbedder());
  const out: string[] = [
    '# stale pending drain — SHIPPED step on the retrieval corpus (production arm)',
    `corpus: ${CORPUS.length} memories in ${PROJECTS.length} projects, ingested through runPostSaveSteps (ingestCorpus) at lexicalFloor 0, per-save cap 5; embedding model ${embedder.modelId}`,
    'drain: ConsolidationRunner.runScope per project until every pending pair was examined once; decay and deadline orphaning neutralized, vectorIndexCurrent true, shipped bounds',
    '',
  ];
  const stable = (ingested: any) => {
    const m = new Map<string, string>();
    for (const [s, id] of ingested.idByStableId) m.set(id, s);
    return m;
  };
  const c0 = await ingestCorpus(CORPUS, embedder, { lexicalFloor: 0 });
  const h0 = P.openDb(c0.dataDir);
  const s0 = stable(c0);
  const all: (Outcome & { slug: string })[] = [];
  for (const [slug, projectId] of c0.projectIdBySlug) {
    const pass = drainPass(h0, projectId);
    const v = independent(h0, projectId, pass.outcomes);
    all.push(...pass.outcomes.map((o) => ({ ...o, slug })));
    out.push(
      `  scope ${slug.padEnd(8)} pending ${P.pad(pass.outcomes.length, 4)}  runs ${pass.runs.length}  drained ${P.pad(pass.outcomes.filter((o) => o.status === 'orphaned').length, 4)}  kept ${P.pad(pass.outcomes.filter((o) => o.status === 'pending').length, 4)}  | mechanics mismatches ${mechanicsMismatches(pass.outcomes).length} | independent recomputation: rules ${v.expectedDrained} retired ${v.expectedRetired} keep ${v.expectedKept}, mismatches ${v.mismatches.length}`,
      ...v.mismatches.slice(0, 10).map((m: string) => `    MISMATCH ${m}`),
    );
  }
  out.push(`pending after ingest at 0.00: ${all.length}`, tally(all), '');
  const c6 = await ingestCorpus(CORPUS, embedder, { lexicalFloor: P.LEXICAL_FLOOR });
  const h6 = P.openDb(c6.dataDir);
  const s6 = stable(c6);
  const written = new Set<string>();
  for (const projectId of c6.projectIdBySlug.values()) {
    for (const p of P.pendingPairs(h6, projectId) as Pair[]) {
      written.add(`${s6.get(p.sourceId)} -> ${s6.get(p.targetId)}`);
    }
  }
  const key = (o: Pair) => `${s0.get(o.sourceId)} -> ${s0.get(o.targetId)}`;
  const keptKeys = new Set(all.filter((o) => o.status === 'pending').map(key));
  out.push(
    '## kept set against the pendings ingest writes at the shipped floor (0.60)',
    `pending written at 0.60: ${written.size}; kept by the drain: ${keptKeys.size}; written at 0.60 but NOT kept: ${[...written].filter((k) => !keptKeys.has(k)).length}; kept but not written at 0.60: ${[...keptKeys].filter((k) => !written.has(k)).length}`,
    '',
    'drained as endpoint retired:',
    ...all
      .filter((o) => o.disposition === 'drain_retired')
      .map(
        (o) =>
          `  ${o.slug.padEnd(7)} ${key(o).padEnd(58)} source ${o.evaluation.sourceStatus}, target ${o.evaluation.targetStatus}`,
      ),
  );
  h6.close();
  c6.cleanup();
  h0.close();
  c0.cleanup();
  console.log(out.join('\n'));
}

async function noEmbedder(): Promise<void> {
  const expected: Record<string, string> = JSON.parse(readFileSync(OUTCOMES_JSON, 'utf8'));
  const handle = P.openDb(SNAPSHOT_DIR);
  const repos = db.createRepositories(handle.db);
  const projectId = repos.projects.findBySlug('save-time').id;
  // VERIFICATION READ (raw, read-only)
  const vecCount = () => handle.raw.prepare('SELECT count(*) AS n FROM memory_vec').get().n;
  const vecBefore = vecCount();
  const pass = drainPass(handle, projectId);
  const got = Object.fromEntries(
    pass.outcomes.map((o) => [o.judgmentId, `${o.status}|${o.prefix}`]),
  );
  const keys = new Set([...Object.keys(expected), ...Object.keys(got)]);
  const diffs = [...keys].filter((k) => expected[k] !== got[k]);
  let control = 'not attempted';
  try {
    await core.loadEmbedder();
    control = 'FAIL: the embedder loaded, so the guard is not active';
  } catch (err) {
    control = `PASS: loadEmbedder() was refused (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
  }
  console.log(
    [
      '# stale pending drain — SHIPPED step with no model inference (fresh process, model runtime import blocked)',
      `snapshot: the production-arm fixture database copied before its drain (${SNAPSHOT_DIR})`,
      '',
      `outcomes: ${Object.keys(got).length} in this process, ${Object.keys(expected).length} in the embedder-loaded process; differing: ${diffs.length}`,
      tally(pass.outcomes),
      `memory_vec rows ${vecBefore} -> ${vecCount()}`,
      `control (must be refused): calling loadEmbedder() in this process -> ${control}`,
      `native addons loaded in this process: ${dlopened.map((f) => f.split('/').slice(-1)[0]).join(', ') || 'none'}`,
    ].join('\n'),
  );
  handle.close();
}

await (PHASE === 'corpus' ? corpus() : PHASE === 'no-embedder' ? noEmbedder() : fixture());
