import {
  consolidationOps,
  consolidationRuns,
  createRepositories,
  memoryPinEvents,
  projectScope,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDecay, undoOp } from '../consolidation/operations.js';
import { createTestDb, type TestDb, TestClock } from '../test-support/index.js';

import { DomainError } from './errors.js';
import { MemoryService, PIN_MAX_PER_PROJECT } from './memory.js';
import { ProjectsService } from './projects.js';
import { RelationsService } from './relations.js';

const DAY = 86_400_000;
const AGENT = { cause: 'agent', name: 'agent-token' } as const;

let db: TestDb;
let repos: Repositories;
let clock: TestClock;
let memory: MemoryService;
let relations: RelationsService;
let scope: Scope;
let otherScope: Scope;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  repos = createRepositories(db.handle.db);
  const projects = new ProjectsService(repos, clock.now);
  memory = new MemoryService(repos, db.handle.db, clock.now);
  relations = new RelationsService(repos, db.handle.db, clock.now);
  scope = projectScope(projects.create({ slug: 'app' }).id);
  otherScope = projectScope(projects.create({ slug: 'other' }).id);
});

afterEach(() => db.cleanup());

function save(title: string, extra: { topicKey?: string; in?: Scope } = {}): string {
  clock.advance(1_000);
  return memory.save(
    { type: 'feedback', title, content: `${title} body`, topicKey: extra.topicKey ?? null },
    extra.in ?? scope,
  ).id;
}

const events = (memoryId: string) =>
  db.handle.db
    .select()
    .from(memoryPinEvents)
    .where(eq(memoryPinEvents.memoryId, memoryId))
    .orderBy(memoryPinEvents.id)
    .all();

const isPinned = (id: string) => memory.pinnedIdsAmong([id]).has(id);

