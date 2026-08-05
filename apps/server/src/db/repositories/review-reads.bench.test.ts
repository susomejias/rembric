import type { Database } from 'better-sqlite3';
import { afterEach, describe, it } from 'vitest';

import { DEFAULT_DECAY } from '../../consolidation/decay.js';
import { REFUTED_PRIORITY_MS, reviewTtlEntries } from '../../services/review.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import type { MemoryType, NewMemory } from '../schema/memory.js';

import { MemoryRepository } from './memory-repository.js';
import { ProjectsRepository } from './projects-repository.js';

/**
 * Measurement harness for the four review-axis reads, each of which derives its
 * answer from a correlated subquery over `confirmations`. It prints numbers and
 * asserts nothing, so it is gated off by default and costs `pnpm test` nothing:
 *
 *   REMBRIC_BENCH=1 pnpm vitest run src/db/repositories/review-reads.bench.test.ts
 *   REMBRIC_BENCH=1 REMBRIC_BENCH_SIZES=1000,20000 REMBRIC_BENCH_REPEATS=31 …
 *   REMBRIC_BENCH=1 REMBRIC_BENCH_CONFIRMS=4 …
 *
 * Each index-set variant gets its own database, seeded identically, and samples
 * are interleaved variant-by-variant within every round. Measuring one variant
 * to completion before starting the next lets machine drift land entirely on one
 * arm, which at these effect sizes exceeds the effect.
 */

const ENABLED = process.env['REMBRIC_BENCH'] === '1';

function envNumbers(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(',')
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

const SIZES = envNumbers('REMBRIC_BENCH_SIZES', [1_000, 5_000, 20_000, 50_000]);
const REPEATS = envNumbers('REMBRIC_BENCH_REPEATS', [15])[0]!;
/** Confirmation events per memory, corpus average — fractional part included. */
const CONFIRMS_PER_MEMORY = envNumbers('REMBRIC_BENCH_CONFIRMS', [1.05])[0]!;
const WRITE_BENCH_INSERTS = 5_000;
const COUNT_CONFIRMATIONS_CALLS = 200;

const MEMORY_ID_IDX = 'confirmations_memory_id_idx';
const COMPOSITE_IDX = 'confirmations_memory_verdict_ts_idx';

const CONFIRMATION_INDEXES: Record<string, string> = {
  [MEMORY_ID_IDX]: `CREATE INDEX ${MEMORY_ID_IDX} ON confirmations (memory_id)`,
  confirmations_event_ts_idx: 'CREATE INDEX confirmations_event_ts_idx ON confirmations (event_ts)',
  confirmations_session_idx: 'CREATE INDEX confirmations_session_idx ON confirmations (session_id)',
  [COMPOSITE_IDX]: `CREATE INDEX ${COMPOSITE_IDX} ON confirmations (memory_id, verdict, event_ts)`,
};

interface Variant {
  label: string;
  indexes: string[];
}

const VARIANTS: Variant[] = [
  {
    label: 'before (3 idx)',
    indexes: [MEMORY_ID_IDX, 'confirmations_event_ts_idx', 'confirmations_session_idx'],
  },
  {
    label: 'composite added (4 idx)',
    indexes: [
      MEMORY_ID_IDX,
      'confirmations_event_ts_idx',
      'confirmations_session_idx',
      COMPOSITE_IDX,
    ],
  },
  {
    label: 'composite replaces memory_id (3 idx)',
    indexes: ['confirmations_event_ts_idx', 'confirmations_session_idx', COMPOSITE_IDX],
  },
];

const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference', 'procedural'];
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1);
const PROJECT_ID = 'proj-1';
/** A second project, so the scoped reads are measured against a non-empty out-of-scope population. */
const OTHER_PROJECT_ID = 'proj-2';

const BODY = [
  'The dashboard review counter derives its value at read time from the',
  'confirmations table, so the corpus body here is sized like a real memory',
  'rather than a two-character placeholder: a few hundred bytes of prose that',
  'push the row off the page the index entry lives on.',
].join(' ');

