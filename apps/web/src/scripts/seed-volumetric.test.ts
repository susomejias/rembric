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

import { MemoryService } from '@rembric/core';
import { createDb, createRepositories } from '@rembric/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { defaultProjectScope } from '../test/default-project.js';

import {
  CORPUS_EPOCH_MS,
  UsageError,
  VOLUMETRIC_SHAPE,
  type BuildResult,
  type VolumetricArgs,
  buildCorpus,
  generateMemory,
  generateVector,
  interleaveShares,
  normalizeDataDir,
  parseArgs,
  refuseTarget,
  scopeSlotFor,
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
      relations: 0,
      prompts: 0,
      seed: 1,
      skew: false,
    });
  });

  it('parses both axes and the seed independently', () => {
    expect(parseArgs(['--db', '/tmp/c', '--memories', '0', '--sessions', '50000'])).toMatchObject({
      memories: 0,
      sessions: 50000,
    });
    expect(parseArgs(['--db', '/tmp/c', '--seed', '7'])).toMatchObject({ seed: 7 });
    expect(parseArgs(['--db', '/tmp/c', '--skew'])).toMatchObject({ skew: true });
  });

  it('refuses --skew on a corpus too small to fill its thinnest project', () => {
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', '100', '--skew'])).toThrow(
      /--skew needs --memories at least 500/,
    );
    expect(parseArgs(['--db', '/tmp/c', '--memories', '500', '--skew'])).toMatchObject({
      skew: true,
    });
  });

  it('rejects non-integer and negative counts', () => {
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', 'lots'])).toThrow(UsageError);
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', '-1'])).toThrow(UsageError);
    expect(() => parseArgs(['--db', '/tmp/c', '--memories', '1.5'])).toThrow(UsageError);
    expect(() => parseArgs(['--db'])).toThrow(UsageError);
  });

  it.each(['--reset', '--force', '--wipe', '--yes'])('rejects the destructive flag %s', (flag) => {
    expect(() => parseArgs(['--db', '/tmp/c', flag])).toThrow(/never deletes/);
  });

  it('accepts either the directory or the data.db file as --db', () => {
    expect(normalizeDataDir('/tmp/corpus-50k')).toBe(resolve('/tmp/corpus-50k'));
    expect(normalizeDataDir('/tmp/corpus-50k/data.db')).toBe(resolve('/tmp/corpus-50k'));
  });
});

