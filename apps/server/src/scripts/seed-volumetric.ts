/**
 * Volumetric corpus generator — the reproduction recipe for a performance claim.
 *
 * Usage:
 *   pnpm run corpus:build -- --db <dir> [--memories N] [--sessions M] [--seed S]
 *
 * The pnpm script is `corpus:build`, deliberately NOT `seed:*`: this script and
 * `seed-dev.ts` have opposite safety properties and must not be confusable at a
 * glance. `seed-dev` wipes on `--reset`; this one cannot delete anything and
 * refuses a database that already holds memories.
 *
 * It is NOT a demo fixture and it is NOT run by the shipped image. It exists so
 * that "we measured this at 50k" is a command a reader can run rather than a
 * figure quoted from a database that existed on one machine on one day.
 *
 * Its vectors are synthetic (see SYNTHETIC_VECTOR_CAVEAT): no claim about
 * retrieval quality, ranking, fusion or abstention may be drawn from a corpus
 * it built. `pnpm run eval` is the instrument for those.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { countTableRows, refreshStatistics } from '../db/diagnostics.js';
import { createDb, type DbHandle } from '../db/index.js';
import { createRepositories } from '../db/repositories/index.js';
import { partitionKeyFor } from '../db/repositories/scope-clause.js';
import { MEMORY_TYPES, type MemoryType } from '../db/schema/memory.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { extractEntities } from '../services/entities.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { SCOPE_GLOBAL, projectScope, type Scope } from '../services/scope.js';
import { TokensService } from '../services/tokens.js';

export const SYNTHETIC_VECTOR_CAVEAT =
  'vectors are deterministic pseudo-random unit vectors, NOT embeddings — no retrieval-quality, ranking, fusion or abstention claim may be drawn from this corpus (use `pnpm run eval`)';

/**
 * Directory names this harness refuses outright, independent of whether they
 * are populated. Both compose files bind a host directory named `data` or
 * `data-dev` onto the container's `/data`, so refusing the name covers a host
 * invocation and refusing the absolute path covers an in-container one. The
 * emptiness check alone would not: `dev:docker:up` runs `seed-dev --reset` on
 * every boot, so `data-dev` is routinely empty at exactly the moment a
 * measurement tool would find it writable.
 */
export const RESERVED_DIR_NAMES: readonly string[] = ['data', 'data-dev'];
export const RESERVED_ABSOLUTE_DIRS: readonly string[] = ['/data'];

export interface VolumetricArgs {
  /** Directory that holds (or will hold) `data.db`. */
  dataDir: string;
  memories: number;
  sessions: number;
  seed: number;
}

export const DEFAULT_ARGS = { memories: 1000, sessions: 0, seed: 1 } as const;

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

/**
 * There is no `--reset`, no `--force`, and no destructive environment gate, by
 * construction: an unrecognised flag is a usage error rather than something the
 * parser tolerates, so a caller who types `--reset` out of habit gets told the
 * harness never deletes instead of silently having it ignored.
 */
export function parseArgs(argv: readonly string[]): VolumetricArgs {
  let dataDir: string | undefined;
  let memories: number = DEFAULT_ARGS.memories;
  let sessions: number = DEFAULT_ARGS.sessions;
  let seed: number = DEFAULT_ARGS.seed;

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
      case '--seed':
        seed = requireCount(flag, requireValue(flag, argv[(i += 1)]));
        break;
      default:
        throw new UsageError(
          `unknown flag ${JSON.stringify(flag)}. Accepted: --db <dir> --memories N --sessions M --seed S. ` +
            'This harness never deletes, so there is no --reset and no --force: remove the corpus directory yourself.',
        );
    }
  }

  if (dataDir === undefined) throw new UsageError('--db <dir> is required');
  return { dataDir: normalizeDataDir(dataDir), memories, sessions, seed };
}

