/**
 * Fixture builder for the `retire-the-global-scope` scale measurements.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/retire-the-global-scope/measurements/scale-fixture.mjs \
 *     --dir <fixtureDir> --global N [--project M] [--seed S]
 *
 * `seed-volumetric.ts` cannot be reused as-is: its `buildCorpus` hardcodes
 * `scopeSlot = i % 6`, so global rows are always exactly one sixth of the corpus
 * (`VOLUMETRIC_SHAPE.scopeCount`). The worst case this change has to survive is
 * the opposite shape — an operator who only ever used path-less `/mcp`, so
 * *everything* is global. This builder therefore re-implements the memories
 * phase with an explicit global/project split while importing the SAME
 * generators (`generateMemory`, `generateVector`), the SAME entity extractor and
 * the SAME services, so every derived structure (memory_fts, memory_vec,
 * memory_entities, memory_entity_links, confirmations) is trigger/service-built
 * exactly as in production.
 *
 * CAVEAT inherited verbatim from seed-volumetric: the vectors are deterministic
 * pseudo-random unit vectors, NOT embeddings. No retrieval-QUALITY claim may be
 * drawn from a corpus this builds. The claims here are about row counts, blob
 * identity and wall-clock, none of which depend on vector semantics.
 *
 * `--project M` rows are the non-empty CONTROL population: rows that were
 * already project-scoped before the migration and must be observably untouched
 * by it. A comparison against an empty control proves nothing (CLAUDE.md).
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';

import { refreshStatistics } from '../../../../apps/server/src/db/diagnostics.js';
import { createDb } from '../../../../apps/server/src/db/index.js';
import { createRepositories } from '../../../../apps/server/src/db/repositories/index.js';
import { partitionKeyFor } from '../../../../apps/server/src/db/repositories/scope-clause.js';
import {
  CORPUS_EPOCH_MS,
  generateMemory,
  generateVector,
  VOLUMETRIC_SHAPE,
} from '../../../../apps/server/src/scripts/seed-volumetric.js';
import { AgentSessionsService } from '../../../../apps/server/src/services/agent-sessions.js';
import { extractEntities } from '../../../../apps/server/src/services/entities.js';
import { MemoryService } from '../../../../apps/server/src/services/memory.js';
import { ProjectsService } from '../../../../apps/server/src/services/projects.js';
import { RelationsService } from '../../../../apps/server/src/services/relations.js';
import { SCOPE_GLOBAL, projectScope } from '../../../../apps/server/src/services/scope.js';
import { TokensService } from '../../../../apps/server/src/services/tokens.js';

const BATCH = 500;
const SPAN_MS = 365 * 24 * 60 * 60 * 1000;
/** Control projects. Named `pre-existing-*` so nothing confuses them with the migration's own. */
const CONTROL_PROJECTS = 3;
/** One in this many memories carries a pending relation, so `memory_relations` is populated. */
const RELATION_EVERY = 20;
/** One in this many memories gets a session, so `sessions.project_id IS NULL` is exercised. */
const SESSION_EVERY = 200;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return process.argv[i + 1];
}

const dir = arg('dir');
if (!dir) throw new Error('--dir is required');
if (/(^|\/)(data|data-dev)$/.test(dir)) throw new Error(`refusing to build into ${dir}`);
const globalCount = Number(arg('global', '1000'));
const projectCount = Number(arg('project', String(Math.max(2, Math.round(globalCount / 10)))));
const seed = Number(arg('seed', '1'));

if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const t0 = Date.now();
const handle = createDb({ dataDir: dir });
const repos = createRepositories(handle.db);

let clockMs = CORPUS_EPOCH_MS - SPAN_MS;
const clock = () => new Date(clockMs);
const projectsSvc = new ProjectsService(repos, clock);
const tokensSvc = new TokensService(repos, clock);
const memorySvc = new MemoryService(repos, handle.db, clock);
const sessionsSvc = new AgentSessionsService(repos, handle.db, clock);
const relationsSvc = new RelationsService(repos, handle.db, clock);

const projects = Array.from({ length: CONTROL_PROJECTS }, (_, i) =>
  projectsSvc.create({ slug: `pre-existing-${i}`, displayName: `Pre-existing ${i}` }),
);
const token = tokensSvc.create({ name: 'scale-harness', scope: '*' });

const total = globalCount + projectCount;
const step = SPAN_MS / total;
// One pool per (scope, project_id) tuple: `RelationsService.createPending`
// refuses a cross-scope pair, so a relation must be drawn from within one pool.
const pools = Array.from({ length: 1 + CONTROL_PROJECTS }, () => []);
const sessionIds = [];

