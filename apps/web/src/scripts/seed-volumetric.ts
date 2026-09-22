import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { AgentSessionsService } from '@rembric/core';
import { extractEntities } from '@rembric/core';
import { MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { PromptsService } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import { TokensService } from '@rembric/core';
import {
  countTableRows,
  createDb,
  createRepositories,
  MEMORY_TYPES,
  partitionKeyFor,
  projectScope,
  refreshStatistics,
  RELATION_VALUES,
  type DbHandle,
  type MemoryType,
  type Scope,
} from '@rembric/db';

export const SYNTHETIC_VECTOR_CAVEAT =
  'vectors are deterministic pseudo-random unit vectors, NOT embeddings — no retrieval-quality, ranking, fusion or abstention claim may be drawn from this corpus (use `pnpm run eval`)';

export const RESERVED_DIR_NAMES: readonly string[] = ['data', 'data-dev'];
export const RESERVED_ABSOLUTE_DIRS: readonly string[] = ['/data'];

export interface VolumetricArgs {
  dataDir: string;
  memories: number;
  sessions: number;
  relations: number;
  prompts: number;
  seed: number;
  skew: boolean;
}

export const DEFAULT_ARGS = {
  memories: 1000,
  sessions: 0,
  relations: 0,
  prompts: 0,
  seed: 1,
  skew: false,
} as const;

export class UsageError extends Error {}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  return value;
}

function requireCount(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function parseArgs(argv: readonly string[]): VolumetricArgs {
  let dataDir: string | undefined;
  let memories: number = DEFAULT_ARGS.memories;
  let sessions: number = DEFAULT_ARGS.sessions;
  let relations: number = DEFAULT_ARGS.relations;
  let prompts: number = DEFAULT_ARGS.prompts;
  let seed: number = DEFAULT_ARGS.seed;
  let skew: boolean = DEFAULT_ARGS.skew;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    switch (flag) {
      case '--db':
        dataDir = requireValue(flag, argv[(i += 1)]);
        break;
      case '--memories':
        memories = requireCount(flag, requireValue(flag, argv[(i += 1)]));
        break;
      case '--sessions':
        sessions = requireCount(flag, requireValue(flag, argv[(i += 1)]));
        break;
      case '--relations':
        relations = requireCount(flag, requireValue(flag, argv[(i += 1)]));
        break;
      case '--prompts':
        prompts = requireCount(flag, requireValue(flag, argv[(i += 1)]));
        break;
      case '--seed':
        seed = requireCount(flag, requireValue(flag, argv[(i += 1)]));
        break;
      case '--skew':
        skew = true;
        break;
      default:
        throw new UsageError(
          `unknown flag ${JSON.stringify(flag)}. Accepted: --db <dir> --memories N --sessions M --relations R --prompts P --seed S --skew. ` +
            'This harness never deletes, so there is no --reset and no --force: remove the corpus directory yourself.',
        );
    }
  }

  if (dataDir === undefined) throw new UsageError('--db <dir> is required');
  const args = {
    dataDir: normalizeDataDir(dataDir),
    memories,
    sessions,
    relations,
    prompts,
    seed,
    skew,
  };
  assertBuildable(args);
  return args;
}

export function assertBuildable(args: VolumetricArgs): void {
  if (args.relations > 0 && args.memories < MIN_MEMORIES_PER_SCOPE_FOR_RELATIONS) {
    throw new UsageError(
      `--relations ${args.relations} needs --memories at least ${MIN_MEMORIES_PER_SCOPE_FOR_RELATIONS} ` +
        `(a relation joins two memories in the same scope, and the corpus spreads memories over ${VOLUMETRIC_SHAPE.scopeCount} scopes)`,
    );
  }
  if (args.skew) {
    const min = Math.min(...VOLUMETRIC_SHAPE.skewShares);
    const needed = Math.ceil(MIN_MEMORIES_PER_SKEWED_SCOPE / min);
    if (args.memories > 0 && args.memories < needed) {
      throw new UsageError(
        `--skew needs --memories at least ${needed}: the smallest share is ${min}, and a project ` +
          'holding fewer than ' +
          `${MIN_MEMORIES_PER_SKEWED_SCOPE} memories makes a widened-vs-narrow comparison vacuous on that project`,
      );
    }
  }
}

