import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { RANK_WINDOW_CEILING } from '../services/hybrid-search.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import {
  ANNOTATION_PAYLOAD_CEILING_BYTES,
  ANNOTATION_REASON_CHARS,
  MULTI_ROW_ANNOTATION_DEFAULT,
  RELATION_ANNOTATION_MAX,
  RELATION_ANNOTATION_RESPONSE_BUDGET,
  RelationsService,
  SEARCH_LIMIT_MAX,
} from '../services/relations.js';
import { projectScope } from '../services/scope.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';

/** The `memory.judge` / `memory.compare` schema cap, so `reason` is at its legal maximum. */
const STORED_REASON = 'why-this-conflicts '.repeat(200).slice(0, 2_000);

let db: TestDb;
let memory: MemoryService;
let relations: RelationsService;
let repos: ReturnType<typeof createRepositories>;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let project: Project;

function fakeContext(p: Project): RequestContext {
  const token: Token = {
    id: 'tk_test',
    name: 'test-token',
    hash: 'hash',
    scope: '*',
    projectId: null,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  };
  return {
    token,
    scope: '*',
    memberProjectIds: [],
    project: p,
    requestedSlug: p.slug,
    mcpSessionId: null,
  };
}

function parse<T>(raw: unknown): T {
  const r = raw as { content: { text: string }[] };
  return JSON.parse(r.content[0]!.text) as T;
}

interface Row {
  id: string;
  relations: { targetId: string; reason?: string | null; status: string }[];
  relationsTotal: number;
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  let now = Date.UTC(2026, 0, 1);
  const clock = () => new Date((now += 1));
  memory = new MemoryService(repos, db.handle.db, clock);
  relations = new RelationsService(repos, db.handle.db, clock);
  const projects = new ProjectsService(repos, clock);
  project = projects.create({ slug: 'proj', displayName: 'P' });
  handlers = buildMemoryHandlers({ memory, relations, repos, projects });
});

afterEach(() => {
  db.cleanup();
});

function judgedPair(): { sourceId: string; targetId: string } {
  const scope = projectScope(project.id);
  const source = memory.save(
    { type: 'project', title: 'the source', content: 'the source memory content' },
    scope,
  );
  const target = memory.save(
    { type: 'project', title: 'the target', content: 'the target memory content' },
    scope,
  );
  relations.compare({
    sourceId: source.id,
    targetId: target.id,
    relation: 'conflicts_with',
    confidence: 0.9,
    reason: STORED_REASON,
    actor: 'test',
  });
  return { sourceId: source.id, targetId: target.id };
}

const read = async <T>(fn: () => unknown): Promise<T> =>
  runWithContext(fakeContext(project), async () => parse<T>(await fn()));

