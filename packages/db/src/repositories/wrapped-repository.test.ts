import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WrappedRepository, type MemoryType } from '@rembric/db';

import { agentSessions, memory, memoryRelations, projects, tokens } from '../schema/index.js';
import { createTestDb, type TestDb } from '../test-support/db.js';

const now = Date.UTC(2026, 5, 1);
const at = (month: number, day: number) => new Date(Date.UTC(2026, month, day));
let t: TestDb;
let repo: WrappedRepository;

beforeEach(() => {
  t = createTestDb();
  repo = new WrappedRepository(t.handle.db);
  t.handle.db
    .insert(projects)
    .values([
      { id: 'private-project-a', slug: 'secret-company', createdAt: at(0, 1) },
      { id: 'private-project-b', slug: 'secret-client', createdAt: at(0, 1) },
      { id: 'private-project-c', slug: 'excluded-project', createdAt: at(0, 1) },
    ])
    .run();
  t.handle.db
    .insert(tokens)
    .values({
      id: 'private-token',
      name: 'secret-token',
      hash: 'test',
      scope: '*',
      createdAt: at(0, 1),
    })
    .run();
});
afterEach(() => t.cleanup());

function seed() {
  t.handle.db
    .insert(memory)
    .values([
      {
        id: 'secret-memory-1',
        scope: 'project',
        projectId: 'private-project-a',
        type: 'reference',
        title: 'private title',
        content: 'private memory',
        tags: ['private-tag'],
        createdAt: at(0, 1),
      },
      {
        id: 'secret-memory-2',
        scope: 'project',
        projectId: 'private-project-a',
        type: 'reference',
        title: 'private title',
        content: 'private memory',
        status: 'archived',
        createdAt: at(0, 2),
      },
      {
        id: 'secret-memory-3',
        scope: 'global',
        type: 'project',
        title: 'private title',
        content: 'private memory',
        status: 'superseded',
        createdAt: at(0, 4),
      },
      {
        id: 'old',
        scope: 'global',
        type: 'project',
        title: 'private title',
        content: 'private memory',
        createdAt: new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999)),
      },
      {
        id: 'next-year',
        scope: 'global',
        type: 'project',
        title: 'private title',
        content: 'private memory',
        createdAt: new Date(Date.UTC(2027, 0, 1)),
      },
      {
        id: 'future',
        projectId: 'private-project-c',
        scope: 'project',
        type: 'project',
        title: 'private title',
        content: 'private memory',
        createdAt: new Date(now + 1),
      },
    ])
    .run();
  t.handle.db
    .insert(agentSessions)
    .values([
      {
        id: 'secret-session-1',
        tokenId: 'private-token',
        agent: 'claude-code',
        startedAt: at(0, 1),
      },
      {
        id: 'secret-session-2',
        tokenId: 'private-token',
        projectId: 'private-project-b',
        agent: 'pi',
        startedAt: at(0, 3),
        status: 'ended',
      },
      {
        id: 'secret-session-3',
        tokenId: 'private-token',
        agent: 'PrivateProjectTitle',
        title: 'secret session',
        summary: 'secret summary',
        startedAt: at(0, 4),
      },
      { id: 'secret-session-4', tokenId: 'private-token', agent: 'codex-cli', startedAt: at(1, 2) },
      {
        id: 'deleted',
        projectId: 'private-project-c',
        tokenId: 'private-token',
        agent: 'pi',
        startedAt: at(0, 5),
        deletedAt: at(0, 6),
      },
      {
        id: 'old-session',
        tokenId: 'private-token',
        agent: 'pi',
        startedAt: new Date(Date.UTC(2025, 11, 31)),
      },
      { id: 'future-session', tokenId: 'private-token', agent: 'pi', startedAt: new Date(now + 1) },
      {
        id: 'next-year-session',
        tokenId: 'private-token',
        agent: 'pi',
        startedAt: new Date(Date.UTC(2027, 0, 1)),
      },
    ])
    .run();
}