function catchDomain(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

describe('pinning an active memory', () => {
  it('appends one pin event and derives pinned without touching the memory row', () => {
    const id = save('rule');
    const before = memory.unsafeGetById(id)!;

    clock.advance(1_000);
    const result = memory.setPinned(id, scope, true, AGENT);

    expect(result).toEqual({ id, pinned: true, changed: true, pinnedCount: 1 });
    expect(events(id)).toMatchObject([
      { action: 'pin', cause: 'agent', actor: 'agent-token', projectId: scope.projectId },
    ]);
    expect(isPinned(id)).toBe(true);
    expect(memory.unsafeGetById(id)).toEqual(before);
  });

  it('unpinning appends an unpin event and keeps the history in order', () => {
    const id = save('rule');
    memory.setPinned(id, scope, true, AGENT);

    const result = memory.setPinned(id, scope, false, { cause: 'operator', name: null });

    expect(result).toEqual({ id, pinned: false, changed: true, pinnedCount: 0 });
    expect(events(id).map((e) => [e.action, e.cause])).toEqual([
      ['pin', 'agent'],
      ['unpin', 'operator'],
    ]);
    expect(isPinned(id)).toBe(false);
  });

  it('a request that changes nothing appends nothing', () => {
    const id = save('rule');
    memory.setPinned(id, scope, true, AGENT);

    expect(memory.setPinned(id, scope, true, AGENT)).toEqual({
      id,
      pinned: true,
      changed: false,
      pinnedCount: 1,
    });
    const other = save('other');
    expect(memory.setPinned(other, scope, false, AGENT).changed).toBe(false);
    expect(events(id)).toHaveLength(1);
    expect(events(other)).toHaveLength(0);
  });

  it('lists the pins of the scope only, oldest pin first', () => {
    const a = save('a');
    const b = save('b');
    const foreign = save('foreign', { in: otherScope });
    memory.setPinned(b, scope, true, AGENT);
    clock.advance(1_000);
    memory.setPinned(a, scope, true, AGENT);
    memory.setPinned(foreign, otherScope, true, AGENT);

    expect(memory.listPinned(scope).map((p) => p.memory.id)).toEqual([b, a]);
    expect(memory.listPinned(otherScope).map((p) => p.memory.id)).toEqual([foreign]);
  });
});

describe('pin count bound', () => {
  it(`refuses the pin past ${PIN_MAX_PER_PROJECT}, naming every current pin, and appends nothing`, () => {
    const pinned = Array.from({ length: PIN_MAX_PER_PROJECT }, (_, i) => save(`rule ${i}`));
    for (const id of pinned) memory.setPinned(id, scope, true, AGENT);
    const extra = save('one too many');

    const err = catchDomain(() => memory.setPinned(extra, scope, true, AGENT));

    expect(err.code).toBe('pin_limit_reached');
    expect(err.details).toEqual({
      limit: PIN_MAX_PER_PROJECT,
      pinned: pinned.map((id, i) => ({ id, title: `rule ${i}` })),
    });
    expect(events(extra)).toHaveLength(0);

    memory.setPinned(pinned[0]!, scope, false, AGENT);
    expect(memory.setPinned(extra, scope, true, AGENT).pinned).toBe(true);
  });

  it('holds the published bound of ten pins per project', () => {
    expect(PIN_MAX_PER_PROJECT).toBe(10);
  });

  it('accepts pins up to the bound', () => {
    const ids = Array.from({ length: PIN_MAX_PER_PROJECT }, (_, i) => save(`rule ${i}`));
    for (const id of ids) memory.setPinned(id, scope, true, AGENT);
    expect(memory.countPinned(scope)).toBe(PIN_MAX_PER_PROJECT);
  });

  it("does not count another project's pins", () => {
    for (let i = 0; i < PIN_MAX_PER_PROJECT; i++) {
      memory.setPinned(save(`foreign ${i}`, { in: otherScope }), otherScope, true, AGENT);
    }
    expect(memory.setPinned(save('mine'), scope, true, AGENT).pinned).toBe(true);
  });
});

describe('pin guards', () => {
  it('a memory of another project is not found and nothing is appended', () => {
    const foreign = save('foreign', { in: otherScope });
    expect(catchDomain(() => memory.setPinned(foreign, scope, true, AGENT)).code).toBe(
      'memory_not_found',
    );
    expect(events(foreign)).toHaveLength(0);
  });

  it('a non-active memory conflicts and nothing is appended', () => {
    const archived = save('archived');
    memory.archive(archived, scope);
    const old = save('old', { topicKey: 'decision/x' });
    save('new', { topicKey: 'decision/x' });

    for (const id of [archived, old]) {
      expect(catchDomain(() => memory.setPinned(id, scope, true, AGENT)).code).toBe('conflict');
      expect(events(id)).toHaveLength(0);
    }
  });
});

describe('retirement releases the pin', () => {
  function releaseOf(id: string) {
    const last = events(id).at(-1)!;
    expect(last.action).toBe('unpin');
    expect(isPinned(id)).toBe(false);
    return last;
  }

  it('archive releases it under the run of its agent_memory_archive op', () => {
    const id = save('rule');
    memory.setPinned(id, scope, true, AGENT);

    memory.archive(id, scope);

    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'agent_memory_archive'))
      .get()!;
    expect(releaseOf(id)).toMatchObject({ cause: 'archive', runId: op.runId });
  });

  it('decay releases it under the sweep run', () => {
    const id = save('rule');
    memory.setPinned(id, scope, true, AGENT);
    const runId = 'decay-run';
    db.handle.db
      .insert(consolidationRuns)
      .values({ id: runId, startedAt: clock.now(), scope: `project:${scope.projectId}` })
      .run();

    applyDecay(repos, db.handle.db, { runId, ids: [id], reasoning: 'stale' });

    expect(releaseOf(id)).toMatchObject({ cause: 'decay', runId });
  });

  it('a supersedes verdict releases the target', () => {
    const target = save('target');
    const source = save('source');
    memory.setPinned(target, scope, true, AGENT);
    const { judgmentId } = relations.createPending({ sourceId: source, targetId: target });

    relations.judge(judgmentId, { relation: 'supersedes', actor: 'agent', kind: 'agent' });

    expect(releaseOf(target)).toMatchObject({ cause: 'supersedes verdict' });
  });

  it('a merge releases the originals and does not pin the successor', () => {
    const a = save('a');
    const b = save('b');
    memory.setPinned(a, scope, true, AGENT);
    const input = { ids: [a, b], type: 'feedback' as const, title: 'm', content: 'm', tags: [] };
    const { fingerprint } = memory.previewMerge(input, scope);

    const { memory: successorRow } = memory.commitMerge(input, scope, fingerprint);
    const successor = successorRow.id;

    expect(releaseOf(a)).toMatchObject({ cause: 'merge' });
    expect(events(b)).toHaveLength(0);
    expect(isPinned(successor)).toBe(false);
  });

  it('a merge undo releases a pinned successor', () => {
    const a = save('a');
    const b = save('b');
    const input = { ids: [a, b], type: 'feedback' as const, title: 'm', content: 'm', tags: [] };
    const { fingerprint } = memory.previewMerge(input, scope);
    const { memory: successorRow, opId } = memory.commitMerge(input, scope, fingerprint);
    const successor = successorRow.id;
    memory.setPinned(successor, scope, true, AGENT);

    undoOp(repos, db.handle.db, opId);

    expect(releaseOf(successor)).toMatchObject({ cause: 'merge undo' });
  });

  it('a retirement leaves an unpinned memory without events', () => {
    const id = save('rule');
    memory.archive(id, scope);
    expect(events(id)).toHaveLength(0);
  });
});

