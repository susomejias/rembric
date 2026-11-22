// After retirements made through the helper, the drain's retired-endpoint branch has nothing left to do (task 7.3).
// Two copies of one synthetic corpus start identical: the drain first runs to exhaustion on both, so no older
// retired-endpoint row is left. Each copy then retires the same memories, each carrying fresh pending judgments:
//   - helper:  through every public retirement path (the code under test);
//   - control: through the repository-level status flips those paths make, without the helper (the old behaviour).
// Then the drain runs to exhaustion again. The runner gets no vector index (rules drains stay off), no decay and no
// deadline, so the only thing that can orphan a row is the retired-endpoint drain.
// Run after retirement-cost.mts has cached its corpora:
//   RETIRE_SCRATCH=<same dir> TMPDIR=$RETIRE_SCRATCH pnpm --filter @rembric/core exec tsx ../../openspec/changes/orphan-pendings-on-retirement/measurements/drain-after-retirement.mts [size]
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.RETIRE_SCRATCH;
if (!SCRATCH)
  throw new Error('set RETIRE_SCRATCH to the directory retirement-cost.mts built its corpora in');
const SIZE = Number(process.argv[2] ?? 20_000);
const PER_PATH = 20;
const K = 3;
const CENTURY = 100 * 365 * 86_400_000;

const ROOT = new URL('../../../../', import.meta.url);
const repoFile = (rel: string) => import(new URL(rel, ROOT).href);
const db = await repoFile('packages/db/src/index.ts');
const core = await repoFile('packages/core/src/index.ts');

type World = 'helper' | 'control';

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