describe('WrappedRepository', () => {
  it('counts judgments by decision date, excludes pending/orphaned/undated/future rows and includes judgment-only years', () => {
    t.handle.db
      .insert(memory)
      .values(
        ['source', 'target'].map((id) => ({
          id,
          scope: 'global' as const,
          type: 'reference' as const,
          title: 'private title',
          content: 'private content',
          createdAt: new Date(Date.UTC(2023, 0, 1)),
        })),
      )
      .run();
    const decisions = [
      { id: 'start', status: 'judged' as const, judgedAt: at(0, 1) },
      { id: 'now', status: 'judged' as const, judgedAt: new Date(now) },
      { id: 'private-kind', status: 'judged' as const, judgedAt: new Date(now) },
      { id: 'future', status: 'judged' as const, judgedAt: new Date(now + 1) },
      { id: 'next-year', status: 'judged' as const, judgedAt: new Date(Date.UTC(2027, 0, 1)) },
      { id: 'before', status: 'judged' as const, judgedAt: new Date(Date.UTC(2026, 0, 1) - 1) },
      { id: 'older', status: 'judged' as const, judgedAt: new Date(Date.UTC(2024, 0, 1)) },
      { id: 'undated', status: 'judged' as const, judgedAt: null },
      { id: 'pending', status: 'pending' as const, judgedAt: at(0, 2) },
      { id: 'orphaned', status: 'orphaned' as const, judgedAt: at(0, 3) },
      {
        id: 'orphaned-year',
        status: 'orphaned' as const,
        judgedAt: new Date(Date.UTC(2022, 0, 1)),
      },
    ];
    t.handle.db
      .insert(memoryRelations)
      .values(
        decisions.map((row) => ({
          ...row,
          judgmentId: row.id,
          relation: (row.id === 'private-kind'
            ? 'private-kind'
            : row.id === 'now'
              ? 'conflicts_with'
              : 'supersedes') as typeof memoryRelations.$inferInsert.relation,
          sourceId: 'source',
          targetId: 'target',
          reason: 'private rationale',
          evidence: { secret: 'private evidence' },
          createdAt: new Date(Date.UTC(2023, 0, 1)),
        })),
      )
      .run();
    const data = repo.adminYear(2026, now);
    expect(data).toMatchObject({
      memories: 0,
      sessions: 0,
      judgments: 3,
      activeDays: 2,
      longestStreak: 1,
    });
    expect(data).toMatchObject({
      judgmentTypes: {
        supersedes: 1,
        conflicts_with: 1,
        compatible: 0,
        related: 0,
        scoped: 0,
        not_conflict: 0,
      },
    });
    expect(repo.adminYear(2025, now)).toMatchObject({ judgments: 1 });
    expect(repo.adminYear(2024, now)).toMatchObject({ judgments: 1 });
    expect(repo.adminYears(now)).toEqual([2026, 2025, 2024, 2023]);
    expect(JSON.stringify(data)).not.toMatch(/private|source|target|reason|evidence/);
  });

  it('counts retained statuses, excludes deleted/out-of-year/future events and deduplicates UTC days', () => {
    seed();
    const data = repo.adminYear(2026, now);
    expect(data).toMatchObject({
      year: 2026,
      yearToDate: true,
      memories: 3,
      sessions: 4,
      projects: 2,
      activeDays: 5,
      longestStreak: 4,
    });
    expect(data.months).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(data.types).toMatchObject({
      reference: 2,
      project: 1,
      user: 0,
      feedback: 0,
      procedural: 0,
    });
    expect(data.agents).toEqual([
      { agent: 'Claude Code', n: 1 },
      { agent: 'Codex CLI', n: 1 },
      { agent: 'Other', n: 1 },
      { agent: 'Pi', n: 1 },
    ]);
    expect(repo.adminYears(now)).toEqual([2026, 2025]);
  });

  it('never returns content, identifiers, names, source metadata or raw custom agents', () => {
    seed();
    t.handle.db
      .insert(memory)
      .values({
        id: 'legacy-private-type',
        scope: 'global',
        type: 'PrivateProjectTitle' as MemoryType,
        title: 'private title',
        content: 'private memory',
        createdAt: at(0, 1),
      })
      .run();
    const payload = JSON.stringify(repo.adminYear(2026, now));
    for (const secret of [
      'private',
      'secret',
      'PrivateProjectTitle',
      'title',
      'summary',
      'tags',
      'tokenId',
      'projectId',
      'sessionId',
      'content',
      'source',
    ])
      expect(payload).not.toContain(secret);
  });

  it('handles empty years and rejects invalid or future years', () => {
    const data = repo.adminYear(2025, now);
    expect(data).toMatchObject({
      memories: 0,
      sessions: 0,
      judgments: 0,
      projects: 0,
      activeDays: 0,
      longestStreak: 0,
      yearToDate: false,
      agents: [],
      days: [],
    });
    for (const year of [1969, 2027, 2026.5, NaN])
      expect(() => repo.adminYear(year, now)).toThrow(RangeError);
  });
});
