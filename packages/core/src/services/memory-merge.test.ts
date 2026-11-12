import {
  consolidationOps,
  consolidationRuns,
  createRepositories,
  memoryRelations,
  projectScope,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { undoOp } from '../consolidation/operations.js';
import { createTestDb, type TestDb, TestClock } from '../test-support/index.js';

import { DomainError } from './errors.js';
import { MERGE_MAX_IDS, type MergeMemoriesInput } from './memory-merge.js';
import { PREDECESSOR_CAP, MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { RelationsService } from './relations.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

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

afterEach(() => {
  db.cleanup();
});

function seed(
  title: string,
  extra: { topicKey?: string; type?: 'user' | 'feedback'; in?: Scope } = {},
): string {
  return memory.save(
    {
      type: extra.type ?? 'user',
      title,
      content: `${title} content`,
      topicKey: extra.topicKey ?? null,
    },
    extra.in ?? scope,
  ).id;
}

function mergeInput(ids: string[], extra: Partial<MergeMemoriesInput> = {}): MergeMemoriesInput {
  return {
    ids,
    type: 'user',
    title: 'Merged convention',
    content: 'The whole convention in one place.',
    tags: ['Naming Rules'],
    source: { tokenName: 'agent-token' },
    ...extra,
  };
}

function status(id: string): string {
  return memory.unsafeGetById(id)!.status;
}

function opRows() {
  return db.handle.db.select().from(consolidationOps).all();
}

function domainErrorOf(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

describe('MemoryService merge preview', () => {
  it('returns originals, the successor as stored and a fingerprint, and writes nothing', () => {
    const a = seed('a');
    const b = seed('b');
    const memoriesBefore = repos.memory.existingIds([a, b]).size;

    const preview = memory.previewMerge(mergeInput([a, b]), scope);

    expect(preview.originals.map((o) => o.id)).toEqual([a, b]);
    expect(preview.originals[0]).toMatchObject({
      title: 'a',
      contentPreview: 'a content',
      contentTruncated: false,
      reviewState: 'fresh',
    });
    expect(preview.successor).toEqual({
      type: 'user',
      title: 'Merged convention',
      content: 'The whole convention in one place.',
      tags: ['naming-rules'],
      topicKey: null,
      replaces: [a, b],
    });
    expect(preview.warnings).toEqual([]);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(status(a)).toBe('active');
    expect(status(b)).toBe('active');
    expect(opRows()).toEqual([]);
    expect(repos.memory.existingIds([a, b]).size).toBe(memoriesBefore);
  });

  it('bounds each original to a content preview', () => {
    const long = memory.save({ type: 'user', title: 'long', content: 'x'.repeat(1000) }, scope).id;
    const b = seed('b');

    const [original] = memory.previewMerge(mergeInput([long, b]), scope).originals;

    expect(original!.contentPreview).toHaveLength(300);
    expect(original!.contentTruncated).toBe(true);
  });

  it('is deterministic for the same inputs and state, and ignores last_seen_at', () => {
    const a = seed('a');
    const b = seed('b');
    const first = memory.previewMerge(mergeInput([a, b]), scope).fingerprint;
    clock.advance(1000);
    memory.recordAccess(a, scope);

    expect(memory.previewMerge(mergeInput([a, b]), scope).fingerprint).toBe(first);
    expect(memory.previewMerge(mergeInput([a, b], { title: 'Other' }), scope).fingerprint).not.toBe(
      first,
    );
  });

  it(`accepts 2..${MERGE_MAX_IDS} distinct ids and refuses anything else`, () => {
    expect(MERGE_MAX_IDS).toBe(PREDECESSOR_CAP);
    const ids = Array.from({ length: MERGE_MAX_IDS + 1 }, (_, i) => seed(`m${i}`));

    expect(
      memory.previewMerge(mergeInput(ids.slice(0, MERGE_MAX_IDS)), scope).originals,
    ).toHaveLength(MERGE_MAX_IDS);
    expect(domainErrorOf(() => memory.previewMerge(mergeInput(ids), scope)).code).toBe(
      'invalid_input',
    );
    expect(domainErrorOf(() => memory.previewMerge(mergeInput(ids.slice(0, 1)), scope)).code).toBe(
      'invalid_input',
    );
    expect(
      domainErrorOf(() => memory.previewMerge(mergeInput([ids[0]!, ids[0]!]), scope)).message,
    ).toContain('distinct');
  });

  it('refuses an id from another project as not found', () => {
    const a = seed('a');
    const foreign = seed('foreign', { in: otherScope });

    const err = domainErrorOf(() => memory.previewMerge(mergeInput([a, foreign]), scope));

    expect(err.code).toBe('memory_not_found');
    expect(err.details).toEqual({ ids: [foreign] });
  });

  it('refuses a non-active original as a conflict naming it', () => {
    const a = seed('a');
    const b = seed('b');
    memory.archive(b, scope);

    const err = domainErrorOf(() => memory.previewMerge(mergeInput([a, b]), scope));

    expect(err.code).toBe('conflict');
    expect(err.message).toContain(`${b} is 'archived'`);
  });

  it('runs the save validation on the successor', () => {
    const a = seed('a');
    const b = seed('b');

    const err = domainErrorOf(() =>
      memory.previewMerge(mergeInput([a, b], { content: '  ' }), scope),
    );
    expect(err.code).toBe('invalid_input');
    expect(err.message).toBe('memory.merge: content must be non-empty');
  });
});

describe('MemoryService merge topic_key rules', () => {
  it('inherits the single topic_key the originals hold', () => {
    const a = seed('a', { topicKey: 'conventions/naming' });
    const b = seed('b');

    expect(memory.previewMerge(mergeInput([a, b]), scope).successor.topicKey).toBe(
      'conventions/naming',
    );
  });

  it('refuses originals with different topic_keys until the caller names one', () => {
    const a = seed('a', { topicKey: 'conventions/naming' });
    const b = seed('b', { topicKey: 'conventions/layout' });

    const err = domainErrorOf(() => memory.previewMerge(mergeInput([a, b]), scope));
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ topicKeys: ['conventions/naming', 'conventions/layout'] });

    const preview = memory.previewMerge(
      mergeInput([a, b], { topicKey: 'conventions/naming' }),
      scope,
    );
    expect(preview.successor.topicKey).toBe('conventions/naming');
    expect(preview.warnings).toEqual([
      expect.objectContaining({ code: 'topic_keys_dropped', ids: [b] }),
    ]);
  });

  it('refuses a named topic_key held by an active memory outside ids', () => {
    const a = seed('a');
    const b = seed('b');
    const occupant = seed('occupant', { topicKey: 'conventions/naming' });

    const err = domainErrorOf(() =>
      memory.previewMerge(mergeInput([a, b], { topicKey: 'conventions/naming' }), scope),
    );

    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ occupiedBy: occupant });
    expect(status(occupant)).toBe('active');
  });
});

