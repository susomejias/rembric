import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveTitle } from '../../services/memory.js';
import { REVIEW_TTL_MS } from '../../services/review.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { agentSessions } from '../schema/agent-sessions.js';
import { memoryRelations } from '../schema/memory-relations.js';
import { memory, type MemoryType, type NewMemory } from '../schema/memory.js';
import { projects } from '../schema/projects.js';
import { tokens } from '../schema/tokens.js';

import { createRepositories, type Repositories } from './index.js';

/**
 * Dashboard list-page TOTALs read the true filtered count, not the page
 * slice (PAGE_SIZE = 10). Each scenario seeds MORE than the page size so a
 * regression to the slice count (capped at 10) would fail loudly.
 */

const ttlByType = Object.entries(REVIEW_TTL_MS).filter(
  (e): e is [MemoryType, number] => typeof e[1] === 'number',
);
// Far future so every ancient-createdAt active row is past its review TTL.
const FUTURE_MS = 4_000_000_000_000;

function mem(overrides: Partial<NewMemory> & { id: string; content: string }): NewMemory {
  return {
    title: deriveTitle(overrides.content),
    scope: 'project',
    projectId: 'p0',
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
    ...overrides,
  };
}

describe('admin list-page count methods', () => {
  let t: TestDb;
  let repos: Repositories;

  beforeEach(() => {
    t = createTestDb();
    repos = createRepositories(t.handle.db);

    t.handle.db
      .insert(projects)
      .values([
        { id: 'p0', slug: 'project-zero', createdAt: new Date(500) },
        { id: 'p1', slug: 'proj-one', createdAt: new Date(500) },
      ])
      .run();
    t.handle.db
      .insert(tokens)
      .values({ id: 'tk1', name: 'tok', hash: 'h', scope: '*', createdAt: new Date(500) })
      .run();

    // 12 active global memories matching FTS 'widget', + 1 active project row,
    // + 2 archived rows used as relation endpoints. Plus a superseded and an
    // archived 'widget' match so the FTS count must honour the status filter.
    const rows: NewMemory[] = [];
    for (let i = 0; i < 12; i++) rows.push(mem({ id: `G${i}`, content: `widget number ${i}` }));
    rows.push(mem({ id: 'PROJ', content: 'gadget one', projectId: 'p1' }));
    rows.push(mem({ id: 'RS', content: 'relation source', status: 'archived' }));
    rows.push(mem({ id: 'RT', content: 'relation target', status: 'archived' }));
    rows.push(mem({ id: 'WSUP', content: 'widget superseded', status: 'superseded' }));
    rows.push(mem({ id: 'WARC', content: 'widget archived', status: 'archived' }));
    t.handle.db.insert(memory).values(rows).run();

    // 12 visible sessions + 2 soft-deleted.
    const sessions = [];
    for (let i = 0; i < 12; i++)
      sessions.push({ id: `S${i}`, tokenId: 'tk1', agent: 'test', startedAt: new Date(1_000) });
    for (let i = 0; i < 2; i++)
      sessions.push({
        id: `SD${i}`,
        tokenId: 'tk1',
        agent: 'test',
        startedAt: new Date(1_000),
        deletedAt: new Date(2_000),
      });
    t.handle.db.insert(agentSessions).values(sessions).run();

    // 12 pending relations between the two archived endpoints.
    const rels = [];
    for (let i = 0; i < 12; i++)
      rels.push({
        id: `R${i}`,
        judgmentId: `J${i}`,
        sourceId: 'RS',
        targetId: 'RT',
        relation: null,
        status: 'pending' as const,
        createdAt: new Date(1_000),
      });
    t.handle.db.insert(memoryRelations).values(rels).run();

    // 12 consolidation runs.
    for (let i = 0; i < 12; i++)
      repos.consolidation.insertRun({ id: `RUN${i}`, startedAt: new Date(1_000), scope: 'global' });
  });

  afterEach(() => {
    t.cleanup();
  });

  it('memory.adminCount returns the true filtered count, not the page slice', () => {
    expect(repos.memory.adminCount({ status: 'active' })).toBe(13);
    expect(repos.memory.adminCount({ status: 'active', projectId: 'p0' })).toBe(12);
    expect(repos.memory.adminCount({ status: 'active', projectId: 'p1' })).toBe(1);
    expect(repos.memory.adminCount({ status: 'active', type: 'user' })).toBe(0);
    expect(repos.memory.adminCount({ status: 'archived' })).toBe(3);
  });

  it('memory.adminCountFts counts all matches in the filter set, not just the first page', () => {
    // 12 active 'widget' rows; the superseded/archived 'widget' matches are
    // excluded by the (default) active status filter, matching the list.
    expect(repos.memory.adminCountFts('widget', { status: 'active' })).toBe(12);
    expect(repos.memory.adminCountFts('zzznomatchzzz', { status: 'active' })).toBe(0);
  });

  it('memory.adminCountFts honours the status/scope filters the list applies', () => {
    expect(repos.memory.adminCountFts('widget', { status: 'superseded' })).toBe(1);
    expect(repos.memory.adminCountFts('widget', { status: 'archived' })).toBe(1);
    // 'gadget' is project-scoped only: global filter → 0, project filter → 1.
    expect(repos.memory.adminCountFts('gadget', { status: 'active', projectId: 'p0' })).toBe(0);
    expect(
      repos.memory.adminCountFts('gadget', {
        status: 'active',
        projectId: 'p1',
      }),
    ).toBe(1);
  });

  it('memory.adminCountNeedsReview counts aged active rows; empty TTL map → 0', () => {
    expect(repos.memory.adminCountNeedsReview({ nowMs: FUTURE_MS, ttlByType })).toBe(13);
    expect(repos.memory.adminCountNeedsReview({ nowMs: FUTURE_MS, ttlByType: [] })).toBe(0);
  });

  it('agentSessions.adminCount counts visible and deleted rows', () => {
    expect(repos.agentSessions.adminCount({ deleted: false })).toBe(12);
    expect(repos.agentSessions.adminCount({ deleted: true })).toBe(2);
  });

  it('relations.adminCountWithFilters counts the full filtered set', () => {
    expect(repos.relations.adminCountWithFilters({ status: 'pending' })).toBe(12);
    expect(repos.relations.adminCountWithFilters({ kind: 'pending' })).toBe(12);
    expect(repos.relations.adminCountWithFilters({ status: 'judged' })).toBe(0);
  });

  it('consolidation.adminCountRuns counts every run', () => {
    expect(repos.consolidation.adminCountRuns()).toBe(12);
  });
});
