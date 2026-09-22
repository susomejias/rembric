import { AgentSessionsService } from '@rembric/core';
import {
  agentSessions,
  createRepositories,
  projects,
  tokens,
  type NewAgentSession,
} from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/sessions');

const PAGE_SIZE = 50;

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  t.handle.db
    .insert(projects)
    .values([{ id: 'p1', slug: 'proj-one', createdAt: new Date(500) }])
    .run();
  t.handle.db
    .insert(tokens)
    .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
    .run();
  t.handle.db
    .insert(agentSessions)
    .values([
      {
        id: 'S1',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'active',
        startedAt: new Date(1_000),
      },
      { id: 'S2', tokenId: 'tk1', agent: 'opencode', status: 'ended', startedAt: new Date(2_000) },
      {
        id: 'S3',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        projectId: 'p1',
        startedAt: new Date(3_000),
      },
      {
        id: 'S4',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(4_000),
      },
    ])
    .run();
});

afterEach(() => t.cleanup());

async function renderSessions(params: Record<string, string> = {}): Promise<string> {
  const page = (await import('../../app/dashboard/sessions/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

function sessionRow(html: string, id: string): string {
  const chunk = html.split('<tr').find((c) => c.includes(`/dashboard/sessions/${id}"`));
  if (chunk === undefined) throw new Error(`no row for session ${id}`);
  return chunk.split('</tr>')[0]!;
}

function timeCount(row: string): number {
  return (row.match(/data-rembric-ts/g) ?? []).length;
}

describe('sessions filter bar', () => {
  it('combined agent + status filter narrows rows, reports the slice, and labels every control', async () => {
    const html = await renderSessions({ agent: 'claude-code', status: 'ended' });
    expect(html).toContain('/dashboard/sessions/S3"');
    expect(html).toContain('/dashboard/sessions/S4"');
    expect(html).not.toContain('/dashboard/sessions/S1"');
    expect(html).not.toContain('/dashboard/sessions/S2"');
    expect(html).toContain('2 ROWS');
    expect(html).toContain('for="s-agent"');
    expect(html).toContain('>AGENT<');
    expect(html).toContain('for="s-status"');
    expect(html).toContain('>STATUS<');
    expect(html).toContain('for="s-project"');
    expect(html).toContain('>SCOPE<');
  });

  it('project scope filter narrows to that project only', async () => {
    const html = await renderSessions({ project: 'proj-one' });
    expect(html).toContain('/dashboard/sessions/S3"');
    expect(html).toContain('1 ROWS');
  });

  it('a bookmarked ?project=__global__ renders every row rather than a dead scope', async () => {
    const html = await renderSessions({ project: '__global__' });
    expect(html).toContain('/dashboard/sessions/S3"');
    expect(html).toContain('4 ROWS');
    expect(html).not.toContain('__global__');
  });

  it('unfiltered list reports the true total across all non-deleted rows', async () => {
    const html = await renderSessions();
    expect(html).toContain('4 ROWS');
  });

  it(`caps the page slice at PAGE_SIZE for ${PAGE_SIZE + 2} seeded rows`, async () => {
    const extra: NewAgentSession[] = Array.from({ length: PAGE_SIZE + 2 }, (_, i) => ({
      id: `X${i}`,
      tokenId: 'tk1',
      agent: 'test',
      status: 'ended',
      startedAt: new Date(5_000 + i),
    }));
    t.handle.db.insert(agentSessions).values(extra).run();

    const html = await renderSessions();
    expect(html).toContain(`${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} ROWS`);
  });

  it('the pager preserves active filter query params across pages', async () => {
    const extra: NewAgentSession[] = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `X${i}`,
      tokenId: 'tk1',
      agent: 'claude-code',
      status: 'ended',
      startedAt: new Date(5_000 + i),
    }));
    t.handle.db.insert(agentSessions).values(extra).run();

    const html = await renderSessions({ agent: 'claude-code', status: 'ended' });
    expect(html).toMatch(
      /href="\/dashboard\/sessions\?agent=claude-code&(?:amp;)?status=ended&(?:amp;)?page=1"/,
    );

    const sentinel = await renderSessions({ project: '__global__' });
    expect(sentinel).toMatch(/href="\/dashboard\/sessions\?page=1"/);
    expect(sentinel).not.toContain('__global__');
  });
});

describe('dashboard renders a resumed session as active', () => {
  const ENDED_AT = new Date(9_000);
  let svc: AgentSessionsService;

  beforeEach(() => {
    t.handle.db
      .insert(agentSessions)
      .values([
        {
          id: 'S-ENDED',
          tokenId: 'tk1',
          agent: 'test',
          status: 'ended',
          endedAt: ENDED_AT,
          startedAt: new Date(500),
        },
        {
          id: 'S-ABANDONED',
          tokenId: 'tk1',
          agent: 'test',
          status: 'abandoned',
          endedAt: ENDED_AT,
          startedAt: new Date(500),
        },
      ])
      .run();
    svc = new AgentSessionsService(createRepositories(t.handle.db), t.handle.db);
  });

  it('the Ended cell becomes the empty placeholder and the Abandon form returns', async () => {
    const before = sessionRow(await renderSessions(), 'S-ENDED');
    expect(timeCount(before)).toBe(2);
    expect(before).toContain('</span>ended</span>');
    expect(before).not.toContain('Abandon');

    svc.resume('S-ENDED', { tokenId: 'tk1' });

    const after = sessionRow(await renderSessions(), 'S-ENDED');
    expect(timeCount(after)).toBe(1);
    expect(after).toContain('</span>active</span>');
    expect(after).toContain('Abandon');
  });
});
