// Cost each retirement path pays for orphaning its pending judgments, at 1 000, 20 000 and 50 000 memories.
// Instrument (the only one in this file): wall clock of ONE call to the path's public entry point — the service method,
// applyDecay or undoOp — measured around that call alone, warm, each call on a distinct memory. Median and p95 of REPS calls.
// The same script runs on the base commit (LABEL=before) and on the change (LABEL=after), against the same cached corpora.
// Run: RETIRE_SCRATCH=$(mktemp -d) TMPDIR=$RETIRE_SCRATCH LABEL=before pnpm --filter @rembric/core exec tsx ../../openspec/changes/orphan-pendings-on-retirement/measurements/retirement-cost.mts [sizes...]
// Env: CORPUS_DIR reuses built corpora; REPS (default 40) caps the measured calls per path after 5 warm-up calls; a small
// corpus lowers it to what its project holds, and the n column says how many were measured.
// Corpora are built by the corpus:build generator with skew, so project vol-0 holds 60% of the memories.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';

const SCRATCH = process.env.RETIRE_SCRATCH;
if (!SCRATCH) throw new Error('set RETIRE_SCRATCH to a mktemp -d directory outside the workspace');
const CORPUS_DIR = process.env.CORPUS_DIR ?? SCRATCH;
const LABEL = process.env.LABEL ?? 'unlabelled';
const REPS = Number(process.env.REPS ?? 40);
const WARMUP = 5;
const KS = [0, 3];

const ROOT = new URL('../../../../', import.meta.url);
const repoFile = (rel: string) => import(new URL(rel, ROOT).href);
const db = await repoFile('packages/db/src/index.ts');
const core = await repoFile('packages/core/src/index.ts');
const { buildCorpus, DEFAULT_ARGS } = await repoFile('apps/web/src/scripts/seed-volumetric.ts');

const SIZES = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
if (SIZES.length === 0) SIZES.push(1_000, 20_000, 50_000);

function openDb(dataDir: string): any {
  return db.createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
}

