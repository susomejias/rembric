import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { MemoryService } from '../services/memory.js';
import { RELATION_ANNOTATION_MAX, RelationsService } from '../services/relations.js';
import { createTestDb, type TestDb } from '../test/db.js';
import { defaultProjectScope } from '../test/default-project.js';

/**
 * The pathological corpus, measured rather than reasoned about.
 *
 * The proposal's case for a response budget rests on an ARITHMETIC hypothesis
 * (~2.1 KB per judged annotation, ~20 MB pretty for 200 × 50, ~40 MB transported,
 * ~1.3 MB of scaffolding surviving with `reason` removed). This fixture builds the
 * corpus and measures the real bytes at the real projection, so the constants
 * follow the measurement rather than the estimate. Kept as a test, not a script,
 * so it stays re-runnable and reviewed.
 *
 * Sized to the requirement's worst legal request: `limit` 200 rows × the
 * `RELATION_ANNOTATION_MAX` per-row bound.
 */

const ROWS = 200;
const ANNOTATIONS_PER_ROW = RELATION_ANNOTATION_MAX;
/** The `memory.judge` / `memory.compare` schema cap, so `reason` is at its legal maximum. */
const REASON_CHARS = 2_000;

let t: TestDb;
let memory: MemoryService;
let relations: RelationsService;
let repos: ReturnType<typeof createRepositories>;
const pageIds: string[] = [];

// Realistic content lengths rather than minimal ones: the distribution a
// `memory.session_summary` produces, so the row scaffolding is not understated.
const CONTENT_LENGTHS = [420, 855, 1_400, 2_530, 4_100];

beforeAll(() => {
  t = createTestDb();
  repos = createRepositories(t.handle.db);
  let now = Date.UTC(2026, 0, 1);
  const clock = () => new Date((now += 1));
  memory = new MemoryService(repos, t.handle.db, clock);
  relations = new RelationsService(repos, t.handle.db, clock);

  const reason = 'r'.repeat(REASON_CHARS);
  const save = (i: number) =>
    memory.save(
      {
        type: 'project',
        title: `row ${i}`,
        content: `body ${i} `.repeat(Math.ceil(CONTENT_LENGTHS[i % CONTENT_LENGTHS.length]! / 8)),
      },
      defaultProjectScope(t.handle),
    ).id;

  for (let i = 0; i < ROWS; i += 1) {
    const id = save(i);
    pageIds.push(id);
    for (let j = 0; j < ANNOTATIONS_PER_ROW; j += 1) {
      const target = save(ROWS + i * ANNOTATIONS_PER_ROW + j);
      relations.compare({
        sourceId: id,
        targetId: target,
        relation: 'related',
        confidence: 0.87,
        reason,
        actor: 'test',
      });
    }
  }
}, 600_000);

afterAll(() => {
  t.cleanup();
});