export function normalizeDataDir(dbArg: string): string {
  const abs = resolve(dbArg);
  return basename(abs) === 'data.db' ? resolve(abs, '..') : abs;
}

export function refuseTarget(dataDir: string): string | null {
  const abs = resolve(dataDir);
  if (RESERVED_DIR_NAMES.includes(basename(abs)) || RESERVED_ABSOLUTE_DIRS.includes(abs)) {
    return (
      `refusing to write to ${abs}: this is the dev/prod stack's data directory. ` +
      'Reserved names: ' +
      RESERVED_DIR_NAMES.join(', ') +
      `, plus ${RESERVED_ABSOLUTE_DIRS.join(', ')}. ` +
      'Pick a directory of your own (e.g. ../corpora/50k) — the dev stack reseeds itself on every boot, ' +
      'so an empty data-dev is exactly when a measurement corpus would be lost.'
    );
  }

  const dbFile = resolve(abs, 'data.db');
  if (!existsSync(dbFile)) return null;
  if (!statSync(dbFile).isFile()) return `refusing to write to ${dbFile}: not a regular file`;

  const handle = createDb({ dataDir: abs, readonly: true });
  let memories: number | null;
  try {
    memories = countTableRows(handle, 'memory');
  } finally {
    handle.close();
  }
  if (memories !== null && memories > 0) {
    return (
      `refusing to write to ${dbFile}: it already holds ${memories} memories. ` +
      'This harness never deletes — there is no --reset and no --force. ' +
      'Remove the directory yourself if you meant to rebuild, so the corpus you measure is ' +
      'the corpus the invocation describes and not it plus whatever was already there.'
    );
  }
  return null;
}

export const VOLUMETRIC_SHAPE = {
  scopeCount: 6,
  projectCount: 6,
  skewShares: [0.02, 0.6, 0.2, 0.1, 0.05, 0.03],
  bodyBytesP50: 1300,
  bodyBytesP90: 2600,
  entitiesPerMemory: 18,
  confirmationsPerMemory: 1.35,
  supersededFraction: 0.2,
  sessionsEndedFraction: 0.8,
  memoriesWithSessionFraction: 0.7,
  relationsPendingFraction: 0.25,
  relationsOrphanedFraction: 0.05,
  promptBytesP50: 260,
  promptsDeletedFraction: 0.15,
  embeddingDims: 768,
} as const;

const RELATION_ORPHAN_CUTOFF =
  VOLUMETRIC_SHAPE.relationsPendingFraction + VOLUMETRIC_SHAPE.relationsOrphanedFraction;

const MIN_MEMORIES_PER_SCOPE_FOR_RELATIONS = 2 * VOLUMETRIC_SHAPE.scopeCount;

const MIN_MEMORIES_PER_SKEWED_SCOPE = 10;

const SKEW_BLOCK_LENGTH = 100;

export function interleaveShares(shares: readonly number[], length: number): number[] {
  const assigned = shares.map(() => 0);
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    let best = 0;
    let bestDeficit = -Infinity;
    for (let s = 0; s < shares.length; s += 1) {
      const deficit = shares[s]! * (i + 1) - assigned[s]!;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = s;
      }
    }
    assigned[best]! += 1;
    out.push(best);
  }
  return out;
}

const SKEW_BLOCK = interleaveShares(VOLUMETRIC_SHAPE.skewShares, SKEW_BLOCK_LENGTH);

export function scopeSlotFor(index: number, skew: boolean): number {
  return skew ? SKEW_BLOCK[index % SKEW_BLOCK_LENGTH]! : index % VOLUMETRIC_SHAPE.scopeCount;
}