describe('the annotation reason is bounded on the multi-row surfaces only', () => {
  it('search and batch get truncate a 2000-char reason identically', async () => {
    const { sourceId } = judgedPair();
    const search = await read<{ memories: Row[] }>(() => handlers.search({}));
    const batch = await read<{ memories: Row[] }>(() => handlers.get({ ids: [sourceId] }));

    const fromSearch = search.memories.find((m) => m.id === sourceId)!.relations[0]!;
    const fromBatch = batch.memories[0]!.relations[0]!;

    expect(fromSearch.reason).toHaveLength(ANNOTATION_REASON_CHARS);
    expect(fromSearch.reason!.endsWith('…')).toBe(true);
    // The leading text is the stored prefix, so the truncation is a slice and not a
    // re-render of something else.
    expect(STORED_REASON.startsWith(fromSearch.reason!.slice(0, -1))).toBe(true);
    // Byte-identical between the two multi-row surfaces.
    expect(fromBatch).toEqual(fromSearch);
  });

  it('single-id memory.get returns the reason verbatim — it is the drill-down destination', async () => {
    const { sourceId } = judgedPair();
    const single = await read<Row>(() => handlers.get({ id: sourceId }));
    expect(single.relations[0]!.reason).toBe(STORED_REASON);
    expect(single.relations[0]!.reason).toHaveLength(2_000);
    expect(single.relations[0]!.reason!.includes('…')).toBe(false);
  });

  it('a reason shorter than the bound is unchanged, and a pending annotation is untouched', async () => {
    const scope = projectScope(project.id);
    const a = memory.save({ type: 'project', title: 'a', content: 'content a' }, scope);
    const b = memory.save({ type: 'project', title: 'b', content: 'content b' }, scope);
    relations.compare({
      sourceId: a.id,
      targetId: b.id,
      relation: 'related',
      confidence: 0.5,
      reason: 'short',
      actor: 'test',
    });
    const row = (await read<{ memories: Row[] }>(() => handlers.search({}))).memories.find(
      (m) => m.id === a.id,
    )!;
    expect(row.relations[0]!.reason).toBe('short');
    expect(row.relations[0]!.reason!.includes('…')).toBe(false);
  });

  it('the stored column still holds the full text after any number of reads', async () => {
    const { sourceId } = judgedPair();
    for (let i = 0; i < 3; i += 1) await read(() => handlers.search({}));
    const stored = relations.listForMemory(sourceId, RELATION_ANNOTATION_MAX);
    expect(stored.views[0]!.reason).toBe(STORED_REASON);
  });

  it('drift guard: every multi-row annotation surface bounds the reason', async () => {
    const { sourceId } = judgedPair();
    const surfaces: Record<string, Row | undefined> = {
      search: (await read<{ memories: Row[] }>(() => handlers.search({}))).memories.find(
        (m) => m.id === sourceId,
      ),
      batchGet: (await read<{ memories: Row[] }>(() => handlers.get({ ids: [sourceId] })))
        .memories[0],
    };
    for (const [name, row] of Object.entries(surfaces)) {
      expect(row, name).toBeDefined();
      // Non-vacuous: the fixture's stored reason exceeds the cap, so a surface that
      // forgot the helper would return 2 000 here rather than the bound.
      expect(row!.relations[0]!.reason, name).toHaveLength(ANNOTATION_REASON_CHARS);
    }
  });
});