describe('MemoryService merge warnings', () => {
  it('flags needs_review originals', () => {
    const a = seed('a');
    clock.advance(13 * MONTH_MS);
    const b = seed('b');

    expect(memory.previewMerge(mergeInput([a, b]), scope).warnings).toEqual([
      expect.objectContaining({ code: 'needs_review', ids: [a] }),
    ]);
  });

  it('flags pending judgments touching an original', () => {
    const a = seed('a');
    const b = seed('b');
    const outsider = seed('outsider');
    relations.createPending({ sourceId: outsider, targetId: a });

    expect(memory.previewMerge(mergeInput([a, b]), scope).warnings).toEqual([
      expect.objectContaining({ code: 'pending_judgments', ids: [a] }),
    ]);
  });

  it('flags originals of another type than the successor', () => {
    const a = seed('a', { type: 'feedback' });
    const b = seed('b');

    expect(memory.previewMerge(mergeInput([a, b]), scope).warnings).toEqual([
      expect.objectContaining({ code: 'type_changed', ids: [a] }),
    ]);
  });
});

describe('MemoryService merge confirm', () => {
  it('commits with the preview fingerprint: successor active, originals superseded, one merge op', () => {
    const a = seed('a', { topicKey: 'conventions/naming' });
    const b = seed('b');
    const c = seed('c');
    const input = mergeInput([a, b, c]);
    const { fingerprint } = memory.previewMerge(input, scope);

    const result = memory.commitMerge(input, scope, fingerprint);

    expect(result.memory).toMatchObject({
      status: 'active',
      replaces: [a, b, c],
      topicKey: 'conventions/naming',
      tags: ['naming-rules'],
      projectId: scope.projectId,
    });
    expect([a, b, c].map(status)).toEqual(['superseded', 'superseded', 'superseded']);
    const ops = opRows();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      id: result.opId,
      opType: 'merge',
      affectedIds: [a, b, c],
      createdId: result.memory.id,
      reasoning: "agent merge of 3 memories by token 'agent-token'",
      revertedAt: null,
    });
    const run = db.handle.db
      .select()
      .from(consolidationRuns)
      .where(eq(consolidationRuns.id, ops[0]!.runId))
      .get();
    expect(run?.scope).toBe('maintenance');
  });

  it('writes nothing on a fingerprint from other arguments, and the matching control commits', () => {
    const a = seed('a');
    const b = seed('b');
    const stale = memory.previewMerge(mergeInput([a, b], { title: 'Draft' }), scope).fingerprint;

    const err = domainErrorOf(() => memory.commitMerge(mergeInput([a, b]), scope, stale));

    expect(err.code).toBe('fingerprint_mismatch');
    expect([a, b].map(status)).toEqual(['active', 'active']);
    expect(opRows()).toEqual([]);

    const fresh = (err.details as { preview: { fingerprint: string } }).preview.fingerprint;
    expect(fresh).toBe(memory.previewMerge(mergeInput([a, b]), scope).fingerprint);
    memory.commitMerge(mergeInput([a, b]), scope, fresh);
    expect([a, b].map(status)).toEqual(['superseded', 'superseded']);
  });

  it('writes nothing when an original changed since the preview', () => {
    const a = seed('a');
    const b = seed('b');
    const { fingerprint } = memory.previewMerge(mergeInput([a, b]), scope);
    const outsider = seed('outsider');
    relations.createPending({ sourceId: outsider, targetId: b });

    const err = domainErrorOf(() => memory.commitMerge(mergeInput([a, b]), scope, fingerprint));

    expect(err.code).toBe('fingerprint_mismatch');
    expect((err.details as { preview: { warnings: { code: string }[] } }).preview.warnings).toEqual(
      [expect.objectContaining({ code: 'pending_judgments' })],
    );
    expect([a, b].map(status)).toEqual(['active', 'active']);
    expect(opRows()).toEqual([]);
  });

  it('writes nothing when another pending judgment touches an already-warned original', () => {
    const a = seed('a');
    const b = seed('b');
    relations.createPending({ sourceId: seed('first'), targetId: b });
    const { fingerprint } = memory.previewMerge(mergeInput([a, b]), scope);
    relations.createPending({ sourceId: seed('second'), targetId: b });

    const err = domainErrorOf(() => memory.commitMerge(mergeInput([a, b]), scope, fingerprint));

    expect(err.code).toBe('fingerprint_mismatch');
    expect([a, b].map(status)).toEqual(['active', 'active']);
    expect(opRows()).toEqual([]);
  });

  it('writes no relations and carries no confirmations over', () => {
    const a = seed('a');
    const b = seed('b');
    memory.confirm(a, scope);
    const relationsBefore = db.handle.db.select().from(memoryRelations).all().length;
    const input = mergeInput([a, b]);

    const { memory: successor } = memory.commitMerge(
      input,
      scope,
      memory.previewMerge(input, scope).fingerprint,
    );

    expect(db.handle.db.select().from(memoryRelations).all()).toHaveLength(relationsBefore);
    expect(repos.memory.countConfirmations(successor.id)).toBe(0);
    expect(repos.memory.countConfirmations(a)).toBe(1);
  });

  it('makes the successor the head of every original in the history read', () => {
    const a = seed('a');
    const b = seed('b');
    const input = mergeInput([a, b]);
    const { memory: successor } = memory.commitMerge(
      input,
      scope,
      memory.previewMerge(input, scope).fingerprint,
    );

    for (const id of [a, b]) {
      const history = memory.get(id, scope)!;
      expect(history.memory.status).toBe('superseded');
      expect(history.head.id).toBe(successor.id);
    }
    expect(
      memory
        .get(successor.id, scope)!
        .predecessors.map((p) => p.id)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it('does not satisfy the sweep throttle of the project', () => {
    const a = seed('a');
    const b = seed('b');
    const input = mergeInput([a, b]);
    memory.commitMerge(input, scope, memory.previewMerge(input, scope).fingerprint);

    expect(repos.consolidation.recentRunExists(`project:${scope.projectId}`, 0)).toBe(false);
  });

  it('is undone by the existing undo path, topic_key slot included', () => {
    const a = seed('a', { topicKey: 'conventions/naming' });
    const b = seed('b');
    const input = mergeInput([a, b]);
    const { memory: successor, opId } = memory.commitMerge(
      input,
      scope,
      memory.previewMerge(input, scope).fingerprint,
    );

    const result = undoOp(repos, db.handle.db, opId);

    expect(result.skipped).toEqual([]);
    expect([a, b].map(status)).toEqual(['active', 'active']);
    expect(status(successor.id)).toBe('archived');
    expect(
      repos.memory.findActiveByTopicKey({
        projectId: scope.projectId,
        topicKey: 'conventions/naming',
      })?.id,
    ).toBe(a);
  });
});
