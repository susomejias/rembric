import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { RELATION_VALUES } from '../db/schema/memory-relations.js';
import { createTestDb, TestClock, type TestDb } from '../test/index.js';

import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import {
  ANNOTATION_TIER,
  compareAnnotations,
  RelationsService,
  type OrderedAnnotation,
} from './relations.js';
import { projectScope, type Scope } from './scope.js';

let db: TestDb;
let memory: MemoryService;
let relations: RelationsService;
let clock: TestClock;
let scope: Scope;

beforeEach(() => {
  db = createTestDb();
  const repos = createRepositories(db.handle.db);
  clock = new TestClock();
  memory = new MemoryService(repos, db.handle.db);
  relations = new RelationsService(repos, db.handle.db, clock.now);
  scope = projectScope(new ProjectsService(repos).create({ slug: 'annotations' }).id);
});

afterEach(() => db.cleanup());

function saveMemory(label: string): string {
  return memory.save({ type: 'project', title: label, content: label }, scope).id;
}

function orderKey(kind: OrderedAnnotation['view']['kind'], judgmentId: string, createdAt: Date) {
  return { view: { kind, targetId: 't', status: 'judged' as const }, judgmentId, createdAt };
}

describe('ANNOTATION_TIER', () => {
  it('covers every kind an annotation can carry, and only those', () => {
    const expected = [
      ...RELATION_VALUES.filter((v) => v !== 'not_conflict'),
      'superseded_by',
      'pending_conflict',
    ].sort();
    expect(Object.keys(ANNOTATION_TIER).sort()).toEqual(expected);
  });

  it('ranks the load-bearing kinds ahead of pendings, and pendings ahead of the informational tags', () => {
    expect(ANNOTATION_TIER.conflicts_with).toBeLessThan(ANNOTATION_TIER.supersedes);
    expect(ANNOTATION_TIER.supersedes).toBeLessThan(ANNOTATION_TIER.superseded_by);
    expect(ANNOTATION_TIER.superseded_by).toBeLessThan(ANNOTATION_TIER.pending_conflict);
    expect(ANNOTATION_TIER.pending_conflict).toBeLessThan(ANNOTATION_TIER.scoped);
    expect(ANNOTATION_TIER.scoped).toBeLessThan(ANNOTATION_TIER.compatible);
    expect(ANNOTATION_TIER.compatible).toBeLessThan(ANNOTATION_TIER.related);
  });
});

describe('compareAnnotations', () => {
  it('is a TOTAL order: same-millisecond rows never compare equal', () => {
    const ts = new Date('2026-03-01T12:00:00.123Z');
    const sameMs: OrderedAnnotation[] = [
      orderKey('related', 'j-05', ts),
      orderKey('related', 'j-01', ts),
      orderKey('conflicts_with', 'j-09', ts),
      orderKey('conflicts_with', 'j-02', ts),
      orderKey('pending_conflict', 'j-07', ts),
    ];

    for (const a of sameMs) {
      for (const b of sameMs) {
        if (a.judgmentId === b.judgmentId) continue;
        expect(compareAnnotations(a, b), `${a.judgmentId} vs ${b.judgmentId}`).not.toBe(0);
      }
    }

    const canonical = [...sameMs].sort(compareAnnotations).map((e) => e.judgmentId);
    expect(canonical).toEqual(['j-02', 'j-09', 'j-07', 'j-01', 'j-05']);
    // Every rotation of the input is a distinct starting permutation; all must converge.
    for (let i = 0; i < sameMs.length; i++) {
      const rotated = [...sameMs.slice(i), ...sameMs.slice(0, i)];
      expect(rotated.sort(compareAnnotations).map((e) => e.judgmentId)).toEqual(canonical);
    }
  });

  it('prefers the most recent judgment within one tier', () => {
    const older = orderKey('related', 'j-aaa', new Date('2026-03-01T00:00:00Z'));
    const newer = orderKey('related', 'j-zzz', new Date('2026-03-02T00:00:00Z'));
    expect([older, newer].sort(compareAnnotations).map((e) => e.judgmentId)).toEqual([
      'j-zzz',
      'j-aaa',
    ]);
  });
});

