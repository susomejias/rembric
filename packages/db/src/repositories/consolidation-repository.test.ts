import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConsolidationRepository } from '@rembric/db';

import { createTestDb, type TestDb } from '../test-support/db.js';

describe('ConsolidationRepository drain reads', () => {
  let t: TestDb;
  let repo: ConsolidationRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new ConsolidationRepository(t.handle.db);
  });

  afterEach(() => t.cleanup());

  function run(id: string, scope: string, startedAt: number, summary: string | null): void {
    repo.insertRun({ id, scope, startedAt: new Date(startedAt) });
    if (summary !== null) repo.finishRun(id, new Date(startedAt + 1), summary);
  }

  it("returns the latest finished run summary of the scope, never another scope's", () => {
    run('r1', 'project:p0', 1_000, '{"n":1}');
    run('r2', 'project:p0', 2_000, '{"n":2}');
    run('r3', 'project:p1', 3_000, '{"n":3}');
    run('r4', 'project:p0', 4_000, null);

    expect(repo.latestFinishedRunSummary('project:p0')).toBe('{"n":2}');
    expect(repo.latestFinishedRunSummary('project:p1')).toBe('{"n":3}');
    expect(repo.latestFinishedRunSummary('project:p2')).toBeNull();
  });

  it('lists the created ids of reverted orphan_promote ops only', () => {
    run('r1', 'project:p0', 1_000, '{}');
    const op = (id: string, opType: 'orphan_promote' | 'decay', createdId: string | null) =>
      repo.insertOp({
        id,
        runId: 'r1',
        opType,
        affectedIds: ['m1', 'm2'],
        createdId,
        reasoning: 'r',
        appliedAt: new Date(1_000),
      });
    op('o1', 'orphan_promote', 'J1');
    op('o2', 'orphan_promote', 'J2');
    op('o3', 'decay', 'J3');
    op('o4', 'orphan_promote', null);
    op('o5', 'orphan_promote', 'J1');
    for (const id of ['o1', 'o3', 'o4', 'o5']) repo.markReverted(id, new Date(2_000));

    expect(repo.listRevertedOrphanPromoteCreatedIds()).toEqual(['J1']);
  });
});