describe('the aggregate annotation budget', () => {
  const overBudget = (rows: number, perRow: number) =>
    rows * perRow > RELATION_ANNOTATION_RESPONSE_BUDGET;

  it('is exactly the worst case the server already serves at defaults', () => {
    expect(RELATION_ANNOTATION_RESPONSE_BUDGET).toBe(
      RANK_WINDOW_CEILING * MULTI_ROW_ANNOTATION_DEFAULT,
    );
    // No request that omits `relations_limit` can be rejected, on EITHER branch —
    // the ranked one at its `limit` maximum, and the entity one at its page size.
    expect(overBudget(SEARCH_LIMIT_MAX, MULTI_ROW_ANNOTATION_DEFAULT)).toBe(false);
    expect(overBudget(RANK_WINDOW_CEILING, MULTI_ROW_ANNOTATION_DEFAULT)).toBe(false);
  });

  it('rejects the widest ask, naming both parameters and a legal trade', async () => {
    const raw = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(
        handlers.search({ limit: SEARCH_LIMIT_MAX, relations_limit: RELATION_ANNOTATION_MAX }),
      ),
    )) as { isError?: boolean; content: { text: string }[] };
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0]!.text) as { code: string; message: string };
    expect(body.code).toBe('invalid_input');
    expect(body.message).toContain('limit');
    expect(body.message).toContain('relations_limit');
    expect(body.message).toContain(String(RELATION_ANNOTATION_RESPONSE_BUDGET));
    // A legal combination, and the drill-down pointer.
    expect(body.message).toMatch(
      new RegExp(
        `lower limit to ${Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / RELATION_ANNOTATION_MAX)}`,
      ),
    );
    expect(body.message).toContain('memory.get');
    // Rejected, not partially served.
    expect(body).not.toHaveProperty('memories');
  });

  it('rejects the batch get equivalent on ids.length', async () => {
    const scope = projectScope(project.id);
    const ids = Array.from(
      { length: 100 },
      (_, i) => memory.save({ type: 'project', title: `m${i}`, content: `content ${i}` }, scope).id,
    );
    const raw = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(handlers.get({ ids, relations_limit: RELATION_ANNOTATION_MAX })),
    )) as { isError?: boolean; content: { text: string }[] };
    expect(raw.isError).toBe(true);
    const body = JSON.parse(raw.content[0]!.text) as { code: string; message: string };
    expect(body.code).toBe('invalid_input');
    expect(body.message).toContain('ids');
  });

  it('never rejects the defaults, and serves every legal trade', async () => {
    const scope = projectScope(project.id);
    for (let i = 0; i < 3; i += 1) {
      memory.save({ type: 'project', title: `m${i}`, content: `content ${i}` }, scope);
    }
    const legal: { limit?: number; relations_limit?: number }[] = [
      { limit: SEARCH_LIMIT_MAX },
      { limit: 8, relations_limit: RELATION_ANNOTATION_MAX },
      { limit: 40, relations_limit: RELATION_ANNOTATION_MAX },
      {},
    ];
    for (const args of legal) {
      const raw = (await runWithContext(fakeContext(project), () =>
        Promise.resolve(handlers.search(args)),
      )) as { isError?: boolean };
      expect(raw.isError, JSON.stringify(args)).toBeUndefined();
    }
  });

  it('the entity branch is budgeted by its EFFECTIVE page size, not by the declared limit', async () => {
    // Regression guard. The entity branch substitutes RANK_WINDOW_CEILING for an
    // omitted `limit`, so budgeting against the declared value (8) admitted
    // `{ entity, relations_limit: 50 }` and served 400 x 50 = 20 000 annotations —
    // twice the regression this bound exists to remove. Found by review, not here.
    const scope = projectScope(project.id);
    const m = memory.save(
      { type: 'project', title: 'entity row', content: 'a note about ENOENT' },
      scope,
    );
    repos.entities.linkMemory(
      m.id,
      project.id,
      [{ kind: 'error_code', value: 'ENOENT' }],
      new Date(),
    );

    const rejected = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(
        handlers.search({ entity: 'ENOENT', relations_limit: RELATION_ANNOTATION_MAX }),
      ),
    )) as { isError?: boolean; content: { text: string }[] };
    expect(rejected.isError).toBe(true);

    // And the pure-default entity search is still served, which is what forced the
    // budget to be derived from the branch's page size rather than from `limit`.
    const served = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(handlers.search({ entity: 'ENOENT' })),
    )) as { isError?: boolean };
    expect(served.isError).toBeUndefined();
    expect(overBudget(RANK_WINDOW_CEILING, MULTI_ROW_ANNOTATION_DEFAULT)).toBe(false);
    expect(overBudget(RANK_WINDOW_CEILING, RELATION_ANNOTATION_MAX)).toBe(true);
  });

  it('single-id memory.get is exempt by construction, not by a special case', async () => {
    // 1 x RELATION_ANNOTATION_MAX can never exceed the budget, so no check is needed
    // on that path — asserted rather than special-cased in the handler.
    expect(overBudget(1, RELATION_ANNOTATION_MAX)).toBe(false);
    const { sourceId } = judgedPair();
    const raw = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(handlers.get({ id: sourceId, relations_limit: RELATION_ANNOTATION_MAX })),
    )) as { isError?: boolean };
    expect(raw.isError).toBeUndefined();
  });

  it('a request inside the budget is served identically to one with no budget at all', async () => {
    const { sourceId } = judgedPair();
    const scope = projectScope(project.id);
    for (let i = 0; i < 5; i += 1) {
      memory.save({ type: 'project', title: `filler ${i}`, content: `filler ${i}` }, scope);
    }
    const served = await read<{ memories: Row[] }>(() =>
      handlers.search({ limit: 40, relations_limit: RELATION_ANNOTATION_MAX }),
    );
    // The budget admits or rejects; it never trims a served response.
    const row = served.memories.find((m) => m.id === sourceId)!;
    expect(row.relations).toHaveLength(1);
    expect(row.relationsTotal).toBe(1);
    expect(served.memories.length).toBeGreaterThan(1);
  });
});

/** Both copies `ok()` emits, over the annotation projection alone. */
function annotationBytes(rows: { relations: unknown[] }[]): number {
  const annotations = rows.flatMap((r) => r.relations);
  return JSON.stringify(annotations, null, 2).length + JSON.stringify(annotations).length;
}