for (let start = 0; start < total; start += BATCH) {
  const end = Math.min(start + BATCH, total);
  handle.db.transaction(() => {
    for (let i = start; i < end; i += 1) {
      clockMs = CORPUS_EPOCH_MS - SPAN_MS + Math.round(i * step);
      // Global rows first, then the control population: keeps the two
      // populations contiguous so a per-magnitude assertion can name either.
      const isGlobal = i < globalCount;
      const slot = isGlobal ? 0 : 1 + ((i - globalCount) % projects.length);
      const scope = isGlobal ? SCOPE_GLOBAL : projectScope(projects[slot - 1].id);

      if (i % SESSION_EVERY === 0) {
        const s = sessionsSvc.start({
          tokenId: token.token.id,
          // NULL project_id is the shape migration step 7 repoints.
          projectId: isGlobal ? null : projects[slot - 1].id,
          agent: 'claude-code',
          description: null,
          cwd: `/srv/scale/${i}`,
        });
        sessionIds.push(s.id);
      }

      const gen = generateMemory(seed, i, slot);
      const { memory: row } = memorySvc.saveWithTopicKey(
        {
          type: gen.type,
          title: gen.title,
          content: gen.content,
          tags: gen.tags,
          topicKey: gen.topicKey,
          sessionId:
            sessionIds.length > 0 && i % 3 === 0 ? sessionIds[sessionIds.length - 1] : null,
        },
        scope,
      );
      pools[slot].push(row.id);

      const vector = generateVector(seed, i);
      repos.vectors.insertEmbedding(
        row.id,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        partitionKeyFor(row.scope, row.projectId),
      );
      repos.entities.linkMemory(
        row.id,
        row.scope,
        row.projectId,
        extractEntities(row.title, row.content),
        row.createdAt,
      );
      // `confirmationsPerMemory` ≈ 1.35 in VOLUMETRIC_SHAPE; a deterministic
      // 0/1/2/3 cycle averages 1.5 without a second RNG stream.
      const n = [0, 1, 2, 3][i % 4];
      for (let c = 0; c < n; c += 1) {
        clockMs += 1;
        memorySvc.confirm(row.id, scope, { source: { agent: 'scale-harness' }, sessionId: null });
      }
    }
  });
  refreshStatistics(handle);
  if (end % 10000 === 0 || end === total) {
    process.stderr.write(`[fixture] memories ${end}/${total} ${Date.now() - t0}ms\n`);
  }
}

let relations = 0;
for (const pool of pools) {
  if (pool.length < 2) continue;
  const n = Math.floor(pool.length / RELATION_EVERY);
  for (let start = 0; start < n; start += BATCH) {
    const end = Math.min(start + BATCH, n);
    handle.db.transaction(() => {
      for (let i = start; i < end; i += 1) {
        const a = (i * 7) % pool.length;
        const b = (a + 1 + ((i * 13) % (pool.length - 1))) % pool.length;
        if (a === b) continue;
        const pending = relationsSvc.createPending({
          sourceId: pool[a],
          targetId: pool[b],
          markedByKind: 'system',
        });
        relations += 1;
        // A quarter stay pending; the rest are judged, so both statuses exist.
        if (i % 4 !== 0) {
          relationsSvc.judge(pending.judgmentId, {
            relation: 'duplicate',
            actor: 'scale-harness',
            kind: 'agent',
            confidence: 0.5,
            reason: 'scale fixture',
          });
        }
      }
    });
  }
}

// A pre-migration consolidation run, so step 8's `consolidation_runs` UPDATE has
// a live row to touch and a historical one it must leave alone (D16).
handle.raw
  .prepare(
    'INSERT INTO consolidation_runs (id, started_at, finished_at, scope, summary) VALUES (?,?,?,?,?)',
  )
  .run(
    'scale-run-historical',
    CORPUS_EPOCH_MS - SPAN_MS,
    CORPUS_EPOCH_MS - SPAN_MS + 1000,
    'global',
    '{}',
  );
handle.raw
  .prepare(
    'INSERT INTO consolidation_runs (id, started_at, finished_at, scope, summary) VALUES (?,?,?,?,?)',
  )
  .run('scale-run-live', CORPUS_EPOCH_MS, null, 'global', null);

refreshStatistics(handle);
handle.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const count = (t) => handle.raw.prepare(`SELECT count(*) c FROM ${t}`).get().c;
const report = {
  dir,
  seed,
  elapsedMs: Date.now() - t0,
  vectorCaveat: 'deterministic pseudo-random unit vectors, NOT embeddings',
  embeddingDims: VOLUMETRIC_SHAPE.embeddingDims,
  requested: { globalCount, projectCount },
  rows: {
    memory: count('memory'),
    memoryGlobal: handle.raw.prepare("SELECT count(*) c FROM memory WHERE scope='global'").get().c,
    memoryProject: handle.raw.prepare("SELECT count(*) c FROM memory WHERE scope='project'").get()
      .c,
    memory_vec: count('memory_vec'),
    memory_vec_global: handle.raw
      .prepare("SELECT count(*) c FROM memory_vec WHERE partition_key='__global__'")
      .get().c,
    memory_fts: count('memory_fts'),
    memory_entities: count('memory_entities'),
    memory_entities_global: handle.raw
      .prepare("SELECT count(*) c FROM memory_entities WHERE scope='global'")
      .get().c,
    memory_entity_links: count('memory_entity_links'),
    memory_relations: count('memory_relations'),
    confirmations: count('confirmations'),
    sessions: count('sessions'),
    sessions_null_project: handle.raw
      .prepare('SELECT count(*) c FROM sessions WHERE project_id IS NULL')
      .get().c,
    projects: count('projects'),
    consolidation_runs: count('consolidation_runs'),
  },
  relationsCreated: relations,
};
handle.close();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