const JUDGED_VERDICTS = RELATION_VALUES.filter((r) => r !== 'supersedes');

export const CORPUS_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');
const CORPUS_SPAN_MS = 365 * 24 * 60 * 60 * 1000;

const BATCH_SIZE = 500;

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function rngFor(seed: number, stream: number, index: number): () => number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const v of [stream, index]) {
    h = (h ^ Math.imul(v + 0x165667b1, 0x27d4eb2f)) >>> 0;
    h = (Math.imul(h, 0x85ebca6b) ^ (h >>> 13)) >>> 0;
  }
  return splitmix32(h);
}

const STREAM = {
  memory: 1,
  confirmation: 2,
  session: 3,
  vector: 4,
  relation: 5,
  prompt: 6,
  memorySession: 7,
} as const;

function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

// prettier-ignore
const WORDS: readonly string[] = [
  'after', 'against', 'already', 'always', 'annotation', 'append', 'archive', 'because',
  'before', 'behind', 'between', 'boundary', 'branch', 'budget', 'cache', 'candidate',
  'ceiling', 'chain', 'checked', 'client', 'column', 'commit', 'compact', 'confidence',
  'conflict', 'consumer', 'context', 'corpus', 'counter', 'decay', 'decision', 'deferred',
  'derived', 'detector', 'discipline', 'during', 'either', 'enough', 'entity', 'evidence',
  'expected', 'explicit', 'failure', 'filter', 'floor', 'gate', 'growth', 'handler',
  'header', 'hidden', 'however', 'index', 'inline', 'instrument', 'invariant', 'journal',
  'judgment', 'latency', 'layer', 'ledger', 'lifecycle', 'linked', 'listing', 'measured',
  'memory', 'migration', 'mirror', 'monotonic', 'narrow', 'neither', 'nightly', 'nothing',
  'observed', 'offset', 'operator', 'ordering', 'otherwise', 'overhead', 'partition',
  'pending', 'planner', 'pointer', 'prefix', 'previous', 'projection', 'quorum', 'ratio',
  'reader', 'rebuild', 'recipe', 'recorded', 'reduced', 'refused', 'relation', 'replaced',
  'reported', 'request', 'resident', 'restore', 'retained', 'reviewer', 'rollback',
  'sampled', 'scanned', 'schema', 'scoped', 'segment', 'selective', 'sequence', 'session',
  'settled', 'shadow', 'silently', 'single', 'sparse', 'stable', 'statement', 'status',
  'storage', 'stream', 'subject', 'summary', 'surface', 'tenant', 'threshold', 'timeline',
  'together', 'tolerance', 'trailing', 'trigger', 'trusted', 'unbounded', 'unless',
  'upgrade', 'verdict', 'verified', 'version', 'walked', 'whether', 'window', 'without',
  'worker', 'writer',
];

// prettier-ignore
const SHOUT: readonly string[] = [
  'BUSY', 'CANTOPEN', 'CORRUPT', 'FULL', 'LOCKED', 'MISUSE', 'NOTADB', 'PROTOCOL',
  'READONLY', 'SCHEMA', 'TOOBIG', 'CONSTRAINT',
];

// prettier-ignore
const ERRNOS: readonly string[] = [
  'ENOENT', 'EACCES', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ENOSPC', 'EEXIST', 'EINVAL',
];

const TICKET_PREFIXES: readonly string[] = ['RBR', 'OPS', 'PLT', 'SRE', 'DEV', 'INF'];

const AGENTS: readonly string[] = ['claude-code', 'codex-cli', 'hermes', 'opencode', 'pi'];

function hex(rng: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) out += '0123456789abcdef'[Math.floor(rng() * 16)];
  return out;
}