function memoryId(i: number): string {
  return `m-${String(i).padStart(7, '0')}`;
}

/** Deterministic, so each variant's database is identical bar its index set. */
function seedCorpus(t: TestDb, repo: MemoryRepository, size: number): void {
  const projectsRepo = new ProjectsRepository(t.handle.db);
  projectsRepo.insert({ id: PROJECT_ID, slug: 'bench', createdAt: new Date(NOW_MS) });
  projectsRepo.insert({ id: OTHER_PROJECT_ID, slug: 'bench-other', createdAt: new Date(NOW_MS) });
  const whole = Math.floor(CONFIRMS_PER_MEMORY);
  const fraction = CONFIRMS_PER_MEMORY - whole;
  const extraEveryNth = fraction > 0 ? Math.round(1 / fraction) : 0;
  t.handle.db.transaction(() => {
    for (let i = 0; i < size; i++) {
      const id = memoryId(i);
      // Ages spread across ~2 years so every per-type TTL and decay threshold
      // has rows on both sides of it.
      const createdAt = new Date(NOW_MS - ((i * 7919) % 730) * DAY_MS);
      const row: NewMemory = {
        id,
        title: `memory ${i}`,
        content: `${BODY} (${i})`,
        scope: 'project',
        projectId: i % 4 === 0 ? OTHER_PROJECT_ID : PROJECT_ID,
        type: TYPES[i % TYPES.length]!,
        tags: [],
        status: 'active',
        replaces: [],
        createdAt,
        lastSeenAt: new Date(createdAt.getTime() + ((i * 31) % 90) * DAY_MS),
      };
      repo.insert(row);

      const events = whole + (extraEveryNth > 0 && i % extraEveryNth === 0 ? 1 : 0);
      for (let k = 0; k < events; k++) {
        repo.insertConfirmation({
          id: `c-${id}-${k}`,
          memoryId: id,
          eventTs: new Date(createdAt.getTime() + ((i * 13 + k * 37) % 220) * DAY_MS),
          verdict: (i + k) % 12 === 0 ? 'refute' : 'affirm',
        });
      }
    }
  });
}

function applyIndexes(raw: Database, wanted: readonly string[]): void {
  for (const name of Object.keys(CONFIRMATION_INDEXES)) {
    raw.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  for (const name of wanted) {
    raw.exec(CONFIRMATION_INDEXES[name]!);
  }
  // Mirrors the boot-time ANALYZE in db/client.ts, so the planner sees the
  // statistics a running server would have rather than an empty sqlite_stat1.
  raw.pragma('analysis_limit = 1000');
  raw.exec('ANALYZE');
}

const decayThresholds = Object.entries(DEFAULT_DECAY.thresholdByType).filter(
  (e): e is [MemoryType, number] => typeof e[1] === 'number',
);

function reads(repo: MemoryRepository): Record<string, () => void> {
  const ttlByType = reviewTtlEntries();
  return {
    findNeedsReview: () => {
      repo.findNeedsReview({
        projectId: PROJECT_ID,
        nowMs: NOW_MS,
        limit: 3,
        ttlByType,
        refutedPriorityMs: REFUTED_PRIORITY_MS,
      });
    },
    countNeedsReview: () => {
      repo.countNeedsReview({ projectId: PROJECT_ID, nowMs: NOW_MS, ttlByType });
    },
    adminCountNeedsReview: () => {
      repo.adminCountNeedsReview({ nowMs: NOW_MS, ttlByType });
    },
    findDecayCandidateIds: () => {
      repo.findDecayCandidateIds({
        projectId: PROJECT_ID,
        nowMs: NOW_MS,
        thresholdByType: decayThresholds,
        defaultThresholdMs: DEFAULT_DECAY.defaultThresholdMs,
        confidenceFloor: DEFAULT_DECAY.confidenceFloor,
      });
    },
    'countConfirmations x200': () => {
      for (let i = 0; i < COUNT_CONFIRMATIONS_CALLS; i++) repo.countConfirmations(memoryId(i));
    },
  };
}

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Records the SQL a repository method actually executes, so the plans printed
 * below explain the real query instead of a reconstruction that could drift
 * from the private predicate builder.
 */
function capture(raw: Database, run: () => void): CapturedQuery[] {
  const sink: CapturedQuery[] = [];
  const bound = raw.prepare.bind(raw);

  const wrap = (stmt: object, sql: string): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        const method = value as (...a: unknown[]) => unknown;
        if (prop === 'all' || prop === 'get' || prop === 'run') {
          return (...params: unknown[]) => {
            sink.push({ sql, params });
            return method.apply(target, params);
          };
        }
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          // `raw()` / `pluck()` / `bind()` return the statement itself, and
          // drizzle reaches the terminal all/get/run through them.
          return result === target ? wrap(target, sql) : result;
        };
      },
    });

  // better-sqlite3 types `prepare` as generic over its row and parameter
  // tuples; the interceptor observes only SQL text and bound values, so the
  // generics are erased across this assignment.
  raw.prepare = ((sql: string) => wrap(bound(sql), sql)) as Database['prepare'];
  try {
    run();
  } finally {
    Reflect.deleteProperty(raw, 'prepare');
  }
  return sink;
}