/**
 * `--db` accepts either the directory that holds the SQLite file or the file
 * itself, because `createDb` owns the `data.db` basename and a caller who
 * passes `corpus-50k.db` expecting a file would otherwise silently get
 * `./data.db`. Any other basename is taken as the directory.
 */
export function normalizeDataDir(dbArg: string): string {
  const abs = resolve(dbArg);
  return basename(abs) === 'data.db' ? resolve(abs, '..') : abs;
}

/**
 * The refusals, as a pure-ish precheck: it opens nothing for a reserved path and
 * opens read-only for the emptiness test, so a refusal never modifies a file.
 * Returns the operator-facing message, or null when the target is usable.
 */
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

  // Read-only so the check itself cannot create, migrate or touch anything.
  const handle = createDb({ dataDir: abs, readonly: true });
  let memories: number | null;
  try {
    memories = countTableRows(handle, 'memory');
  } finally {
    handle.close();
  }
  // null = the table does not exist, i.e. an unmigrated or empty file.
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

/**
 * The declared shape of a generated corpus, in ONE place so the co-located test
 * has something to compare a realised corpus against rather than re-deriving
 * the intent. Every figure sourced from `tune-hot-query-paths/design.md` is
 * labelled with it; the two that are not are labelled as harness choices, so a
 * reader can tell a reproduction from a decision.
 */
export const VOLUMETRIC_SHAPE = {
  /** `tune`: "6 scopes" — read here as the global scope plus five projects. */
  scopeCount: 6,
  projectCount: 5,
  /** `tune`: "realistic ~1.3KB bodies". Median of the generated distribution. */
  bodyBytesP50: 1300,
  /** The long tail D3 asks for: p90 at roughly twice the median. */
  bodyBytesP90: 2600,
  /** `tune`: "~18 entities per memory", as counted by the real extractor. */
  entitiesPerMemory: 18,
  /** `tune`: "~1.35 confirmations per memory". Affirmations; the harness writes no refutations. */
  confirmationsPerMemory: 1.35,
  /**
   * HARNESS CHOICE, not a `tune` figure — `tune` never published a ratio. Set
   * high enough that `memory_replaces` and the supersede chains are populated
   * for the findings that walk that graph. Realised as: two fifths of memories
   * sit in two-long `topic_key` chains, so one fifth end up superseded.
   */
  supersededFraction: 0.2,
  /** HARNESS CHOICE: an all-active session corpus would not exercise the status filters. */
  sessionsEndedFraction: 0.8,
  /** Confirmed on disk at `embedder.ts:24` and in migration 0014, not copied from prose. */
  embeddingDims: 768,
} as const;

/**
 * Fixed base instant for every generated timestamp. A wall-clock `Date.now()`
 * would make the corpus a function of when it was built, which is precisely
 * what determinism has to exclude.
 *
 * Consequence, stated rather than left to be discovered: the decay and review
 * axes are derived against the clock at READ time, so a corpus built today and
 * queried in six months reports different `needsReview` counts. A review- or
 * decay-axis measurement must therefore pass an explicit `nowMs` (the
 * repository reads already take one) instead of relying on the ambient clock.
 */
export const CORPUS_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');
const CORPUS_SPAN_MS = 365 * 24 * 60 * 60 * 1000;

/** Memories per enclosing transaction. Purely a throughput knob; no shape effect. */
const BATCH_SIZE = 500;

/**
 * splitmix32 — a small, fast, well-distributed PRNG. `Math.random()` is
 * deliberately absent from this file (a test asserts it): a corpus that cannot
 * be rebuilt byte-for-byte is the failure this harness exists to fix.
 */
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

/**
 * An index-addressable substream. Deriving each row's generator from
 * `(seed, stream, index)` rather than pulling from one shared sequence means a
 * row's content does not depend on how many draws the rows before it happened
 * to make — so adding a field to the session generator cannot silently change
 * every memory body.
 */
