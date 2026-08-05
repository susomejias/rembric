/**
 * Volumetric corpus generator — the reproduction recipe for a performance claim.
 *
 * Usage:
 *   pnpm run corpus:build -- --db <dir> [--memories N] [--sessions M] [--seed S] [--skew]
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
import { RELATION_VALUES } from '../db/schema/memory-relations.js';
import { MEMORY_TYPES, type MemoryType } from '../db/schema/memory.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { extractEntities } from '../services/entities.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { projectScope, type Scope } from '../services/scope.js';
import { TokensService } from '../services/tokens.js';

export const SYNTHETIC_VECTOR_CAVEAT =
  'vectors are deterministic pseudo-random unit vectors, NOT embeddings — no retrieval-quality, ranking, fusion or abstention claim may be drawn from this corpus (use `pnpm run eval`)';

/**
 * Refused regardless of whether they are populated: `dev:docker:up` reseeds on
 * every boot, so an empty `data-dev` is exactly when a corpus would be lost.
 */
export const RESERVED_DIR_NAMES: readonly string[] = ['data', 'data-dev'];
export const RESERVED_ABSOLUTE_DIRS: readonly string[] = ['/data'];

export interface VolumetricArgs {
  /** Directory that holds (or will hold) `data.db`. */
  dataDir: string;
  memories: number;
  sessions: number;
  relations: number;
  prompts: number;
  seed: number;
  /** Memories follow `VOLUMETRIC_SHAPE.skewShares` instead of an even split. */
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

/** An unrecognised flag is a usage error, so `--reset` cannot be silently ignored. */
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

/**
 * The cross-axis preconditions. Asserted by `buildCorpus` too, so a
 * programmatic caller cannot bypass them and silently get self-relations or an
 * empty project.
 */
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

/** Accepts the directory or the `data.db` file itself; `createDb` owns the basename. */
export function normalizeDataDir(dbArg: string): string {
  const abs = resolve(dbArg);
  return basename(abs) === 'data.db' ? resolve(abs, '..') : abs;
}

/** Opens read-only for the emptiness test, so a refusal never modifies a file. */
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
 * The declared shape, asserted by the co-located test. Each figure is labelled
 * with its provenance: reproduced from `tune`, or a harness choice.
 */
export const VOLUMETRIC_SHAPE = {
  /** `tune`: "6 scopes" — read here as six projects, one per scope slot. */
  scopeCount: 6,
  projectCount: 6,
  /**
   * `--skew` only. Share of the memory axis per scope slot, in slot order, so
   * slot 1 (`vol-0`) dominates and slot 0 (`vol-shared`) is the smallest. A
   * corpus split evenly over six projects is the one shape a widening cost is
   * never measured on in production, where one repository usually holds most of
   * what an agent has ever written.
   */
  skewShares: [0.02, 0.6, 0.2, 0.1, 0.05, 0.03],
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
  /** HARNESS CHOICE: an all-NULL `session_id` makes session-grouped reads free. */
  memoriesWithSessionFraction: 0.7,
  /** HARNESS CHOICES: `tune` publishes a relation count but no status spread. */
  relationsPendingFraction: 0.25,
  relationsOrphanedFraction: 0.05,
  /** HARNESS CHOICES: prompts are short directives, not memory bodies. */
  promptBytesP50: 260,
  promptsDeletedFraction: 0.15,
  /** Confirmed on disk at `embedder.ts:24` and in migration 0014, not copied from prose. */
  embeddingDims: 768,
} as const;

/** Upper bound of the pending band; above it a relation is judged. */
const RELATION_ORPHAN_CUTOFF =
  VOLUMETRIC_SHAPE.relationsPendingFraction + VOLUMETRIC_SHAPE.relationsOrphanedFraction;

/** Two per scope: a relation needs two distinct memories in one scope. */
const MIN_MEMORIES_PER_SCOPE_FOR_RELATIONS = 2 * VOLUMETRIC_SHAPE.scopeCount;

/** Above `DEFAULT_SEARCH_LIMIT`, so the thinnest project can still fill a page. */
const MIN_MEMORIES_PER_SKEWED_SCOPE = 10;

/**
 * Positions in one repeat of the skew pattern. `skewShares × 100` are integers,
 * so a block of this length realises them exactly and every whole block leaves
 * the corpus on the declared shares.
 */
const SKEW_BLOCK_LENGTH = 100;

/**
 * Smooth weighted round-robin: at each position take the slot furthest behind
 * its share so far. Every slot's rows are therefore spread across the whole
 * `created_at` span rather than clustered, which a cumulative-threshold split
 * would not give — the dominant project would hold the oldest rows and the
 * recency term of the ranking boost would read the skew as an age difference.
 *
 * A tie goes to the lowest slot index. `skewShares` holds no two equal values,
 * so no tie arises for it (measured: zero over a 100-long block); the rule
 * matters only if the shares are ever made equal.
 */
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

/** Scope slot of memory `index`: even round-robin, or the skew block. */
export function scopeSlotFor(index: number, skew: boolean): number {
  return skew ? SKEW_BLOCK[index % SKEW_BLOCK_LENGTH]! : index % VOLUMETRIC_SHAPE.scopeCount;
}

/** `supersedes` absent here, so every one in the corpus is a `topic_key` audit row. */
const JUDGED_VERDICTS = RELATION_VALUES.filter((r) => r !== 'supersedes');

/**
 * Fixed, so the corpus is not a function of when it was built. Consequence:
 * decay/review are derived against the READ clock, so those axes need an
 * explicit `nowMs` rather than the ambient one.
 */
export const CORPUS_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');
const CORPUS_SPAN_MS = 365 * 24 * 60 * 60 * 1000;

/** Memories per enclosing transaction. Purely a throughput knob; no shape effect. */
const BATCH_SIZE = 500;

/** `Math.random()` is absent from this file, and a test asserts that. */
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
 * Index-addressable substream: a row's content does not depend on how many draws
 * earlier rows made, so extending one generator cannot perturb another.
 */
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

/**
 * Free of anything the entity extractor matches — no dots, digits or capitals —
 * so a body's entity count is exactly the tokens the generator placed in it.
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

/** Restated, not imported: these are tokens a body says, not the extractor's contract. */
// prettier-ignore
const ERRNOS: readonly string[] = [
  'ENOENT', 'EACCES', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ENOSPC', 'EEXIST', 'EINVAL',
];

/** JIRA-style prefixes, none of them in the extractor's standards denylist. */
const TICKET_PREFIXES: readonly string[] = ['RBR', 'OPS', 'PLT', 'SRE', 'DEV', 'INF'];

const AGENTS: readonly string[] = ['claude-code', 'codex-cli', 'hermes', 'opencode'];

function hex(rng: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) out += '0123456789abcdef'[Math.floor(rng() * 16)];
  return out;
}