function planOf(raw: Database, run: () => void): string {
  const seen = new Set<string>();
  return capture(raw, run)
    .filter(({ sql }) => !seen.has(sql) && seen.add(sql))
    .flatMap(({ sql, params }) =>
      raw
        .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((r) => r.detail),
    )
    .join(' | ');
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function printMarkdown(title: string, header: string[], rows: string[][]): void {
  console.log(
    [
      `\n### ${title}`,
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n'),
  );
}

describe.runIf(ENABLED)('review-axis read benchmark', () => {
  const open: TestDb[] = [];

  afterEach(() => {
    for (const t of open.splice(0)) t.cleanup();
  });

  function prepareVariants(
    size: number,
  ): { variant: Variant; repo: MemoryRepository; t: TestDb }[] {
    return VARIANTS.map((variant) => {
      const t = createTestDb();
      open.push(t);
      const repo = new MemoryRepository(t.handle.db);
      seedCorpus(t, repo, size);
      applyIndexes(t.handle.raw, variant.indexes);
      return { variant, repo, t };
    });
  }

  for (const size of SIZES) {
    it(`reads at ${size} active memories`, () => {
      const arms = prepareVariants(size);
      const runners = arms.map(({ repo }) => reads(repo));
      const caseNames = Object.keys(runners[0]!);
      const samples = arms.map(() => new Map<string, number[]>());
      for (const perArm of samples) for (const name of caseNames) perArm.set(name, []);

      for (const runner of runners) for (const name of caseNames) runner[name]!();

      for (let round = 0; round < REPEATS; round++) {
        for (const name of caseNames) {
          for (const [i] of arms.entries()) {
            const started = performance.now();
            runners[i]![name]!();
            samples[i]!.get(name)!.push(performance.now() - started);
          }
        }
      }

      printMarkdown(
        `${size} active memories · ${CONFIRMS_PER_MEMORY} confirmations/memory · median of ${REPEATS}`,
        ['read', ...arms.map((a) => a.variant.label), 'gain'],
        caseNames.map((name) => {
          const medians = samples.map((perArm) => median(perArm.get(name)!));
          const before = medians[0]!;
          return [
            name,
            ...medians.map((m) => `${m.toFixed(2)} ms`),
            `${(((before - medians[1]!) / before) * 100).toFixed(1)}%`,
          ];
        }),
      );

      for (const arm of arms) {
        console.log(`\n#### plans — ${arm.variant.label} @ ${size}`);
        for (const [name, run] of Object.entries(reads(arm.repo))) {
          console.log(`- ${name}: ${planOf(arm.t.handle.raw, run)}`);
        }
      }
    }, 900_000);
  }

  /**
   * The rewrite this change exists to reject: replace the two correlated
   * subqueries with grouped derived tables joined once. Hand-written because
   * the point is to measure the alternative the repository does NOT use.
   */
  function countNeedsReviewAsJoin(t: TestDb, nowMs: number): number {
    const ttlCase = reviewTtlEntries()
      .map(([type, ms]) => `WHEN m.type = '${type}' THEN ${ms}`)
      .join(' ');
    const baseline = `MAX(m.created_at, COALESCE(af.affirmed_at, m.created_at))`;
    const row = t.handle.raw
      .prepare<
        [number],
        { v: number }
      >(`SELECT COUNT(*) AS v FROM memory m LEFT JOIN (SELECT memory_id, MAX(event_ts) AS affirmed_at FROM confirmations WHERE verdict = 'affirm' GROUP BY memory_id) af ON af.memory_id = m.id LEFT JOIN (SELECT memory_id, MAX(event_ts) AS refuted_at FROM confirmations WHERE verdict = 'refute' GROUP BY memory_id) rf ON rf.memory_id = m.id WHERE m.status = 'active' AND m.scope = 'project' AND m.project_id = '${PROJECT_ID}' AND (((CASE ${ttlCase} ELSE NULL END) IS NOT NULL AND ${baseline} + (CASE ${ttlCase} ELSE NULL END) <= ?) OR (rf.refuted_at IS NOT NULL AND rf.refuted_at > ${baseline}))`)
      .get(nowMs);
    return row?.v ?? 0;
  }

  for (const size of SIZES) {
    it(`countNeedsReview: correlated subqueries vs a LEFT JOIN rewrite at ${size}`, () => {
      const arms = prepareVariants(size);
      const withComposite = arms[1]!;
      const ttlByType = reviewTtlEntries();
      const correlated = () =>
        withComposite.repo.countNeedsReview({
          projectId: PROJECT_ID,
          nowMs: NOW_MS,
          ttlByType,
        });
      const joined = () => countNeedsReviewAsJoin(withComposite.t, NOW_MS);

      // Equal answers or the comparison is meaningless.
      if (correlated() !== joined()) {
        throw new Error(`rewrite disagrees: ${correlated()} vs ${joined()}`);
      }

      const a: number[] = [];
      const b: number[] = [];
      correlated();
      joined();
      for (let round = 0; round < REPEATS; round++) {
        let started = performance.now();
        correlated();
        a.push(performance.now() - started);
        started = performance.now();
        joined();
        b.push(performance.now() - started);
      }
      printMarkdown(
        `countNeedsReview form · ${size} rows · ${CONFIRMS_PER_MEMORY} confirmations/memory · median of ${REPEATS}`,
        ['form', 'median', 'rows returned'],
        [
          [
            'correlated subqueries + composite index',
            `${median(a).toFixed(2)} ms`,
            `${correlated()}`,
          ],
          ['LEFT JOIN + GROUP BY derived tables', `${median(b).toFixed(2)} ms`, `${joined()}`],
        ],
      );
      console.log(`- join plan: ${planOf(withComposite.t.handle.raw, joined)}`);
    }, 900_000);
  }

  it(`confirmation insert throughput (${WRITE_BENCH_INSERTS} rows)`, () => {
    const size = 20_000;
    const arms = prepareVariants(size);
    const rows = arms.map(({ variant, repo, t }) => {
      const started = performance.now();
      t.handle.db.transaction(() => {
        for (let i = 0; i < WRITE_BENCH_INSERTS; i++) {
          repo.insertConfirmation({
            id: `w-${i}`,
            memoryId: memoryId(i % size),
            eventTs: new Date(NOW_MS + i),
            verdict: 'affirm',
          });
        }
      });
      return [variant.label, `${(performance.now() - started).toFixed(2)} ms`];
    });
    printMarkdown(
      `insertConfirmation — ${WRITE_BENCH_INSERTS} rows into a ${size}-memory corpus`,
      ['index set', 'total'],
      rows,
    );
  }, 900_000);
});
