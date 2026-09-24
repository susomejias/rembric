import { AgentSessionsService } from '@rembric/core';
import {
  agentSessions,
  createRepositories,
  memory,
  projects,
  tokens,
  type NewAgentSession,
} from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/sessions');

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

// The client data-table renders each row's checkbox with an aria-label that
// carries the agent and the row title, which is the stable SSR hook per row.
function sessionRow(html: string, agent: string, title: string): string {
  const marker = `Select ${agent} session — ${title}"`;
  const chunk = html.split('<tr').find((c) => c.includes(marker));
  if (chunk === undefined) throw new Error(`no row for session ${marker}`);
  return chunk.split('</tr>')[0]!;
}

describe('sessions list (client data-table)', () => {
  it('renders every row, the status quick-filter pills and the search box', async () => {
    const html = await renderSessions();
    expect(html).toContain('Select claude-code session — S1"');
    expect(html).toContain('Select opencode session — S2"');
    expect(html).toContain('Select claude-code session — proj-one"');
    expect(html).toContain('Select claude-code session — S4"');
    expect(html).toContain('Filter by status');
    expect(html).toContain('Search sessions…');
    expect(html).toContain('1–4 of 4');
  });

  it('reports the totals subtitle with the active count', async () => {
    const html = await renderSessions();
    expect(html).toContain('4');
    expect(html).toContain('sessions');
    expect(html).toContain('active now');
  });

  it('exposes selection checkboxes and the per-row actions menu', async () => {
    const html = await renderSessions();
    expect(html).toContain('Select all rows on this page');
    expect(html).toContain('Select claude-code session — S1"');
    expect(html).toContain('Actions for session S1');
  });

  it('links the session title to its detail page with the judgments title styling', async () => {
    const html = await renderSessions();
    const row = sessionRow(html, 'claude-code', 'S1');
    expect(row).toContain(
      '<a href="/dashboard/sessions/S1" class="truncate text-sm font-medium text-foreground transition-colors hover:text-primary">S1</a>',
    );
    // The agent · project subtitle stays plain text, outside the link.
    expect(row).toContain(
      '<span class="truncate font-mono text-[11px] text-muted-foreground">claude-code',
    );
  });

  it('renders the memory sparkline when the session has writes in the window', async () => {
    t.handle.db
      .insert(memory)
      .values({
        id: 'M1',
        sessionId: 'S1',
        title: 'sparkline fixture',
        content: 'sparkline fixture content',
        scope: 'global',
        type: 'project',
        tags: [],
        status: 'active',
        replaces: [],
        createdAt: new Date(),
        lastSeenAt: new Date(),
      })
      .run();

    const html = await renderSessions();
    // The Memories cell renders the count plus the 14-bar sparkline container.
    expect(html).toContain('w-[52px]');
  });

  it('caps the client page at pageSize for 12 seeded rows', async () => {
    const extra: NewAgentSession[] = Array.from({ length: 8 }, (_, i) => ({
      id: `X${i}`,
      tokenId: 'tk1',
      agent: 'test',
      status: 'ended',
      startedAt: new Date(5_000 + i),
    }));
    t.handle.db.insert(agentSessions).values(extra).run();

    const html = await renderSessions();
    expect(html).toContain('1–10 of 12');
  });

  it('the show-deleted toggle keeps working through the URL', async () => {
    t.handle.db
      .update(agentSessions)
      .set({ deletedAt: new Date(9_000) })
      .run();

    const withoutDeleted = await renderSessions();
    const withDeleted = await renderSessions({ include_deleted: '1' });
    expect(withDeleted).toContain('Hide deleted');
    expect(withoutDeleted).not.toContain('Hide deleted');
    expect(withDeleted).toContain('Deleted');
  });

  it('a bookmarked ?project=__global__ renders every row rather than a dead scope', async () => {
    const html = await renderSessions({ project: '__global__' });
    expect(html).toContain('Select claude-code session — proj-one"');
    expect(html).not.toContain('__global__');
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

  it('the status pill flips to active and the actions menu stays available', async () => {
    const before = sessionRow(await renderSessions(), 'test', 'S-ENDED');
    expect(before).toContain('ended');
    expect(before).toContain('Actions for session S-ENDED');

    svc.resume('S-ENDED', { tokenId: 'tk1' });

    const after = sessionRow(await renderSessions(), 'test', 'S-ENDED');
    expect(after).toContain('active');
    expect(after).toContain('Actions for session S-ENDED');
  });
});