function runWorld(world: World) {
  const dir = join(SCRATCH!, `drain-after-${world}-${SIZE}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(SCRATCH!, `vol-${SIZE}`, 'data.db'), join(dir, 'data.db'));
  const handle = db.createDb({
    dataDir: dir,
    onMigrationProgress: () => {},
    onStartupLog: () => {},
  });
  try {
    const repos = db.createRepositories(handle.db);
    const memory = new core.MemoryService(repos, handle.db);
    const relations = new core.RelationsService(repos, handle.db);
    const runner = new core.ConsolidationRunner({
      repos,
      tx: handle.db,
      relations,
      projects: new core.ProjectsService(repos),
      agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
      decay: { thresholdByType: {}, defaultThresholdMs: CENTURY, confidenceFloor: 0 },
      orphanDeadlineMs: CENTURY,
      drainClock: () => 0,
    });
    // VERIFICATION READ: pending rows per project, to know when every project's cursor has wrapped.
    const pendingByProject = () =>
      new Map(
        (
          handle.raw
            .prepare(
              `SELECT m.project_id AS projectId, count(*) AS n FROM memory_relations r JOIN memory m ON m.id = r.source_id
                WHERE r.status = 'pending' GROUP BY m.project_id`,
            )
            .all() as { projectId: string; n: number }[]
        ).map((r) => [r.projectId, r.n]),
      );
    const drainToExhaustion = () => {
      let retired = 0;
      let calls = 0;
      let sinceDrain = new Map<string, number>();
      for (;;) {
        const summary = runner.runAll({ force: true });
        calls += 1;
        for (const r of summary.runs as {
          scope: { projectId: string };
          drain: { examined: number; drainedRetired: number };
        }[]) {
          retired += r.drain.drainedRetired;
          if (r.drain.drainedRetired > 0) sinceDrain = new Map();
          else
            sinceDrain.set(
              r.scope.projectId,
              (sinceDrain.get(r.scope.projectId) ?? 0) + r.drain.examined,
            );
        }
        const wrapped = [...pendingByProject()].every(([id, n]) => (sinceDrain.get(id) ?? 0) >= n);
        if (wrapped) return { retired, calls };
      }
    };
    // VERIFICATION READ: pending rows with a superseded or archived endpoint.
    const pendingOnRetired = () =>
      (
        handle.raw
          .prepare(
            `SELECT count(*) AS n FROM memory_relations r JOIN memory s ON s.id = r.source_id JOIN memory t ON t.id = r.target_id
              WHERE r.status = 'pending' AND (s.status <> 'active' OR t.status <> 'active')`,
          )
          .get() as { n: number }
      ).n;

    const cleared = drainToExhaustion();
    const leftBefore = pendingOnRetired();

    const project = handle.raw.prepare(`SELECT id FROM projects WHERE slug = 'vol-0'`).get() as {
      id: string;
    };
    const scope = db.projectScope(project.id);
    const rng = mulberry32(SIZE);
    const pick = (rows: { id: string; type: string; topicKey: string | null }[]) => {
      const out = [...rows];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    // VERIFICATION READ: the project's active memories, the same in both copies.
    const active = handle.raw
      .prepare(
        `SELECT id, type, topic_key AS topicKey FROM memory WHERE project_id = ? AND status = 'active' ORDER BY id`,
      )
      .all(project.id) as { id: string; type: string; topicKey: string | null }[];
    const keyed = pick(active.filter((r) => r.topicKey !== null));
    const plain = pick(active.filter((r) => r.topicKey === null));
    const partners = plain.splice(0, 30).map((r) => r.id);
    let p = 0;
    const partner = () => partners[p++ % partners.length]!;
    const attach = (id: string) => {
      for (let i = 0; i < K; i += 1) {
        const other = partner();
        relations.createPending(
          i % 2 === 0 ? { sourceId: id, targetId: other } : { sourceId: other, targetId: id },
        );
      }
    };
    const runId = `drain-after-${world}`;
    repos.consolidation.insertRun({
      id: runId,
      startedAt: new Date(),
      scope: `project:${project.id}`,
    });
    const helper = world === 'helper';
    let retirements = 0;

    for (let i = 0; i < PER_PATH; i += 1) {
      const k = keyed.shift()!;
      attach(k.id);
      if (helper) {
        memory.saveWithTopicKey(
          { type: k.type, title: `revision ${i}`, content: `revision ${i}`, topicKey: k.topicKey },
          scope,
        );
      } else repos.memory.markSuperseded(k.id);

      for (const via of ['judge', 'compare'] as const) {
        const t = plain.shift()!.id;
        attach(t);
        const s = partner();
        if (!helper) repos.memory.markSuperseded(t);
        else if (via === 'judge') {
          const v = relations.createPending({ sourceId: s, targetId: t });
          relations.judge(v.judgmentId, {
            relation: 'supersedes',
            actor: 'drain-after',
            kind: 'agent',
          });
        } else {
          relations.compareInScope(
            {
              sourceId: s,
              targetId: t,
              relation: 'supersedes',
              confidence: 1,
              actor: 'drain-after',
            },
            scope,
          );
        }
      }

      const a = plain.shift()!.id;
      const b = plain.shift()!.id;
      attach(a);
      attach(b);
      if (helper) {
        const input = {
          ids: [a, b],
          type: 'project',
          title: `merge ${i}`,
          content: `merge ${i}`,
          tags: [],
        };
        const { fingerprint } = memory.previewMerge(input, scope);
        const { memory: successor, opId } = memory.commitMerge(input, scope, fingerprint);
        attach(successor.id);
        core.undoOp(repos, handle.db, opId);
      } else {
        repos.memory.markSupersededMany([a, b]);
        const stand = plain.shift()!.id;
        attach(stand);
        repos.memory.archiveOne(stand);
      }

      const m = plain.shift()!.id;
      attach(m);
      if (helper) memory.archive(m, scope);
      else repos.memory.markArchived(m, new Date());

      const d = plain.shift()!.id;
      attach(d);
      if (helper) core.applyDecay(repos, handle.db, { runId, ids: [d], reasoning: 'drain-after' });
      else repos.memory.archiveActive([d]);
      retirements += 7;
    }

    const leftAfter = pendingOnRetired();
    const drained = drainToExhaustion();
    return { cleared, leftBefore, retirements, leftAfter, drained };
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  `# drain after retirement — corpus vol-${SIZE}, ${PER_PATH} rounds of every path, ${K} fresh pending judgments per retired memory`,
);
console.log(
  '# helper = public retirement paths; control = the same memories retired by repository-level flips, without the helper',
);
console.log(
  '| copy | retired-endpoint drains to clear older rows (calls) | retired-endpoint pending before | retirement calls | retired-endpoint pending after | retired-endpoint drains after (calls) |',
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
const results: Record<World, ReturnType<typeof runWorld>> = {
  helper: runWorld('helper'),
  control: runWorld('control'),
};
for (const world of ['helper', 'control'] as const) {
  const r = results[world];
  console.log(
    `| ${world} | ${r.cleared.retired} (${r.cleared.calls}) | ${r.leftBefore} | ${r.retirements} | ${r.leftAfter} | ${r.drained.retired} (${r.drained.calls}) |`,
  );
}
const pass =
  results.helper.leftAfter === 0 &&
  results.helper.drained.retired === 0 &&
  results.control.drained.retired > 0 &&
  results.control.drained.retired === results.control.leftAfter;
console.log(
  `# ${pass ? 'PASS' : 'FAIL'}: the helper copy leaves the drain nothing; the control copy leaves it every row its flips stranded`,
);
if (!pass) process.exitCode = 1;