const ENTITY_TOKENS: readonly ((rng: () => number) => string)[] = [
  (r) => `https://${pick(r, WORDS)}-${int(r, 100, 999)}.example.com/repo/pull/${int(r, 1, 9999)}`,
  (r) => `apps/${pick(r, WORDS)}/src/${pick(r, WORDS)}/${pick(r, WORDS)}-${int(r, 10, 99)}.ts`,
  (r) => `.rembric/${pick(r, WORDS)}-${int(r, 10, 99)}.json`,
  (r) => `${pick(r, TICKET_PREFIXES)}-${int(r, 1, 9999)}`,
  (r) => `#${int(r, 1, 9999)}`,
  (r) => `SQLITE_${pick(r, SHOUT)}`,
  (r) => `ERR_${pick(r, SHOUT)}_${int(r, 10, 99)}`,
  (r) => pick(r, ERRNOS),
  (r) => `$REMBRIC_${pick(r, SHOUT)}`,
  (r) => `RBR_${pick(r, SHOUT)}=${int(r, 1, 9)}`,
  (r) =>
    `${hex(r, 8)}-${hex(r, 4)}-${int(r, 1, 8)}${hex(r, 3)}-${pick(r, ['8', '9', 'a', 'b'])}${hex(r, 3)}-${hex(r, 12)}`,
  (r) => `${hex(r, 5)}${int(r, 0, 9)}${pick(r, ['a', 'b', 'c', 'd', 'e', 'f'])}${hex(r, 5)}`,
  (r) => `CVE-20${int(r, 10, 26)}-${int(r, 1000, 99999)}`,
  (r) => `10.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}`,
  (r) => `${pick(r, WORDS)}-${pick(r, WORDS)}-${int(r, 1, 9)}.service`,
  (r) => Array.from({ length: 6 }, () => hex(r, 2)).join(':'),
  (r) => `${pick(r, WORDS)}-${int(r, 10, 99)}.local`,
];

const LENGTH_BUCKETS: readonly { lo: number; hi: number; p: number }[] = [
  { lo: 0.5, hi: 1.0, p: 0.5 },
  { lo: 1.0, hi: 1.7, p: 0.35 },
  { lo: 1.7, hi: 2.5, p: 0.12 },
  { lo: 2.5, hi: 5.0, p: 0.03 },
];

function targetBodyBytes(rng: () => number): number {
  const u = rng();
  let acc = 0;
  for (const b of LENGTH_BUCKETS) {
    acc += b.p;
    if (u < acc) return Math.round(VOLUMETRIC_SHAPE.bodyBytesP50 * (b.lo + rng() * (b.hi - b.lo)));
  }
  return VOLUMETRIC_SHAPE.bodyBytesP50;
}

const CONFIRMATION_BUCKETS: readonly { n: number; p: number }[] = [
  { n: 0, p: 0.36 },
  { n: 1, p: 0.25 },
  { n: 2, p: 0.2 },
  { n: 3, p: 0.12 },
  { n: 5, p: 0.07 },
];

function confirmationCount(rng: () => number): number {
  const u = rng();
  let acc = 0;
  for (const b of CONFIRMATION_BUCKETS) {
    acc += b.p;
    if (u < acc) return b.n;
  }
  return 0;
}

export interface GeneratedMemory {
  title: string;
  content: string;
  type: MemoryType;
  topicKey: string | null;
  tags: string[];
}