/**
 * One per entity kind the extractor recognises. Suffixed so values cannot
 * collide within a body: the extractor dedupes per kind, which would undercount.
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

/** Mixture chosen to land p50/p90 on the declared figures with a thin tail beyond. */
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
 * Pure function of `(seed, index)`. Tokens interleaved, not clustered in a
 * header. `slotOrdinal` is the row's position WITHIN its scope slot, which the
 * chain layout is keyed on so an uneven split still produces two-long chains;
 * its default is the even split's value, so an omitted argument reproduces the
 * corpus a three-argument call produced.
 */
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
    // Never immediately after a token: some rules strip trailing punctuation.
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
  // Two fifths sit in two-long chains, so a fifth end up superseded.
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
  /** Indexed by scope slot; the realised split, even or skewed. */
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

/**
 * Rows go in through the services so derived state is trigger-built as in
 * production. `insertEmbedding` is the embedding worker's own call, not a
 * direct write to the vec index.
 */
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
  // Slot 0 held the global scope until that scope was retired. It is a project
  // now, and it keeps slot 0 with a slug of its own so that `vol-0`..`vol-4`
  // stay on slots 1..5: a corpus's numbered projects hold the same rows before
  // and after the move, which is what the narrow-path baseline is measured on.
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

  // Per scope slot, so the relation axis can pair within a scope without a query.
  const idsByScope: string[][] = Array.from({ length: VOLUMETRIC_SHAPE.scopeCount }, () => []);
  const sessionIds: string[] = [];

  /**
   * One batch/progress/clock scaffold for all four phases. A closure, not a
   * module function, because it assigns the captured `clockMs`.
   */
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
    // Spread across projects so a project-scoped query is not a single value.
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
        // Spread through the window so the timeline is not degenerate.
        clockMs += Math.max(1, Math.round(memoryStep / (n + 1)));
        memorySvc.confirm(row.id, scope, {
          source: { agent: 'volumetric-harness' },
          sessionId,
        });
        result.confirmations += 1;
      }
    },
    // Between batches, never inside one: without it the planner keeps an empty
    // database's statistics all run, which makes the build quadratic.
    () => refreshStatistics(handle),
  );

  phase('relations', args.relations, (i, relationStep) => {
    const rng = rngFor(args.seed, STREAM.relation, i);
    const slot = i % VOLUMETRIC_SHAPE.scopeCount;
    const pool = idsByScope[slot]!;
    // Offset rather than a second draw, so a pair is never degenerate.
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
    // Only when the session axis was built, so the axes stay independent.
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
