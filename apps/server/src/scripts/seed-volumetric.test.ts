import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createDb } from '../db/index.js';
import { createRepositories } from '../db/repositories/index.js';
import { MemoryService } from '../services/memory.js';
import { SCOPE_GLOBAL } from '../services/scope.js';

import {
  CORPUS_EPOCH_MS,
  UsageError,
  VOLUMETRIC_SHAPE,
  type BuildResult,
  type VolumetricArgs,
  buildCorpus,
  generateVector,
  normalizeDataDir,
  parseArgs,
  refuseTarget,
} from './seed-volumetric.js';

const dirs: string[] = [];

function tempDir(name = 'rembric-vol-'): string {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Content digest + mtime of the database file itself, so "wrote nothing" is
 * checkable. Deliberately not a listing of the whole directory: any connection
 * to a WAL-mode database — including the read-only one the guard opens —
 * materialises a scratch `-shm` and a zero-length `-wal` beside it. Those are
 * SQLite's shared-memory machinery, not a modification of the data, and the
 * caller's assertion pairs this with an empty-`-wal` check so a refusal that
 * *did* commit something could not hide in them.
 */
function dbFingerprint(dir: string): string {
  const file = join(dir, 'data.db');
  const st = statSync(file);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${st.size}:${st.mtimeMs}:${digest}`;
}

function walBytes(dir: string): number {
  const wal = join(dir, 'data.db-wal');
  return existsSync(wal) ? statSync(wal).size : 0;
}

describe('seed-volumetric argument surface', () => {
  it('requires --db and defaults the rest', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    const args = parseArgs(['--db', '/tmp/corpus-x']);
    expect(args).toEqual({
      dataDir: resolve('/tmp/corpus-x'),
      memories: 1000,
      sessions: 0,
      seed: 1,
    });
  });

  it('parses both axes and the seed independently', () => {
    expect(parseArgs(['--db', '/tmp/c', '--memories', '0', '--sessions', '50000'])).toMatchObject({
      memories: 0,
      sessions: 50000,
    });
    expect(parseArgs(['--db', '/tmp/c', '--seed', '7'])).toMatchObject({ seed: 7 });
  });

  it('rejects non-integer and negative counts', () => {
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', 'lots'])).toThrow(UsageError);
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', '-1'])).toThrow(UsageError);
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', '1.5'])).toThrow(UsageError);
    expect(() => parseArgs(['--db'])).toThrow(UsageError);
  });

  // The executable half of design D1: a destructive flag must not be quietly
  // ignored, it must be a usage error that says why the harness has none.
  it.each(['--reset', '--force', '--wipe', '--yes'])('rejects the destructive flag %s', (flag) => {
    expect(() => parseArgs(['--db', '/tmp/c', flag])).toThrow(/never deletes/);
  });

  it('accepts either the directory or the data.db file as --db', () => {
    expect(normalizeDataDir('/tmp/corpus-50k')).toBe(resolve('/tmp/corpus-50k'));
    expect(normalizeDataDir('/tmp/corpus-50k/data.db')).toBe(resolve('/tmp/corpus-50k'));
  });
});

/**
 * Design D1 in executable form. The constraint is worth nothing if the next
 * contributor can add a flag and only a design document objects, so the shape
 * of the file is asserted rather than described: no DELETE, no destructive
 * flag, no env gate, and no entry in the invariant suite's DELETE allow-list.
 */
describe('seed-volumetric is structurally incapable of deleting', () => {
  const harnessSrc = readFileSync(new URL('./seed-volumetric.ts', import.meta.url), 'utf8');

  // Matched against what would DO the deleting, never against the words: the
  // refusal messages must be free to say "--reset" and "never deletes" in order
  // to explain their own absence, and a test that forbade the strings would
  // pressure a future contributor into a vaguer message.
  it.each([
    ['a SQL delete', /DELETE\s+FROM|\bdb\.delete\(|\bdeleteAll\(/i],
    ['a schema drop', /DROP\s+(TABLE|INDEX|TRIGGER)|\bVACUUM\b/i],
    ['a filesystem removal', /\brm(Sync|dirSync)?\b\s*\(|\bunlinkSync\b|\btruncateSync\b|-rf\b/],
    ['a handled destructive flag', /case\s*'--(reset|force|wipe|clean|overwrite)'/],
  ])('contains no %s', (_label, pattern) => {
    const offenders = harnessSrc
      .split('\n')
      .map((line, n) => `${n + 1}: ${line}`)
      .filter((line) => pattern.test(line));
    expect(offenders).toEqual([]);
  });

  it('reads no destructive environment gate', () => {
    // seed-dev has REMBRIC_ALLOW_DESTRUCTIVE_SEED because resetting a dev stack
    // is its job. This harness fills an empty file and must read no env at all.
    expect(harnessSrc).not.toMatch(/process\.env|REMBRIC_ALLOW/);
  });

  it('is absent from the DELETE allow-list in the invariant suite', () => {
    const invariants = readFileSync(new URL('../test/invariants.test.ts', import.meta.url), 'utf8');
    expect(invariants).not.toMatch(/seed-volumetric/);
    // Positive anchor: the allow-list this change must not widen is still the
    // closed pair design D1 argues from.
    expect(invariants).toContain(
      "allow: ['db/repositories/memory-repository.ts', 'scripts/seed-dev.ts'],",
    );
  });
});

describe('seed-volumetric refusals', () => {
  it('accepts a fresh directory', () => {
    expect(refuseTarget(tempDir())).toBeNull();
  });

  it('refuses the dev stack data directory even when it is empty', () => {
    const parent = tempDir();
    const devDir = join(parent, 'data-dev');
    mkdirSync(devDir);
    const msg = refuseTarget(devDir);
    expect(msg).toContain(devDir);
    expect(msg).toMatch(/data directory/);
    expect(readdirSync(devDir)).toEqual([]);
  });

  it("refuses the prod stack's data directory too", () => {
    const parent = tempDir();
    const prodDir = join(parent, 'data');
    mkdirSync(prodDir);
    expect(refuseTarget(prodDir)).toContain(prodDir);
    expect(refuseTarget('/data')).toContain('/data');
  });

  it('accepts an existing but memory-free database', () => {
    const dir = tempDir();
    createDb({ dataDir: dir }).close();
    expect(refuseTarget(dir)).toBeNull();
  });

  it('refuses a populated database, naming the path, without modifying it', () => {
    const dir = tempDir();
    const handle = createDb({ dataDir: dir });
    new MemoryService(createRepositories(handle.db), handle.db).save(
      { type: 'project', title: 'pre-existing', content: 'a row the harness must not touch' },
      SCOPE_GLOBAL,
    );
    handle.close();

    const before = dbFingerprint(dir);
    const msg = refuseTarget(dir);
    expect(msg).toContain(join(dir, 'data.db'));
    expect(msg).toContain('already holds 1 memories');
    expect(msg).toMatch(/never deletes/);
    expect(dbFingerprint(dir)).toEqual(before);
    expect(walBytes(dir)).toBe(0);
  });
});

/**
 * A generated corpus is expensive enough that these share one. 480 memories is
 * the smallest size that keeps every declared ratio checkable: it divides by the
 * 6 scopes and by the 5-long chain period, so the scope spread and the
 * superseded fraction are exact rather than rounded, and it leaves enough rows
 * for the body-length percentiles to be meaningful.
 */
const SHARED_MEMORIES = 480;
const SHARED_SESSIONS = 120;

function buildInto(
  dir: string,
  overrides: Partial<VolumetricArgs> = {},
): { handle: ReturnType<typeof createDb>; result: BuildResult } {
  const handle = createDb({ dataDir: dir });
  const result = buildCorpus({
    handle,
    args: {
      dataDir: dir,
      memories: SHARED_MEMORIES,
      sessions: SHARED_SESSIONS,
      seed: 1,
      ...overrides,
    },
    log: () => {},
  });
  return { handle, result };
}

function rows<T>(handle: ReturnType<typeof createDb>, sql: string): T[] {
  return handle.raw.prepare(sql).all() as T[];
}

function scalar(handle: ReturnType<typeof createDb>, sql: string): number {
  return (handle.raw.prepare(sql).get() as { v: number }).v;
}

/**
 * Every source table the harness must populate, checked against the source of
 * truth it is derived from. Returns the divergences, so the same function can
 * assert emptiness on a real corpus (4.3) and be OBSERVED failing on a corpus
 * whose write path was bypassed (4.4) — a derived-state assertion that has never
 * been seen to fail is not an assertion.
 */
function derivedStateProblems(handle: ReturnType<typeof createDb>): string[] {
  const problems: string[] = [];
  const memories = scalar(handle, 'SELECT COUNT(*) v FROM memory');
  const check = (label: string, got: number, want: number) => {
    if (got !== want) problems.push(`${label}: ${got} != ${want}`);
  };
  check('memory_fts', scalar(handle, 'SELECT COUNT(*) v FROM memory_fts'), memories);
  check('memory_vec', scalar(handle, 'SELECT COUNT(*) v FROM memory_vec'), memories);
  check(
    'memory_entity_scan',
    scalar(handle, 'SELECT COUNT(*) v FROM memory_entity_scan'),
    memories,
  );
  check(
    'memory_replaces',
    scalar(handle, 'SELECT COUNT(*) v FROM memory_replaces'),
    scalar(handle, "SELECT COUNT(*) v FROM memory WHERE status = 'superseded'"),
  );
  // Not a count comparison: every memory must carry at least one entity link,
  // which an empty link table would fail while a row count could not.
  check(
    'memories with no entity link',
    scalar(
      handle,
      'SELECT COUNT(*) v FROM memory m WHERE NOT EXISTS (SELECT 1 FROM memory_entity_links l WHERE l.memory_id = m.id)',
    ),
    0,
  );
  check(
    'memory_entities orphaned from the link table',
    scalar(
      handle,
      'SELECT COUNT(*) v FROM memory_entities e WHERE NOT EXISTS (SELECT 1 FROM memory_entity_links l WHERE l.entity_id = e.id)',
    ),
    0,
  );
  // An empty FTS index would measure every lexical query as trivially fast, so
  // the index is exercised rather than merely counted.
  const hit = scalar(
    handle,
    "SELECT COUNT(*) v FROM memory_fts WHERE memory_fts MATCH 'volumetric'",
  );
  if (hit !== memories) problems.push(`memory_fts MATCH: ${hit} != ${memories}`);
  return problems;
}

describe('seed-volumetric generates the shape it declares', () => {
  const dir = tempDir();
  const { handle, result } = buildInto(dir);
  afterAll(() => handle.close());

  it('spreads memories evenly over the declared scope count', () => {
    const spread = rows<{ n: number }>(
      handle,
      'SELECT COUNT(*) n FROM memory GROUP BY scope, project_id',
    );
    expect(spread).toHaveLength(VOLUMETRIC_SHAPE.scopeCount);
    for (const s of spread) {
      expect(s.n).toBe(SHARED_MEMORIES / VOLUMETRIC_SHAPE.scopeCount);
    }
  });

  // Exact, not toleranced: the chain layout is arithmetic, not sampled, so a
  // drift here is a bug in the layout rather than sampling noise.
  it('supersedes exactly the declared fraction, through real topic_key chains', () => {
    const superseded = scalar(handle, "SELECT COUNT(*) v FROM memory WHERE status = 'superseded'");
    expect(superseded / SHARED_MEMORIES).toBeCloseTo(VOLUMETRIC_SHAPE.supersededFraction, 5);
    expect(result.superseded).toBe(superseded);
    // Via chains, not by writing `status` directly: each superseded row must
    // have a successor pointing at it through the `replaces` edge table.
    expect(scalar(handle, 'SELECT COUNT(*) v FROM memory_replaces')).toBe(superseded);
    expect(
      scalar(
        handle,
        "SELECT COUNT(*) v FROM memory m WHERE m.status = 'superseded' AND NOT EXISTS (SELECT 1 FROM memory_replaces r WHERE r.predecessor_id = m.id)",
      ),
    ).toBe(0);
  });

  it('places the declared number of entities per memory, via the real extractor', () => {
    const per = rows<{ n: number }>(
      handle,
      'SELECT COUNT(*) n FROM memory_entity_links GROUP BY memory_id',
    ).map((r) => r.n);
    expect(per).toHaveLength(SHARED_MEMORIES);
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    // Tolerance ±10%: the tokens are placed exactly, so the only slack is the
    // extractor deduping two synthesised values that happened to collide.
    expect(mean).toBeGreaterThan(VOLUMETRIC_SHAPE.entitiesPerMemory * 0.9);
    expect(mean).toBeLessThanOrEqual(VOLUMETRIC_SHAPE.entitiesPerMemory);
  });

  it('hits the declared body-length percentiles with a long tail', () => {
    const lens = rows<{ L: number }>(handle, 'SELECT length(content) L FROM memory ORDER BY L').map(
      (r) => r.L,
    );
    const pct = (p: number) => lens[Math.floor((lens.length - 1) * p)]!;
    // ±15%: the length is drawn from a bucket mixture, so a percentile of a
    // 480-row sample carries real sampling noise. Tighter would be a flaky test
    // rather than a stronger guarantee.
    expect(pct(0.5)).toBeGreaterThan(VOLUMETRIC_SHAPE.bodyBytesP50 * 0.85);
    expect(pct(0.5)).toBeLessThan(VOLUMETRIC_SHAPE.bodyBytesP50 * 1.15);
    expect(pct(0.9)).toBeGreaterThan(VOLUMETRIC_SHAPE.bodyBytesP90 * 0.85);
    expect(pct(0.9)).toBeLessThan(VOLUMETRIC_SHAPE.bodyBytesP90 * 1.15);
    // The tail D3 asks for: FTS must see documents several times the median.
    expect(pct(0.99)).toBeGreaterThan(VOLUMETRIC_SHAPE.bodyBytesP50 * 2.5);
  });

  it('writes the declared mean number of affirmations', () => {
    const confirmations = scalar(handle, 'SELECT COUNT(*) v FROM confirmations');
    const mean = confirmations / SHARED_MEMORIES;
    // ±15%, same reason as the body percentiles: the count per memory is drawn
    // from a five-bucket distribution whose mean the sample approaches slowly.
    expect(mean).toBeGreaterThan(VOLUMETRIC_SHAPE.confirmationsPerMemory * 0.85);
    expect(mean).toBeLessThan(VOLUMETRIC_SHAPE.confirmationsPerMemory * 1.15);
    // Affirmations only — the harness writes no refutations, so a review-axis
    // measurement is not silently reading a mixed signal.
    expect(scalar(handle, "SELECT COUNT(*) v FROM confirmations WHERE verdict = 'affirm'")).toBe(
      confirmations,
    );
  });

  it('ends the declared fraction of sessions', () => {
    const total = scalar(handle, 'SELECT COUNT(*) v FROM sessions');
    const ended = scalar(handle, 'SELECT COUNT(*) v FROM sessions WHERE ended_at IS NOT NULL');
    expect(total).toBe(SHARED_SESSIONS);
    expect(ended / total).toBeGreaterThan(VOLUMETRIC_SHAPE.sessionsEndedFraction - 0.12);
    expect(ended / total).toBeLessThan(VOLUMETRIC_SHAPE.sessionsEndedFraction + 0.12);
  });

  it('writes a unit vector of the confirmed width for every memory', () => {
    const blobs = rows<{ n: number }>(handle, 'SELECT length(embedding) n FROM memory_vec');
    expect(blobs).toHaveLength(SHARED_MEMORIES);
    for (const b of blobs) {
      expect(b.n).toBe(VOLUMETRIC_SHAPE.embeddingDims * 4);
    }
    const v = generateVector(1, 0);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('populates every derived table consistently with its source', () => {
    expect(derivedStateProblems(handle)).toEqual([]);
  });
});

describe('seed-volumetric derived-state assertion can actually fail', () => {
  // Task 4.4. The point is not that a bypass is possible — it is that the check
  // in the test above detects one. Without this, an all-green derived-state
  // assertion could equally mean the check is vacuous.
  it('reports a memory inserted without the harness write path', () => {
    const dir = tempDir();
    const handle = createDb({ dataDir: dir });
    try {
      buildCorpus({
        handle,
        args: { dataDir: dir, memories: 60, sessions: 0, seed: 1 },
        log: () => {},
      });
      expect(derivedStateProblems(handle)).toEqual([]);

      // Straight to the repository, skipping the harness's insertEmbedding and
      // linkMemory. `memory_fts` and `memory_replaces` are trigger-maintained
      // and stay correct; the vec index and the entity tables do not, which is
      // exactly the divergence the check exists to catch.
      createRepositories(handle.db).memory.insert({
        id: '01JGFJJZ00XXWWS4ECTPBYPASS',
        scope: 'global',
        projectId: null,
        type: 'project',
        title: 'inserted behind the write path',
        content: 'no embedding, no entity links, no scan row',
        tags: [],
        status: 'active',
        replaces: [],
        createdAt: new Date(CORPUS_EPOCH_MS),
        lastSeenAt: new Date(CORPUS_EPOCH_MS),
        source: null,
        sessionId: null,
        topicKey: null,
      });

      const problems = derivedStateProblems(handle);
      expect(problems).not.toEqual([]);
      expect(problems.join('\n')).toMatch(/memory_vec/);
      expect(problems.join('\n')).toMatch(/memory_entity_scan/);
      expect(problems.join('\n')).toMatch(/no entity link/);
    } finally {
      handle.close();
    }
  });
});

describe('seed-volumetric is deterministic under a seed', () => {
  /** Generated content only: ULIDs and token secrets are minted by the write path, not the seed. */
  function corpusDigest(handle: ReturnType<typeof createDb>): string {
    const body = rows<{ s: string }>(
      handle,
      "SELECT group_concat(t, char(10)) s FROM (SELECT title || char(31) || content || char(31) || type || char(31) || scope || char(31) || status || char(31) || coalesce(topic_key,'') AS t FROM memory ORDER BY created_at, title)",
    )[0]!.s;
    const sessions = rows<{ s: string }>(
      handle,
      // No `cwd` column: the generated cwd reaches the row through
      // `computePlaceholderTitle`, so `title` is where it is observable.
      "SELECT group_concat(t, char(10)) s FROM (SELECT agent || char(31) || coalesce(summary,'') || char(31) || coalesce(title,'') || char(31) || coalesce(ended_at,'') AS t FROM sessions ORDER BY started_at, title)",
    )[0]!.s;
    const vectors = rows<{ s: string }>(
      handle,
      'SELECT group_concat(h, char(10)) s FROM (SELECT hex(embedding) h FROM memory_vec ORDER BY memory_id)',
    )[0]!.s;
    return createHash('sha256').update(`${body}\n${sessions}\n${vectors}`).digest('hex');
  }

  it('produces the same corpus twice from the same seed, and a different one from another', () => {
    const a = buildInto(tempDir(), { memories: 120, sessions: 40, seed: 42 });
    const b = buildInto(tempDir(), { memories: 120, sessions: 40, seed: 42 });
    const c = buildInto(tempDir(), { memories: 120, sessions: 40, seed: 43 });
    try {
      expect(a.result).toEqual({ ...b.result });
      expect(corpusDigest(a.handle)).toBe(corpusDigest(b.handle));
      // Without this the first assertion would pass on a generator that ignored
      // the seed entirely.
      expect(corpusDigest(c.handle)).not.toBe(corpusDigest(a.handle));
      // A non-empty digest, so the comparison is not two empty strings matching.
      expect(corpusDigest(a.handle)).not.toBe(createHash('sha256').update('\n\n').digest('hex'));
      expect(scalar(a.handle, 'SELECT COUNT(*) v FROM memory')).toBe(120);
    } finally {
      for (const x of [a, b, c]) x.handle.close();
    }
  });

  it('draws no randomness outside the seeded generator', () => {
    // Comments stripped first: the file legitimately NAMES `Math.random()` and
    // `Date.now()` in order to record why neither is used, and a test that
    // forbade the strings would delete the explanation.
    const executable = readFileSync(new URL('./seed-volumetric.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(executable).not.toMatch(/Math\.random|Date\.now\(\)|new Date\(\)/);
  });
});