export function generateMemory(
  seed: number,
  index: number,
  scopeSlot: number,
  slotOrdinal: number = Math.floor(index / VOLUMETRIC_SHAPE.scopeCount),
): GeneratedMemory {
  const rng = rngFor(seed, STREAM.memory, index);

  const tokens: string[] = [];
  for (let i = 0; i < VOLUMETRIC_SHAPE.entitiesPerMemory; i += 1) {
    tokens.push(ENTITY_TOKENS[i % ENTITY_TOKENS.length]!(rng));
  }

  const target = targetBodyBytes(rng);
  const tokenBytes = tokens.reduce((n, t) => n + t.length + 1, 0);
  const proseBytes = Math.max(120, target - tokenBytes);

  const prose: string[] = [];
  let bytes = 0;
  let sinceStop = 0;
  while (bytes < proseBytes) {
    const word = pick(rng, WORDS);
    sinceStop += 1;
    const stop = sinceStop >= int(rng, 8, 14);
    prose.push(stop ? `${word}.` : word);
    if (stop) sinceStop = 0;
    bytes += word.length + 1 + (stop ? 1 : 0);
  }

  const stride = Math.max(1, Math.floor(prose.length / (tokens.length + 1)));
  const parts: string[] = [];
  let ti = 0;
  for (let i = 0; i < prose.length; i += 1) {
    parts.push(prose[i]!);
    if (ti < tokens.length && (i + 1) % stride === 0) parts.push(tokens[ti++]!);
  }
  while (ti < tokens.length) parts.push(tokens[ti++]!);

  const type = MEMORY_TYPES[index % MEMORY_TYPES.length]!;
  const chainPos = slotOrdinal % 5;
  const chainId = Math.floor(slotOrdinal / 5);
  const topicKey = chainPos < 2 ? `vol/chain/${scopeSlot}/${chainId}` : null;

  return {
    title: `volumetric ${String(index).padStart(7, '0')} ${pick(rng, WORDS)} ${pick(rng, WORDS)}`,
    content: parts.join(' '),
    type,
    topicKey,
    tags: [`vol`, `scope-${scopeSlot}`, type],
  };
}

export function generateVector(seed: number, index: number): Float32Array {
  const rng = rngFor(seed, STREAM.vector, index);
  const v = new Float32Array(VOLUMETRIC_SHAPE.embeddingDims);
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = rng() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i += 1) v[i]! *= inv;
  return v;
}

export interface BuildResult {
  memories: number;
  memoriesByScopeSlot: number[];
  superseded: number;
  confirmations: number;
  sessions: number;
  endedSessions: number;
  relations: number;
  pendingRelations: number;
  orphanedRelations: number;
  prompts: number;
  deletedPrompts: number;
  projects: number;
  seed: number;
}

export interface BuildDeps {
  handle: DbHandle;
  args: VolumetricArgs;
  log?: (line: string) => void;
}