describe('topic_key upsert carries the pin', () => {
  it('moves the pin to the successor, net-zero even at the bound', () => {
    const fillers = Array.from({ length: PIN_MAX_PER_PROJECT - 1 }, (_, i) => save(`f${i}`));
    for (const id of fillers) memory.setPinned(id, scope, true, AGENT);
    const prior = save('runbook v1', { topicKey: 'decision/deploy-runbook' });
    memory.setPinned(prior, scope, true, AGENT);

    const next = save('runbook v2', { topicKey: 'decision/deploy-runbook' });

    expect(events(prior).at(-1)).toMatchObject({ action: 'unpin', cause: 'topic_key revision' });
    expect(events(next)).toMatchObject([{ action: 'pin', cause: 'topic_key revision' }]);
    expect(isPinned(prior)).toBe(false);
    expect(isPinned(next)).toBe(true);
    expect(memory.countPinned(scope)).toBe(PIN_MAX_PER_PROJECT);
  });

  it('an unpinned predecessor carries nothing', () => {
    save('runbook v1', { topicKey: 'decision/deploy-runbook' });
    const next = save('runbook v2', { topicKey: 'decision/deploy-runbook' });
    expect(events(next)).toHaveLength(0);
  });
});

describe('pins and the rest of the lifecycle', () => {
  it('undoing an archive restores the memory but not its pin', () => {
    const id = save('rule');
    memory.setPinned(id, scope, true, AGENT);
    memory.archive(id, scope);
    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'agent_memory_archive'))
      .get()!;

    undoOp(repos, db.handle.db, op.id);

    expect(memory.unsafeGetById(id)!.status).toBe('active');
    expect(isPinned(id)).toBe(false);
  });

  it('a pinned memory derives needs_review exactly as an unpinned one', () => {
    const pinned = save('pinned');
    const control = save('control');
    memory.setPinned(pinned, scope, true, AGENT);
    clock.advance(400 * DAY);

    const review = memory.reviewStateForMemories([
      memory.unsafeGetById(pinned)!,
      memory.unsafeGetById(control)!,
    ]);

    expect(review.get(control)!.reviewState).toBe('needs_review');
    expect(review.get(pinned)!.reviewState).toBe('needs_review');
  });

  it('a memory with a pin history is never purged', () => {
    const pinnedOnce = save('pinned once');
    const control = save('control');
    memory.setPinned(pinnedOnce, scope, true, AGENT);
    memory.setPinned(pinnedOnce, scope, false, AGENT);
    repos.memory.archiveActive([pinnedOnce, control]);

    const { deletedIds } = memory.purgeDisconnectedArchived({ adminBypass: true });

    expect(deletedIds).toEqual([control]);
    expect(memory.unsafeGetById(pinnedOnce)).toBeDefined();
    expect(events(pinnedOnce)).toHaveLength(2);
  });
});