function corpusDir(size: number): string {
  const dir = join(CORPUS_DIR, `vol-${size}`);
  if (existsSync(join(dir, 'built.ok'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const handle = openDb(dir);
  buildCorpus({
    handle,
    args: { ...DEFAULT_ARGS, dataDir: dir, memories: size, relations: size, skew: true },
    log: () => {},
  });
  handle.close();
  writeFileSync(join(dir, 'built.ok'), 'ok\n');
  return dir;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

interface Row {
  size: number;
  path: string;
  k: number;
  n: number;
  medianMs: number;
  p95Ms: number;
  pendingLeft: number;
}

function runSize(size: number): Row[] {
  const rows: Row[] = [];
  for (const k of KS) {
    const work = join(SCRATCH!, `work-${LABEL}-${size}-${k}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    copyFileSync(join(corpusDir(size), 'data.db'), join(work, 'data.db'));
    const handle = openDb(work);
    try {
      rows.push(...runPaths(handle, size, k));
    } finally {
      handle.close();
      rmSync(work, { recursive: true, force: true });
    }
  }
  return rows;
}

function runPaths(handle: any, size: number, k: number): Row[] {
  const repos = db.createRepositories(handle.db);
  const memory = new core.MemoryService(repos, handle.db);
  const relations = new core.RelationsService(repos, handle.db);
  // VERIFICATION READ: the project and its active memories, straight from the corpus.
  const project = handle.raw.prepare(`SELECT id FROM projects WHERE slug = 'vol-0'`).get() as {
    id: string;
  };
  const scope = db.projectScope(project.id);
  const active = (withTopicKey: boolean) =>
    (
      handle.raw
        .prepare(
          `SELECT id, type, topic_key AS topicKey FROM memory WHERE project_id = ? AND status = 'active' AND topic_key IS ${withTopicKey ? 'NOT NULL' : 'NULL'} ORDER BY id`,
        )
        .all(project.id) as { id: string; type: string; topicKey: string | null }[]
    ).map((r) => r);
  const rng = mulberry32(size * 31 + k);
  // The corpus' own pending rows also touch some retired memories, so k is a lower bound per memory.
  const keyed = shuffle(active(true), rng);
  const plain = shuffle(active(false), rng);
  const PARTNERS = 30;
  const perPath = Math.min(WARMUP + REPS, keyed.length, Math.floor((plain.length - PARTNERS) / 9));
  const partners = plain.splice(0, PARTNERS).map((r) => r.id);
  let partnerAt = 0;
  const partner = () => partners[partnerAt++ % partners.length]!;
  const takePlain = () => {
    const next = plain.shift();
    if (!next) throw new Error(`corpus ${size} ran out of active memories without a topic_key`);
    return next;
  };
  const takeKeyed = () => {
    const next = keyed.shift();
    if (!next) throw new Error(`corpus ${size} ran out of active memories with a topic_key`);
    return next;
  };
  const attach = (id: string) => {
    for (let i = 0; i < k; i += 1) {
      const other = partner();
      relations.createPending(
        i % 2 === 0 ? { sourceId: id, targetId: other } : { sourceId: other, targetId: id },
      );
    }
  };
  // VERIFICATION READ: pending rows still touching the given memories.
  const pendingTouching = (ids: string[]) =>
    (
      handle.raw
        .prepare(
          `SELECT count(*) AS n FROM memory_relations WHERE status = 'pending' AND (source_id IN (SELECT value FROM json_each(?)) OR target_id IN (SELECT value FROM json_each(?)))`,
        )
        .get(JSON.stringify(ids), JSON.stringify(ids)) as { n: number }
    ).n;
  const opIdFor = (opType: string, affectedId: string) =>
    (
      handle.raw
        .prepare(
          `SELECT id FROM consolidation_ops WHERE op_type = ? AND reverted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(affected_ids) WHERE value = ?) ORDER BY id DESC LIMIT 1`,
        )
        .get(opType, affectedId) as { id: string }
    ).id;

  let runSeq = 0;
  // One decay per run, as the sweep does.
  const freshRun = () => {
    const id = `cost-run-${LABEL}-${size}-${k}-${runSeq++}`;
    repos.consolidation.insertRun({ id, startedAt: new Date(), scope: `project:${project.id}` });
    return id;
  };

  const mergeInput = (ids: string[], i: number) => ({
    ids,
    type: 'project',
    title: `cost merge ${i}`,
    content: `cost merge body ${i}`,
    tags: [],
    topicKey: null,
  });

  const paths: { name: string; once: (i: number) => { timed: () => void; retired: string[] } }[] = [
    {
      name: 'topic_key revision (saveWithTopicKey)',
      once: (i) => {
        const t = takeKeyed();
        attach(t.id);
        return {
          retired: [t.id],
          timed: () =>
            memory.saveWithTopicKey(
              {
                type: t.type,
                title: `cost revision ${i}`,
                content: `cost revision body ${i}`,
                topicKey: t.topicKey,
              },
              scope,
            ),
        };
      },
    },
    {
      name: 'supersedes verdict (RelationsService.judge)',
      once: () => {
        const t = takePlain();
        attach(t.id);
        const verdict = relations.createPending({ sourceId: partner(), targetId: t.id });
        return {
          retired: [t.id],
          timed: () =>
            relations.judge(verdict.judgmentId, {
              relation: 'supersedes',
              actor: 'cost',
              kind: 'agent',
            }),
        };
      },
    },
    {
      name: 'memory.archive (MemoryService.archive)',
      once: () => {
        const t = takePlain();
        attach(t.id);
        return { retired: [t.id], timed: () => memory.archive(t.id, scope) };
      },
    },
    {
      name: 'memory.merge commit of 2 (MemoryService.commitMerge)',
      once: (i) => {
        const a = takePlain();
        const b = takePlain();
        attach(a.id);
        attach(b.id);
        const input = mergeInput([a.id, b.id], i);
        const { fingerprint } = memory.previewMerge(input, scope);
        return {
          retired: [a.id, b.id],
          timed: () => memory.commitMerge(input, scope, fingerprint),
        };
      },
    },
    {
      name: 'decay of 1 (applyDecay)',
      once: () => {
        const t = takePlain();
        attach(t.id);
        const runId = freshRun();
        return {
          retired: [t.id],
          timed: () => core.applyDecay(repos, handle.db, { runId, ids: [t.id], reasoning: 'cost' }),
        };
      },
    },
    {
      name: 'undo of memory.archive (undoOp)',
      once: () => {
        const t = takePlain();
        attach(t.id);
        memory.archive(t.id, scope);
        const opId = opIdFor('agent_memory_archive', t.id);
        return { retired: [], timed: () => core.undoOp(repos, handle.db, opId) };
      },
    },
    {
      name: 'undo of decay (undoOp)',
      once: () => {
        const t = takePlain();
        attach(t.id);
        const { opId } = core.applyDecay(repos, handle.db, {
          runId: freshRun(),
          ids: [t.id],
          reasoning: 'cost',
        });
        return { retired: [], timed: () => core.undoOp(repos, handle.db, opId) };
      },
    },
    {
      name: 'undo of merge, successor archived (undoOp)',
      once: (i) => {
        const a = takePlain();
        const b = takePlain();
        attach(a.id);
        attach(b.id);
        const input = mergeInput([a.id, b.id], 10_000 + i);
        const { fingerprint } = memory.previewMerge(input, scope);
        const { memory: successor, opId } = memory.commitMerge(input, scope, fingerprint);
        attach(successor.id);
        return { retired: [successor.id], timed: () => core.undoOp(repos, handle.db, opId) };
      },
    },
  ];

  const rows: Row[] = [];
  for (const path of paths) {
    const samples: number[] = [];
    let pendingLeft = 0;
    for (let i = 0; i < perPath; i += 1) {
      const { timed, retired } = path.once(i);
      const t0 = performance.now();
      timed();
      const dt = performance.now() - t0;
      if (i >= WARMUP) {
        samples.push(dt);
        if (retired.length > 0) pendingLeft += pendingTouching(retired);
      }
    }
    samples.sort((x, y) => x - y);
    rows.push({
      size,
      path: path.name,
      k,
      n: samples.length,
      medianMs: quantile(samples, 0.5),
      p95Ms: quantile(samples, 0.95),
      pendingLeft,
    });
  }
  return rows;
}

const header = [
  `# retirement-path cost — LABEL=${LABEL}`,
  `# instrument: wall clock of one public entry-point call per retirement (warm; ${WARMUP} warm-up calls dropped; REPS=${REPS})`,
  `# k = pending judgments attached to each retired memory before the call; "pending left" = pending rows still touching the retired memories after the measured calls (VERIFICATION READ, undo rows: the archived successor)`,
  `# host: ${cpus()[0]?.model ?? 'unknown'} · ${platform()} ${release()} · node ${process.version}`,
];
console.log(header.join('\n'));
console.log('| memories | path | k | n | median ms | p95 ms | pending left |');
console.log('| ---: | --- | ---: | ---: | ---: | ---: | ---: |');
for (const size of SIZES) {
  for (const r of runSize(size)) {
    console.log(
      `| ${r.size} | ${r.path} | ${r.k} | ${r.n} | ${r.medianMs.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${r.pendingLeft} |`,
    );
  }
}