describe('seed-volumetric is structurally incapable of deleting', () => {
  const harnessSrc = readFileSync(new URL('./seed-volumetric.ts', import.meta.url), 'utf8');

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
    expect(harnessSrc).not.toMatch(/process\.env|REMBRIC_ALLOW/);
  });

  it('is absent from the DELETE allow-list in the invariant suite', () => {
    const invariants = readFileSync(new URL('../test/invariants.test.ts', import.meta.url), 'utf8');
    expect(invariants).not.toMatch(/seed-volumetric/);
    expect(invariants).toMatch(
      /allow:\s*\[\s*'packages\/db\/src\/repositories\/memory-repository\.ts',\s*'apps\/web\/src\/scripts\/seed-dev\.ts',\s*\]/,
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
      defaultProjectScope(handle),
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

const SHARED_MEMORIES = 480;
const SHARED_SESSIONS = 120;
const SHARED_RELATIONS = 240;
const SHARED_PROMPTS = 200;

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
      relations: SHARED_RELATIONS,
      prompts: SHARED_PROMPTS,
      seed: 1,
      skew: false,
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
    'prompts_fts',
    scalar(handle, 'SELECT COUNT(*) v FROM prompts_fts'),
    scalar(handle, 'SELECT COUNT(*) v FROM prompts'),
  );
  check(
    'memory_replaces',
    scalar(handle, 'SELECT COUNT(*) v FROM memory_replaces'),
    scalar(handle, "SELECT COUNT(*) v FROM memory WHERE status = 'superseded'"),
  );
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

  it('supersedes exactly the declared fraction, through real topic_key chains', () => {
    const superseded = scalar(handle, "SELECT COUNT(*) v FROM memory WHERE status = 'superseded'");
    expect(superseded / SHARED_MEMORIES).toBeCloseTo(VOLUMETRIC_SHAPE.supersededFraction, 5);
    expect(result.superseded).toBe(superseded);
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
    expect(mean).toBeGreaterThan(VOLUMETRIC_SHAPE.entitiesPerMemory * 0.9);
    expect(mean).toBeLessThanOrEqual(VOLUMETRIC_SHAPE.entitiesPerMemory);
  });

  it('hits the declared body-length percentiles with a long tail', () => {
    const lens = rows<{ L: number }>(handle, 'SELECT length(content) L FROM memory ORDER BY L').map(
      (r) => r.L,
    );
    const pct = (p: number) => lens[Math.floor((lens.length - 1) * p)]!;
    expect(pct(0.5)).toBeGreaterThan(VOLUMETRIC_SHAPE.bodyBytesP50 * 0.85);
    expect(pct(0.5)).toBeLessThan(VOLUMETRIC_SHAPE.bodyBytesP50 * 1.15);
    expect(pct(0.9)).toBeGreaterThan(VOLUMETRIC_SHAPE.bodyBytesP90 * 0.85);
    expect(pct(0.9)).toBeLessThan(VOLUMETRIC_SHAPE.bodyBytesP90 * 1.15);
    expect(pct(0.99)).toBeGreaterThan(VOLUMETRIC_SHAPE.bodyBytesP50 * 2.5);
  });

  it('writes the declared mean number of affirmations', () => {
    const confirmations = scalar(handle, 'SELECT COUNT(*) v FROM confirmations');
    const mean = confirmations / SHARED_MEMORIES;
    expect(mean).toBeGreaterThan(VOLUMETRIC_SHAPE.confirmationsPerMemory * 0.85);
    expect(mean).toBeLessThan(VOLUMETRIC_SHAPE.confirmationsPerMemory * 1.15);
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

  it('spreads relations over the declared status mix, within one scope', () => {
    const byStatus = Object.fromEntries(
      rows<{ status: string; n: number }>(
        handle,
        'SELECT status, COUNT(*) n FROM memory_relations GROUP BY status',
      ).map((r) => [r.status, r.n]),
    );
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const auditRows = scalar(
      handle,
      "SELECT COUNT(*) v FROM memory_relations WHERE marked_by_kind = 'agent_topic_key'",
    );
    expect(auditRows).toBe(SHARED_MEMORIES * VOLUMETRIC_SHAPE.supersededFraction);
    expect(total).toBe(SHARED_RELATIONS + auditRows);
    expect((byStatus['pending'] ?? 0) / SHARED_RELATIONS).toBeCloseTo(
      VOLUMETRIC_SHAPE.relationsPendingFraction,
      1,
    );
    expect((byStatus['orphaned'] ?? 0) / SHARED_RELATIONS).toBeLessThan(
      VOLUMETRIC_SHAPE.relationsOrphanedFraction + 0.08,
    );
    expect(byStatus['judged']).toBeGreaterThan(0);

    expect(
      scalar(
        handle,
        "SELECT COUNT(*) v FROM memory_relations r JOIN memory s ON s.id = r.source_id JOIN memory t ON t.id = r.target_id WHERE s.scope != t.scope OR IFNULL(s.project_id,'') != IFNULL(t.project_id,'')",
      ),
    ).toBe(0);
    expect(
      scalar(handle, 'SELECT COUNT(*) v FROM memory_relations WHERE source_id = target_id'),
    ).toBe(0);
  });

  it('judges `supersedes` exactly once per superseded memory, and never in the generated mix', () => {
    expect(
      scalar(handle, "SELECT COUNT(*) v FROM memory_relations WHERE relation = 'supersedes'"),
    ).toBe(SHARED_MEMORIES * VOLUMETRIC_SHAPE.supersededFraction);
    expect(
      scalar(
        handle,
        "SELECT COUNT(*) v FROM memory_relations WHERE relation = 'supersedes' AND marked_by_kind != 'agent_topic_key'",
      ),
    ).toBe(0);
    expect(scalar(handle, "SELECT COUNT(*) v FROM memory WHERE status = 'superseded'")).toBe(
      SHARED_MEMORIES * VOLUMETRIC_SHAPE.supersededFraction,
    );
  });

  it('stamps the declared share of memories with a session id', () => {
    const attached = scalar(handle, 'SELECT COUNT(*) v FROM memory WHERE session_id IS NOT NULL');
    expect(attached / SHARED_MEMORIES).toBeCloseTo(VOLUMETRIC_SHAPE.memoriesWithSessionFraction, 1);
    expect(
      scalar(
        handle,
        'SELECT COUNT(DISTINCT session_id) v FROM memory WHERE session_id IS NOT NULL',
      ),
    ).toBeGreaterThan(SHARED_SESSIONS / 2);
  });

  it('spreads prompts over every project and soft-deletes the declared share', () => {
    expect(scalar(handle, 'SELECT COUNT(*) v FROM prompts')).toBe(SHARED_PROMPTS);
    expect(scalar(handle, 'SELECT COUNT(*) v FROM prompts WHERE project_id IS NULL')).toBe(0);
    expect(scalar(handle, 'SELECT COUNT(DISTINCT project_id) v FROM prompts')).toBe(
      VOLUMETRIC_SHAPE.projectCount,
    );
    const deleted = scalar(handle, 'SELECT COUNT(*) v FROM prompts WHERE deleted_at IS NOT NULL');
    expect(deleted / SHARED_PROMPTS).toBeCloseTo(VOLUMETRIC_SHAPE.promptsDeletedFraction, 1);
    const lens = rows<{ L: number }>(
      handle,
      'SELECT length(content) L FROM prompts ORDER BY L',
    ).map((r) => r.L);
    const p50 = lens[Math.floor((lens.length - 1) * 0.5)]!;
    expect(p50).toBeGreaterThan(VOLUMETRIC_SHAPE.promptBytesP50 * 0.85);
    expect(p50).toBeLessThan(VOLUMETRIC_SHAPE.promptBytesP50 * 1.3);
  });

  it('populates every derived table consistently with its source', () => {
    expect(derivedStateProblems(handle)).toEqual([]);
  });
});

const SKEWED_MEMORIES = 600;

describe('seed-volumetric --skew builds one dominant project and several small ones', () => {
  const dir = tempDir();
  const { handle, result } = buildInto(dir, {
    memories: SKEWED_MEMORIES,
    sessions: 0,
    relations: 0,
    prompts: 0,
    skew: true,
  });
  afterAll(() => handle.close());

  it('realises the declared shares exactly', () => {
    expect(result.memoriesByScopeSlot).toEqual(
      VOLUMETRIC_SHAPE.skewShares.map((s) => s * SKEWED_MEMORIES),
    );
    const bySlug = Object.fromEntries(
      rows<{ slug: string; n: number }>(
        handle,
        'SELECT p.slug slug, COUNT(*) n FROM memory m JOIN projects p ON p.id = m.project_id GROUP BY p.slug',
      ).map((r) => [r.slug, r.n]),
    );
    expect(bySlug).toEqual({
      'vol-shared': 12,
      'vol-0': 360,
      'vol-1': 120,
      'vol-2': 60,
      'vol-3': 30,
      'vol-4': 18,
    });
  });

  it('spreads every project across the whole created_at span', () => {
    const span = rows<{ slug: string; lo: number; hi: number; total: number }>(
      handle,
      `SELECT p.slug slug, MIN(m.created_at) lo, MAX(m.created_at) hi,
              (SELECT MAX(created_at) - MIN(created_at) FROM memory) total
       FROM memory m JOIN projects p ON p.id = m.project_id GROUP BY p.slug`,
    );
    expect(span).toHaveLength(VOLUMETRIC_SHAPE.projectCount);
    for (const s of span) {
      expect(s.total).toBeGreaterThan(0);
      expect((s.hi - s.lo) / s.total).toBeGreaterThan(0.9);
    }
  });

  it('still supersedes the declared fraction, through real topic_key chains', () => {
    const superseded = scalar(handle, "SELECT COUNT(*) v FROM memory WHERE status = 'superseded'");
    const expected = result.memoriesByScopeSlot.reduce((n, m) => n + Math.floor((m + 3) / 5), 0);
    expect(superseded).toBe(expected);
    expect(superseded / SKEWED_MEMORIES).toBeCloseTo(VOLUMETRIC_SHAPE.supersededFraction, 2);
    expect(scalar(handle, 'SELECT COUNT(*) v FROM memory_replaces')).toBe(superseded);
  });

  it('populates every derived table consistently with its source', () => {
    expect(derivedStateProblems(handle)).toEqual([]);
    const byPartition = rows<{ n: number }>(
      handle,
      'SELECT COUNT(*) n FROM memory_vec GROUP BY partition_key ORDER BY n DESC',
    ).map((r) => r.n);
    expect(byPartition).toEqual([360, 120, 60, 30, 18, 12]);
  });
});

describe('seed-volumetric slot assignment', () => {
  it('interleaves shares exactly over one block, and orders slots by share', () => {
    const block = interleaveShares(VOLUMETRIC_SHAPE.skewShares, 100);
    const counts = VOLUMETRIC_SHAPE.skewShares.map((_, s) => block.filter((x) => x === s).length);
    expect(counts).toEqual(VOLUMETRIC_SHAPE.skewShares.map((s) => s * 100));
    expect(new Set(block).size).toBe(VOLUMETRIC_SHAPE.scopeCount);
    expect(block.slice(0, 24)).toEqual([
      1, 2, 1, 3, 1, 1, 2, 1, 4, 1, 1, 2, 1, 5, 1, 3, 1, 1, 2, 1, 1, 0, 1, 2,
    ]);
  });

  it('reproduces the even split when skew is off', () => {
    const even = Array.from({ length: 60 }, (_, i) => scopeSlotFor(i, false));
    expect(even).toEqual(Array.from({ length: 60 }, (_, i) => i % VOLUMETRIC_SHAPE.scopeCount));
  });

  it('generates the same memory with the slot ordinal omitted as with the even split value', () => {
    for (const i of [0, 1, 7, 41, 480]) {
      const slot = i % VOLUMETRIC_SHAPE.scopeCount;
      expect(generateMemory(20260805, i, slot)).toEqual(
        generateMemory(20260805, i, slot, Math.floor(i / VOLUMETRIC_SHAPE.scopeCount)),
      );
    }
  });
});

describe('seed-volumetric derived-state assertion can actually fail', () => {
  it('reports a memory inserted without the harness write path', () => {
    const dir = tempDir();
    const handle = createDb({ dataDir: dir });
    try {
      buildCorpus({
        handle,
        args: {
          dataDir: dir,
          memories: 60,
          sessions: 0,
          relations: 0,
          prompts: 0,
          seed: 1,
          skew: false,
        },
        log: () => {},
      });
      expect(derivedStateProblems(handle)).toEqual([]);

      const repos = createRepositories(handle.db);
      repos.memory.insert({
        id: '01JGFJJZ00XXWWS4ECTPBYPASS',
        scope: 'project',
        projectId: repos.projects.findDefault()!.id,
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
  function corpusDigest(handle: ReturnType<typeof createDb>): string {
    const body = rows<{ s: string }>(
      handle,
      "SELECT group_concat(t, char(10)) s FROM (SELECT title || char(31) || content || char(31) || type || char(31) || scope || char(31) || status || char(31) || coalesce(topic_key,'') AS t FROM memory ORDER BY created_at, title)",
    )[0]!.s;
    const sessions = rows<{ s: string }>(
      handle,
      "SELECT group_concat(t, char(10)) s FROM (SELECT agent || char(31) || coalesce(summary,'') || char(31) || coalesce(title,'') || char(31) || coalesce(ended_at,'') AS t FROM sessions ORDER BY started_at, title)",
    )[0]!.s;
    const vectors = rows<{ s: string }>(
      handle,
      'SELECT group_concat(h, char(10)) s FROM (SELECT hex(embedding) h FROM memory_vec ORDER BY memory_id)',
    )[0]!.s;
    const relations = rows<{ s: string }>(
      handle,
      "SELECT group_concat(t, char(10)) s FROM (SELECT status || char(31) || coalesce(relation,'') || char(31) || coalesce(reason,'') || char(31) || coalesce(confidence,'') AS t FROM memory_relations ORDER BY created_at, status, relation, reason, confidence)",
    )[0]!.s;
    const prompts = rows<{ s: string }>(
      handle,
      "SELECT group_concat(t, char(10)) s FROM (SELECT title || char(31) || content || char(31) || coalesce(agent,'') || char(31) || (deleted_at IS NOT NULL) AS t FROM prompts ORDER BY created_at, title)",
    )[0]!.s;
    return createHash('sha256')
      .update(`${body}\n${sessions}\n${vectors}\n${relations}\n${prompts}`)
      .digest('hex');
  }

  it('produces the same corpus twice from the same seed, and a different one from another', () => {
    const shape = { memories: 120, sessions: 40, relations: 60, prompts: 50 };
    const a = buildInto(tempDir(), { ...shape, seed: 42 });
    const b = buildInto(tempDir(), { ...shape, seed: 42 });
    const c = buildInto(tempDir(), { ...shape, seed: 43 });
    try {
      expect(a.result).toEqual({ ...b.result });
      expect(corpusDigest(a.handle)).toBe(corpusDigest(b.handle));
      expect(corpusDigest(c.handle)).not.toBe(corpusDigest(a.handle));
      expect(corpusDigest(a.handle)).not.toBe(
        createHash('sha256').update('\n\n\n\n').digest('hex'),
      );
      expect(scalar(a.handle, 'SELECT COUNT(*) v FROM memory_relations')).toBe(
        60 + 120 * VOLUMETRIC_SHAPE.supersededFraction,
      );
      expect(scalar(a.handle, 'SELECT COUNT(*) v FROM prompts')).toBe(50);
      expect(scalar(a.handle, 'SELECT COUNT(*) v FROM memory')).toBe(120);
    } finally {
      for (const x of [a, b, c]) x.handle.close();
    }
  });

  it('draws no randomness outside the seeded generator', () => {
    const executable = readFileSync(new URL('./seed-volumetric.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(executable).not.toMatch(/Math\.random|Date\.now\(\)|new Date\(\)/);
  });
});