describe('the worst legal annotation payload is a named, asserted ceiling', () => {
  it('every legal multi-row request stays under the ceiling, both emitted copies counted', async () => {
    const scope = projectScope(project.id);
    // The fixture must REACH the budget, not merely be large: an earlier version
    // built 12 rows x 50 = 600 annotations, so the guard measured a fifth of the
    // worst case and did not bite when the constants were raised. Sized from the
    // constants: `floor(budget / MAX)` rows, each saturated to `MAX`.
    const rowsAtMax = Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / RELATION_ANNOTATION_MAX);
    // Targets FIRST, annotated rows last: search returns the most recent, so building
    // the rows first made the page all targets — one annotation each, a fifth of the
    // budget, and a guard that measured slack.
    const targets = Array.from(
      { length: rowsAtMax * RELATION_ANNOTATION_MAX },
      (_, k) =>
        memory.save({ type: 'project', title: `t${k}`, content: 'y'.repeat(300) }, scope).id,
    );
    const rows: string[] = [];
    for (let i = 0; i < rowsAtMax; i += 1) {
      rows.push(
        memory.save({ type: 'project', title: `row ${i}`, content: 'x'.repeat(600) }, scope).id,
      );
    }
    for (const [i, id] of rows.entries()) {
      for (let j = 0; j < RELATION_ANNOTATION_MAX; j += 1) {
        relations.compare({
          sourceId: id,
          targetId: targets[i * RELATION_ANNOTATION_MAX + j]!,
          relation: 'related',
          confidence: 0.5,
          reason: STORED_REASON,
          actor: 'test',
        });
      }
    }

    const raw = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(
        handlers.search({ limit: rowsAtMax, relations_limit: RELATION_ANNOTATION_MAX }),
      ),
    )) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    expect(raw.isError).toBeUndefined();
    const body = JSON.parse(raw.content[0]!.text) as { memories: Row[] };
    const annotations = body.memories.flatMap((m) => m.relations);
    // Non-vacuous, and at the budget: anything less and the guard measures slack.
    expect(annotations.length).toBe(RELATION_ANNOTATION_RESPONSE_BUDGET);
    expect(annotations.every((a) => (a.reason ?? '').length <= ANNOTATION_REASON_CHARS)).toBe(true);
    // The ANNOTATION projection, not the whole result: unbounded `content` is
    // deliberately out of scope (design D8), and including it would make this
    // ceiling a function of how long the memories happen to be rather than of the
    // constants it exists to pin. `ok()` emits every payload twice, both counted.
    const transported = annotationBytes(body.memories);
    expect(transported, `${transported} annotation bytes`).toBeLessThanOrEqual(
      ANNOTATION_PAYLOAD_CEILING_BYTES,
    );
  }, 300_000);

  it('single-id memory.get, which keeps reason verbatim, is also under the ceiling', async () => {
    const scope = projectScope(project.id);
    const source = memory.save({ type: 'project', title: 'deep', content: 'z'.repeat(600) }, scope);
    for (let j = 0; j < RELATION_ANNOTATION_MAX; j += 1) {
      const target = memory.save(
        { type: 'project', title: `t${j}`, content: 'w'.repeat(300) },
        scope,
      );
      relations.compare({
        sourceId: source.id,
        targetId: target.id,
        relation: 'related',
        confidence: 0.5,
        reason: STORED_REASON,
        actor: 'test',
      });
    }
    const raw = (await runWithContext(fakeContext(project), () =>
      Promise.resolve(handlers.get({ id: source.id, relations_limit: RELATION_ANNOTATION_MAX })),
    )) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    expect(raw.isError).toBeUndefined();
    const body = JSON.parse(raw.content[0]!.text) as Row;
    expect(body.relations).toHaveLength(RELATION_ANNOTATION_MAX);
    // Verbatim here, which is exactly why the single-id surface needs measuring too.
    expect(body.relations[0]!.reason).toHaveLength(2_000);
    expect(annotationBytes([body])).toBeLessThanOrEqual(ANNOTATION_PAYLOAD_CEILING_BYTES);
  });
});

describe('the rendered tool schema teaches the joint bound', () => {
  it('both multi-row tools describe it, and every clause the published requirement mandates survives', async () => {
    const { memorySearchSchema, memoryGetSchema } = await import('./memory-tools.js');
    for (const [name, schema] of Object.entries({
      search: memorySearchSchema,
      get: memoryGetSchema,
    })) {
      const described = (schema as Record<string, { description?: string }>).relations_limit
        ?.description;
      expect(described, name).toBeDefined();
      // The joint bound this change adds.
      expect(described, name).toContain(String(RELATION_ANNOTATION_RESPONSE_BUDGET));
      expect(described, name).toMatch(/limited TOGETHER/);
      // Every clause the published requirement already mandated must still be there.
      expect(described, name).toMatch(/min\(relationsTotal, 50\)/);
      expect(described, name).toMatch(/REJECTED, not clamped/);
      expect(described, name).toContain('relationsTotal');
    }
  });
});