export function buildCorpus(deps: BuildDeps): BuildResult {
  const { handle, args } = deps;
  assertBuildable(args);
  const log = deps.log ?? ((l: string) => console.error(l));
  const repos = createRepositories(handle.db);

  let clockMs = CORPUS_EPOCH_MS;
  const clock = (): Date => new Date(clockMs);
  const projectsSvc = new ProjectsService(repos, clock);
  const tokensSvc = new TokensService(repos, handle.db, clock);
  const memorySvc = new MemoryService(repos, handle.db, clock);
  const sessionsSvc = new AgentSessionsService(repos, handle.db, clock);
  const relationsSvc = new RelationsService(repos, handle.db, clock);
  const promptsSvc = new PromptsService(repos, handle.db, clock);

  log(
    `[corpus] seed=${args.seed} memories=${args.memories} sessions=${args.sessions} relations=${args.relations} prompts=${args.prompts} skew=${args.skew}`,
  );
  log(`[corpus] CAVEAT: ${SYNTHETIC_VECTOR_CAVEAT}`);

  clockMs = CORPUS_EPOCH_MS - CORPUS_SPAN_MS;
  const projects = [
    projectsSvc.create({ slug: 'vol-shared', displayName: 'Volumetric shared' }),
    ...Array.from({ length: VOLUMETRIC_SHAPE.projectCount - 1 }, (_, i) =>
      projectsSvc.create({ slug: `vol-${i}`, displayName: `Volumetric ${i}` }),
    ),
  ];
  const token = tokensSvc.create({ name: 'volumetric-harness', scope: '*' });
  const scopes: Scope[] = projects.map((p) => projectScope(p.id));

  const result: BuildResult = {
    memories: 0,
    memoriesByScopeSlot: Array.from({ length: VOLUMETRIC_SHAPE.scopeCount }, () => 0),
    superseded: 0,
    confirmations: 0,
    sessions: 0,
    endedSessions: 0,
    relations: 0,
    pendingRelations: 0,
    orphanedRelations: 0,
    prompts: 0,
    deletedPrompts: 0,
    projects: projects.length,
    seed: args.seed,
  };

  const idsByScope: string[][] = Array.from({ length: VOLUMETRIC_SHAPE.scopeCount }, () => []);
  const sessionIds: string[] = [];

  const phase = (
    label: string,
    total: number,
    each: (i: number, step: number) => void,
    afterBatch?: () => void,
  ): void => {
    const step = total > 0 ? CORPUS_SPAN_MS / total : 0;
    for (let start = 0; start < total; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, total);
      handle.db.transaction(() => {
        for (let i = start; i < end; i += 1) {
          clockMs = CORPUS_EPOCH_MS - CORPUS_SPAN_MS + Math.round(i * step);
          each(i, step);
        }
      });
      afterBatch?.();
      if (end % 5000 === 0 || end === total) log(`[corpus] ${label} ${end}/${total}`);
    }
  };

  phase('sessions', args.sessions, (i, sessionStep) => {
    const rng = rngFor(args.seed, STREAM.session, i);
    const project = projects[i % projects.length]!;
    const session = sessionsSvc.start({
      tokenId: token.token.id,
      projectId: project.id,
      agent: pick(rng, AGENTS),
      description: null,
      cwd: `/srv/${pick(rng, WORDS)}/${pick(rng, WORDS)}`,
    });
    result.sessions += 1;
    if (rng() < VOLUMETRIC_SHAPE.sessionsEndedFraction) {
      clockMs += Math.max(1, Math.round(sessionStep / 2));
      const body = Array.from({ length: int(rng, 40, 160) }, () => pick(rng, WORDS)).join(' ');
      sessionsSvc.end(session.id, {
        tokenId: token.token.id,
        summary: `Goal: ${body}`,
        title: `volumetric session ${String(i).padStart(7, '0')}`,
        final: true,
      });
      result.endedSessions += 1;
    }
    sessionIds.push(session.id);
  });

  phase(
    'memories',
    args.memories,
    (i, memoryStep) => {
      const scopeSlot = scopeSlotFor(i, args.skew);
      const scope = scopes[scopeSlot]!;
      const gen = generateMemory(args.seed, i, scopeSlot, idsByScope[scopeSlot]!.length);
      const sessionRng = rngFor(args.seed, STREAM.memorySession, i);
      const sessionId =
        sessionIds.length > 0 && sessionRng() < VOLUMETRIC_SHAPE.memoriesWithSessionFraction
          ? sessionIds[int(sessionRng, 0, sessionIds.length - 1)]!
          : null;
      const { memory: row, supersededByTopicKey } = memorySvc.saveWithTopicKey(
        {
          type: gen.type,
          title: gen.title,
          content: gen.content,
          tags: gen.tags,
          topicKey: gen.topicKey,
          sessionId,
        },
        scope,
      );
      if (supersededByTopicKey) result.superseded += 1;
      result.memories += 1;
      result.memoriesByScopeSlot[scopeSlot]! += 1;
      idsByScope[scopeSlot]!.push(row.id);

      const vector = generateVector(args.seed, i);
      repos.vectors.insertEmbedding(
        row.id,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        partitionKeyFor(scope.projectId),
      );

      repos.entities.linkMemory(
        row.id,
        scope.projectId,
        extractEntities(row.title, row.content),
        row.createdAt,
      );

      const confirmRng = rngFor(args.seed, STREAM.confirmation, i);
      const n = confirmationCount(confirmRng);
      for (let c = 0; c < n; c += 1) {
        clockMs += Math.max(1, Math.round(memoryStep / (n + 1)));
        memorySvc.confirm(row.id, scope, {
          source: { agent: 'volumetric-harness' },
          sessionId,
        });
        result.confirmations += 1;
      }
    },
    () => refreshStatistics(handle),
  );

  phase('relations', args.relations, (i, relationStep) => {
    const rng = rngFor(args.seed, STREAM.relation, i);
    const slot = i % VOLUMETRIC_SHAPE.scopeCount;
    const pool = idsByScope[slot]!;
    const a = int(rng, 0, pool.length - 1);
    const b = (a + 1 + int(rng, 0, pool.length - 2)) % pool.length;
    const pending = relationsSvc.createPending({
      sourceId: pool[a]!,
      targetId: pool[b]!,
      markedByKind: 'system',
    });
    result.relations += 1;

    const u = rng();
    if (u < VOLUMETRIC_SHAPE.relationsPendingFraction) {
      result.pendingRelations += 1;
      return;
    }
    clockMs += Math.max(1, Math.round(relationStep / 2));
    if (u < RELATION_ORPHAN_CUTOFF) {
      relationsSvc.orphan(pending.judgmentId, 'volumetric: aged out');
      result.orphanedRelations += 1;
      return;
    }
    relationsSvc.judge(pending.judgmentId, {
      relation: pick(rng, JUDGED_VERDICTS),
      actor: 'volumetric-harness',
      kind: 'agent',
      confidence: Math.round(rng() * 100) / 100,
      reason: `volumetric: ${pick(rng, WORDS)} ${pick(rng, WORDS)}`,
    });
  });

  phase('prompts', args.prompts, (i, promptStep) => {
    const rng = rngFor(args.seed, STREAM.prompt, i);
    const slot = i % VOLUMETRIC_SHAPE.scopeCount;
    const projectId = projects[slot]!.id;
    const sessionId = sessionIds.length > 0 ? sessionIds[i % sessionIds.length]! : null;
    const words: string[] = [];
    let bytes = 0;
    while (bytes < VOLUMETRIC_SHAPE.promptBytesP50) {
      const w = pick(rng, WORDS);
      words.push(w);
      bytes += w.length + 1;
    }
    const row = promptsSvc.save({
      sessionId,
      projectId,
      title: `volumetric prompt ${String(i).padStart(7, '0')}`,
      content: `Always ${words.join(' ')}.`,
      tags: ['vol', `scope-${slot}`],
      agent: pick(rng, AGENTS),
    });
    result.prompts += 1;
    if (rng() < VOLUMETRIC_SHAPE.promptsDeletedFraction) {
      clockMs += Math.max(1, Math.round(promptStep / 2));
      promptsSvc.softDelete(row.id);
      result.deletedPrompts += 1;
    }
  });

  log('[corpus] done.');
  log(`  memories:      ${result.memories} (${result.superseded} superseded)`);
  log(`  confirmations: ${result.confirmations}`);
  log(`  sessions:      ${result.sessions} (${result.endedSessions} ended)`);
  log(
    `  relations:     ${result.relations} (${result.pendingRelations} pending, ${result.orphanedRelations} orphaned)`,
  );
  log(`  prompts:       ${result.prompts} (${result.deletedPrompts} soft-deleted)`);
  log(`  projects:      ${result.projects} (one per scope slot)`);
  for (const [slot, n] of result.memoriesByScopeSlot.entries()) {
    log(`    slot ${slot} (${projects[slot]!.slug}): ${n}`);
  }
  log(
    `[corpus] rebuild this corpus with: --db <dir> --memories ${args.memories} --sessions ${args.sessions} --relations ${args.relations} --prompts ${args.prompts} --seed ${args.seed}${args.skew ? ' --skew' : ''}`,
  );
  log(`[corpus] CAVEAT: ${SYNTHETIC_VECTOR_CAVEAT}`);
  return result;
}

function main(): void {
  let args: VolumetricArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[corpus] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const refusal = refuseTarget(args.dataDir);
  if (refusal !== null) {
    console.error(`[corpus] ${refusal}`);
    process.exit(1);
  }

  const handle = createDb({ dataDir: args.dataDir });
  try {
    buildCorpus({ handle, args });
  } finally {
    handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