function rngFor(seed: number, stream: number, index: number): () => number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const v of [stream, index]) {
    h = (h ^ Math.imul(v + 0x165667b1, 0x27d4eb2f)) >>> 0;
    h = (Math.imul(h, 0x85ebca6b) ^ (h >>> 13)) >>> 0;
  }
  return splitmix32(h);
}

const STREAM = { memory: 1, confirmation: 2, session: 3, vector: 4 } as const;

function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

/**
 * Ordinary lowercase vocabulary, sampled to build bodies (design D3). FTS5 is a
 * real consumer here: one repeated token would produce an index that does not
 * behave like production's. Deliberately free of anything the entity extractor
 * matches — no dots, no digits, no capitals — so the entity count of a body is
 * the number of tokens the generator deliberately placed in it.
 */
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

/** Uppercase fragments used only inside error-code and env-var tokens. */
// prettier-ignore
const SHOUT: readonly string[] = [
  'BUSY', 'CANTOPEN', 'CORRUPT', 'FULL', 'LOCKED', 'MISUSE', 'NOTADB', 'PROTOCOL',
  'READONLY', 'SCHEMA', 'TOOBIG', 'CONSTRAINT',
];

/**
 * A subset of the extractor's closed errno whitelist, restated here as sample
 * text rather than imported: these are tokens a generated body says, not the
 * extractor's contract, and coupling the generator to `ERRNO_NAMES` would make
 * narrowing that list a generator change too.
 */
// prettier-ignore
const ERRNOS: readonly string[] = [
  'ENOENT', 'EACCES', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ENOSPC', 'EEXIST', 'EINVAL',
];

/** JIRA-style prefixes, none of them in the extractor's standards denylist. */
const TICKET_PREFIXES: readonly string[] = ['RBR', 'OPS', 'PLT', 'SRE', 'DEV', 'INF'];

function hex(rng: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) out += '0123456789abcdef'[Math.floor(rng() * 16)];
  return out;
}

/**
 * One generator per entity shape the extractor recognises, so a corpus exercises
 * all twelve kinds rather than whichever one was easiest to synthesise. Each
 * carries a random suffix so the values do not collide inside one body — the
 * extractor dedupes per kind, and a collision would silently lower the realised
 * entity count below the declared one.
 */
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
  // RFC 9562 layout with the version and variant nibbles constrained, which is
  // what the extractor's UUID rule requires.
  (r) =>
    `${hex(r, 8)}-${hex(r, 4)}-${int(r, 1, 8)}${hex(r, 3)}-${pick(r, ['8', '9', 'a', 'b'])}${hex(r, 3)}-${hex(r, 12)}`,
  // A short SHA needs both a hex letter and a digit to be admitted as a ref.
  (r) => `${hex(r, 5)}${int(r, 0, 9)}${pick(r, ['a', 'b', 'c', 'd', 'e', 'f'])}${hex(r, 5)}`,
  (r) => `CVE-20${int(r, 10, 26)}-${int(r, 1000, 99999)}`,
  (r) => `10.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}`,
  // Digit-only suffix on purpose: a hex suffix here would also be admitted as a
  // git ref and inflate that kind's count.
  (r) => `${pick(r, WORDS)}-${pick(r, WORDS)}-${int(r, 1, 9)}.service`,
  (r) => Array.from({ length: 6 }, () => hex(r, 2)).join(':'),
  (r) => `${pick(r, WORDS)}-${int(r, 10, 99)}.local`,
];

/**
 * Body length multipliers as a four-bucket mixture over the declared median.
 * Chosen so the median lands on `bodyBytesP50` and the 90th percentile near
 * `bodyBytesP90`, with a thin tail beyond it — a single uniform range would give
 * FTS a corpus with no long documents in it at all.
 */
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

/** Affirmation counts with mean ≈ `confirmationsPerMemory`. */
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
  /** Present only for the chain members; drives the supersede fraction. */
  topicKey: string | null;
  tags: string[];
}

/**
 * A body: the entity tokens the shape asks for, spread evenly through sampled
 * prose so the FTS index sees them interleaved rather than clustered in a
 * header. Pure function of `(seed, index)`.
 */