describe('annotation ordering under the bound', () => {
  /** 12 judged `related` rows written BEFORE a judged `conflicts_with`, so arrival order buries it. */
  function floodedMemory(): { id: string; conflictTargetId: string } {
    const id = saveMemory('the flooded memory');
    for (let i = 0; i < 12; i++) {
      relations.compare({
        sourceId: id,
        targetId: saveMemory(`related neighbour ${i}`),
        relation: 'related',
        confidence: 0.5,
        actor: 'test',
      });
      clock.advance(1);
    }
    const conflictTargetId = saveMemory('the contradiction');
    relations.compare({
      sourceId: id,
      targetId: conflictTargetId,
      relation: 'conflicts_with',
      confidence: 0.9,
      actor: 'test',
    });
    return { id, conflictTargetId };
  }

  it('a contradiction is not evicted by twelve informational edges', () => {
    const { id, conflictTargetId } = floodedMemory();

    const page = relations.listForMemories([id], 10).get(id);
    expect(page?.views).toHaveLength(10);
    expect(page?.views[0]).toMatchObject({ kind: 'conflicts_with', targetId: conflictTargetId });
    expect(page?.total).toBe(13);
    expect(page?.views.slice(1).every((v) => v.kind === 'related')).toBe(true);
  });

  it('the single-memory read agrees with the bulk read', () => {
    const { id } = floodedMemory();

    const single = relations.listForMemory(id, 10);
    const bulk = relations.listForMemories([id], 10).get(id);
    expect(single.views).toEqual(bulk?.views);
    expect(single.total).toBe(13);
  });

  it('raising the bound extends the list without reordering it', () => {
    const { id } = floodedMemory();

    const atDefault = relations.listForMemories([id], 10).get(id);
    const raised = relations.listForMemories([id], 25).get(id);
    expect(raised?.views).toHaveLength(13);
    expect(raised?.views.slice(0, 10)).toEqual(atDefault?.views);
    expect(raised?.views[0]?.kind).toBe('conflicts_with');
    expect(raised?.total).toBe(13);
  });

  it('a pending backlog cannot evict a judged supersedes', () => {
    const id = saveMemory('a busy memory');
    // Written first, so arrival order would lead with it inside the judged group.
    relations.compare({
      sourceId: id,
      targetId: saveMemory('an informational tag'),
      relation: 'related',
      confidence: 0.5,
      actor: 'test',
    });
    clock.advance(1);
    for (let i = 0; i < 20; i++) {
      relations.createPending({ sourceId: id, targetId: saveMemory(`candidate ${i}`) });
      clock.advance(1);
    }
    relations.compare({
      sourceId: id,
      targetId: saveMemory('the predecessor'),
      relation: 'supersedes',
      confidence: 0.9,
      actor: 'test',
    });

    const page = relations.listForMemories([id], 10).get(id);
    expect(page?.total).toBe(22);
    expect(page?.views[0]?.kind).toBe('supersedes');
    expect(page?.views.slice(1).every((v) => v.kind === 'pending_conflict')).toBe(true);
  });

  it('two reads of a truncated memory agree, including on a same-millisecond batch', () => {
    const id = saveMemory('judged in one transaction');
    // The clock never advances, so every row shares a created_at ms and only
    // `judgment_id` can decide the order.
    for (let i = 0; i < 15; i++) {
      relations.compare({
        sourceId: id,
        targetId: saveMemory(`batch neighbour ${i}`),
        relation: i === 0 ? 'conflicts_with' : 'related',
        confidence: 0.5,
        actor: 'test',
      });
    }

    const first = relations.listForMemories([id], 10).get(id);
    const second = relations.listForMemories([id], 10).get(id);
    expect(new Set(first?.views.map((v) => v.targetId)).size).toBe(10);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(relations.listForMemory(id, 10).views)).toBe(
      JSON.stringify(first?.views),
    );
  });
});

describe('the annotation total', () => {
  it('counts views rather than rows when both endpoints are on the page', () => {
    const a = saveMemory('endpoint a');
    const b = saveMemory('endpoint b');
    relations.compare({
      sourceId: a,
      targetId: b,
      relation: 'conflicts_with',
      confidence: 0.9,
      actor: 'test',
    });

    const pages = relations.listForMemories([a, b], 10);
    expect(pages.get(a)?.total).toBe(1);
    expect(pages.get(b)?.total).toBe(1);
    expect(pages.get(a)?.views[0]?.targetId).toBe(b);
    expect(pages.get(b)?.views[0]?.targetId).toBe(a);
  });

  it('excludes orphaned rows, which `listTouching` does not filter in SQL', () => {
    const id = saveMemory('has an orphan');
    const pending = relations.createPending({
      sourceId: id,
      targetId: saveMemory('unresolvable'),
    });
    relations.compare({
      sourceId: id,
      targetId: saveMemory('a live neighbour'),
      relation: 'related',
      confidence: 0.5,
      actor: 'test',
    });
    relations.orphan(pending.judgmentId, 'no confident verdict');

    const single = relations.listForMemory(id, 10);
    expect(single.views).toHaveLength(1);
    expect(single.total).toBe(1);
    expect(relations.listForMemories([id], 10).get(id)?.total).toBe(1);
  });

  it('equals the returned length when nothing was cut', () => {
    const id = saveMemory('three neighbours');
    for (let i = 0; i < 3; i++) {
      relations.compare({
        sourceId: id,
        targetId: saveMemory(`neighbour ${i}`),
        relation: 'related',
        confidence: 0.5,
        actor: 'test',
      });
    }
    const page = relations.listForMemories([id], 10).get(id);
    expect(page?.views).toHaveLength(3);
    expect(page?.total).toBe(3);
  });
});