/** Both copies `mcp/result.ts::ok()` emits, since one-copy figures understate the wire. */
function measure(payload: unknown): { pretty: number; compact: number; transported: number } {
  const compact = JSON.stringify(payload).length;
  const pretty = JSON.stringify(payload, null, 2).length;
  // `ok()` emits `content[0].text` (pretty) plus `structuredContent` (compact).
  return { pretty, compact, transported: pretty + compact };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

describe('annotation payload size at the worst legal request', () => {
  it('the corpus really is pathological', () => {
    const page = relations.listForMemories(pageIds, ANNOTATIONS_PER_ROW);
    expect(page.size).toBe(ROWS);
    const first = page.get(pageIds[0]!)!;
    expect(first.views).toHaveLength(ANNOTATIONS_PER_ROW);
    expect(first.total).toBeGreaterThanOrEqual(ANNOTATIONS_PER_ROW);
    expect(first.views.every((v) => v.status === 'judged')).toBe(true);
    expect(first.views.some((v) => v.reason?.length === REASON_CHARS)).toBe(true);
  });

  it('measures the annotation projection at 200 x 50, and with reason removed', () => {
    const full = relations.listForMemories(pageIds, ANNOTATIONS_PER_ROW);
    const annotations = [...full.values()].flatMap((p) => p.views);
    expect(annotations.length).toBe(ROWS * ANNOTATIONS_PER_ROW);

    const withReason = measure(annotations);
    const scaffolding = measure(
      annotations.map((v) => ({ ...v, reason: v.reason === undefined ? undefined : null })),
    );
    const at350 = measure(
      annotations.map((v) => ({
        ...v,
        reason: typeof v.reason === 'string' ? v.reason.slice(0, 349) + '…' : v.reason,
      })),
    );
    const defaultBound = measure(
      [...relations.listForMemories(pageIds, 10).values()].flatMap((p) => p.views),
    );

    console.log(
      [
        '',
        `annotations projected            : ${annotations.length}`,
        `verbatim reason  pretty/compact  : ${mb(withReason.pretty)} / ${mb(withReason.compact)}  transported ${mb(withReason.transported)}`,
        `per annotation (pretty)          : ${kb(withReason.pretty / annotations.length)}`,
        `reason removed (scaffolding only): ${mb(scaffolding.pretty)} pretty, transported ${mb(scaffolding.transported)}`,
        `reason bounded at 350            : ${mb(at350.pretty)} pretty, transported ${mb(at350.transported)}`,
        `shipped multi-row default (x10)  : ${mb(defaultBound.pretty)} pretty, transported ${mb(defaultBound.transported)}`,
        '',
      ].join('\n'),
    );

    // Non-vacuous: the measurement must be observing a real payload, not an empty one.
    expect(withReason.pretty).toBeGreaterThan(1_000_000);
    expect(scaffolding.pretty).toBeGreaterThan(0);
  });

  it('measures the POST-change worst case: the aggregate budget at several reason bounds', () => {
    // The budget is pinned to shipped behaviour (200 rows x the multi-row default
    // of 10 = 2 000 annotations), so it is not the knob that moves. This measures
    // what the reason bound has to do at that size, which is what chooses its value.
    const budgeted = [...relations.listForMemories(pageIds, 10).values()].flatMap((p) => p.views);
    expect(budgeted).toHaveLength(2_000);

    const rows: string[] = [];
    for (const bound of [Number.POSITIVE_INFINITY, 2_000, 700, 350, 200, 100, 0]) {
      const m = measure(
        budgeted.map((v) => ({
          ...v,
          reason:
            typeof v.reason === 'string' && Number.isFinite(bound)
              ? v.reason.length <= bound
                ? v.reason
                : v.reason.slice(0, Math.max(0, bound - 1)) + '…'
              : v.reason,
        })),
      );
      rows.push(
        `  reason bound ${String(Number.isFinite(bound) ? bound : 'verbatim').padStart(8)} -> ` +
          `${mb(m.pretty).padStart(8)} pretty, ${mb(m.transported).padStart(8)} transported`,
      );
    }
    console.log(['', 'AT THE BUDGET (2 000 annotations):', ...rows, ''].join('\n'));
    expect(budgeted.length).toBeGreaterThan(0);
  });

  it('measures the per-shape cost of one annotation, judged and pending', () => {
    // A pending annotation is produced by save-time detection, not by `compare` —
    // `pending_conflict` is a derived KIND, not a relation a caller can record.
    const judged = relations.listForMemories([pageIds[0]!], 1).get(pageIds[0]!)!.views[0]!;
    const pendingShape = {
      ...judged,
      status: 'pending' as const,
      reason: undefined,
      confidence: undefined,
    };
    console.log(
      [
        '',
        `one judged annotation, verbatim reason : ${measure(judged).pretty} chars pretty`,
        `one judged annotation, reason removed  : ${measure({ ...judged, reason: null }).pretty} chars pretty`,
        `one pending annotation (no reason)     : ${measure(pendingShape).pretty} chars pretty`,
        '',
      ].join('\n'),
    );
    expect(measure(judged).pretty).toBeGreaterThan(measure(pendingShape).pretty);
  });
});