export function generateMemory(seed: number, index: number, scopeSlot: number): GeneratedMemory {
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
    // A sentence stop after 8..14 words, never immediately after an entity
    // token: several extractor rules strip or refuse trailing punctuation, and
    // punctuating a token would make the realised kind depend on placement.
    const stop = sinceStop >= int(rng, 8, 14);
    prose.push(stop ? `${word}.` : word);
    if (stop) sinceStop = 0;
    bytes += word.length + 1 + (stop ? 1 : 0);
  }

  // Even interleave: one token every `stride` prose words.
  const stride = Math.max(1, Math.floor(prose.length / (tokens.length + 1)));
  const parts: string[] = [];
  let ti = 0;
  for (let i = 0; i < prose.length; i += 1) {
    parts.push(prose[i]!);
    if (ti < tokens.length && (i + 1) % stride === 0) parts.push(tokens[ti++]!);
  }
  while (ti < tokens.length) parts.push(tokens[ti++]!);

  const type = MEMORY_TYPES[index % MEMORY_TYPES.length]!;
  // Two fifths of memories sit in two-long topic chains, so a fifth of the
  // corpus ends up superseded. The scope slot is in the key so a chain can
  // never straddle two scopes, which the topic_key upsert scopes by anyway.
  const chainPos = Math.floor(index / VOLUMETRIC_SHAPE.scopeCount) % 5;
  const chainId = Math.floor(index / VOLUMETRIC_SHAPE.scopeCount / 5);
  const topicKey = chainPos < 2 ? `vol/chain/${scopeSlot}/${chainId}` : null;

  return {
    title: `volumetric ${String(index).padStart(7, '0')} ${pick(rng, WORDS)} ${pick(rng, WORDS)}`,
    content: parts.join(' '),
    type,
    topicKey,
    tags: [`vol`, `scope-${scopeSlot}`, type],
  };
}

/** A deterministic pseudo-random unit vector at the width confirmed on disk. */
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
  superseded: number;
  confirmations: number;
  sessions: number;
  endedSessions: number;
  projects: number;
  seed: number;
}

export interface BuildDeps {
  handle: DbHandle;
  args: VolumetricArgs;
  log?: (line: string) => void;
}

/**
 * Rows go in through the services, so the FTS triggers, the `memory_replaces`
 * triggers and the entity tables are populated the way the running server
 * populates them (design D6). Nothing here writes to a derived table directly —
 * `insertEmbedding` is the embedding worker's own call, which is why the vec
 * index is reached through it rather than with an INSERT of our own.
 */
export function buildCorpus(deps: BuildDeps): BuildResult {
  const { handle, args } = deps;
  const log = deps.log ?? ((l: string) => console.error(l));
  const repos = createRepositories(handle.db);

  let clockMs = CORPUS_EPOCH_MS;
  const clock = (): Date => new Date(clockMs);
  const projectsSvc = new ProjectsService(repos, clock);
  const tokensSvc = new TokensService(repos, clock);
  const memorySvc = new MemoryService(repos, handle.db, clock);
  const sessionsSvc = new AgentSessionsService(repos, handle.db, clock);

  log(`[corpus] seed=${args.seed} memories=${args.memories} sessions=${args.sessions}`);
  log(`[corpus] CAVEAT: ${SYNTHETIC_VECTOR_CAVEAT}`);

  clockMs = CORPUS_EPOCH_MS - CORPUS_SPAN_MS;
  const projects = Array.from({ length: VOLUMETRIC_SHAPE.projectCount }, (_, i) =>
    projectsSvc.create({ slug: `vol-${i}`, displayName: `Volumetric ${i}` }),
  );
  const token = tokensSvc.create({ name: 'volumetric-harness', scope: '*' });
  // Scope slot 0 is global; 1..5 are the projects. Six in all, per `tune`.
  const scopes: Scope[] = [SCOPE_GLOBAL, ...projects.map((p) => projectScope(p.id))];

  const result: BuildResult = {
    memories: 0,
    superseded: 0,
    confirmations: 0,
    sessions: 0,
    endedSessions: 0,
    projects: projects.length,
    seed: args.seed,
  };

  const memoryStep = args.memories > 0 ? CORPUS_SPAN_MS / args.memories : 0;

  for (let start = 0; start < args.memories; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, args.memories);
    handle.db.transaction(() => {
      for (let i = start; i < end; i += 1) {
        const scopeSlot = i % VOLUMETRIC_SHAPE.scopeCount;
        const scope = scopes[scopeSlot]!;
        const gen = generateMemory(args.seed, i, scopeSlot);

        clockMs = CORPUS_EPOCH_MS - CORPUS_SPAN_MS + Math.round(i * memoryStep);
        const { memory: row, supersededByTopicKey } = memorySvc.saveWithTopicKey(
          {
            type: gen.type,
            title: gen.title,
            content: gen.content,
            tags: gen.tags,
            topicKey: gen.topicKey,
          },
          scope,
        );
        if (supersededByTopicKey) result.superseded += 1;
        result.memories += 1;

        const vector = generateVector(args.seed, i);
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

        const confirmRng = rngFor(args.seed, STREAM.confirmation, i);
        const n = confirmationCount(confirmRng);
        for (let c = 0; c < n; c += 1) {
          // Spread through the window between this row and the next, so the
          // affirmation timeline is not degenerate on `created_at`.
          clockMs += Math.max(1, Math.round(memoryStep / (n + 1)));
          memorySvc.confirm(row.id, scope, { source: { agent: 'volumetric-harness' } });
          result.confirmations += 1;
        }
      }
    });
    // Between batches, never inside one: a bulk writer gets no restart, and
    // without this the planner keeps an empty database's statistics for the
    // whole run — which puts `linkMemory`'s OR chain on the degenerate scope
    // scan `tune-hot-query-paths` characterised, at a cost linear in the
    // scope's entity count and therefore quadratic over the build. Measured in
    // measurements.md §5: 149s to 20k without it, and it is not a bypass of
    // design D6 — the rows still go through the services, only `sqlite_stat1`
    // is refreshed, exactly as `createDb` refreshes it on every boot.
    refreshStatistics(handle);
    if (end % 5000 === 0 || end === args.memories) {
      log(`[corpus] memories ${end}/${args.memories}`);
    }
  }

  const sessionStep = args.sessions > 0 ? CORPUS_SPAN_MS / args.sessions : 0;
  for (let start = 0; start < args.sessions; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, args.sessions);
    handle.db.transaction(() => {
      for (let i = start; i < end; i += 1) {
        const rng = rngFor(args.seed, STREAM.session, i);
        // The session axis is independent of the memory axis by construction
        // (design D4), but its rows still spread across the projects so a
        // project-scoped session query is not a single-value lookup.
        const project = projects[i % projects.length]!;
        clockMs = CORPUS_EPOCH_MS - CORPUS_SPAN_MS + Math.round(i * sessionStep);
        const session = sessionsSvc.start({
          tokenId: token.token.id,
          projectId: project.id,
          agent: pick(rng, ['claude-code', 'codex-cli', 'hermes', 'opencode']),
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
      }
    });
    if (end % 5000 === 0 || end === args.sessions) {
      log(`[corpus] sessions ${end}/${args.sessions}`);
    }
  }

  log('[corpus] done.');
  log(`  memories:      ${result.memories} (${result.superseded} superseded)`);
  log(`  confirmations: ${result.confirmations}`);
  log(`  sessions:      ${result.sessions} (${result.endedSessions} ended)`);
  log(`  projects:      ${result.projects} (+ the global scope = ${VOLUMETRIC_SHAPE.scopeCount})`);
  log(
    `[corpus] rebuild this corpus with: --db <dir> --memories ${args.memories} --sessions ${args.sessions} --seed ${args.seed}`,
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
