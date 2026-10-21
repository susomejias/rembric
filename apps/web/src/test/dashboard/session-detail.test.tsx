import { AgentSessionsService } from '@rembric/core';
import { agentSessions, createRepositories, memory, prompts, tokens } from '@rembric/db';
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDb } from '../db';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

import { DetailCopy } from '@/components/dashboard/detail-copy';
import { DetailExpand } from '@/components/dashboard/detail-expand';
import type { DetailShareData } from '@/components/dashboard/detail-image';
import { DetailImageCard } from '@/components/dashboard/detail-image-card';
import type { DetailLayout } from '@/components/dashboard/detail-layout';
import { DetailShare } from '@/components/dashboard/detail-share';
import { RowTooltip } from '@/components/dashboard/row-tooltip';
import { TooltipProvider } from '@/components/ui/tooltip';

installViewMocks('/dashboard/sessions');

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  t.handle.db
    .insert(tokens)
    .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
    .run();
  t.handle.db
    .insert(agentSessions)
    .values([
      {
        id: 'S-CURATED',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(500),
        description: 'seed goal here',
        summary: 'Goal: fix the bug.\n\n**Accomplished**: fixed it.\n\n> Evidence with spaces.',
        summaryFinal: true,
      },
      {
        id: 'S-RAW',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'ended',
        startedAt: new Date(500),
        description: 'seed goal here',
        summary: 'user: fix the bug\nassistant: **Fixed it.**',
        summaryFinal: false,
      },
      {
        id: 'S-EMPTY',
        tokenId: 'tk1',
        agent: 'claude-code',
        status: 'active',
        startedAt: new Date(500),
      },
    ])
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
  t.cleanup();
});

async function renderSessionDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
  return renderTimeline(await page({ params: Promise.resolve({ id }) }));
}

function descendants(
  node: ReactNode,
): ReactElement<{ children?: ReactNode; 'aria-label'?: string }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode; 'aria-label'?: string }>(child)
      ? [child, ...descendants(child.props.children)]
      : [],
  );
}

function renderTimeline(node: ReactNode) {
  return renderToHtml(<TooltipProvider>{node}</TooltipProvider>);
}

async function historyDetails(id: string) {
  const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
  const element: ReactElement<ComponentProps<typeof DetailLayout>> = await page({
    params: Promise.resolve({ id }),
  });
  const tooltips = descendants(element.props.secondary).filter(
    (child) => child.type === RowTooltip,
  );
  return renderTimeline(
    tooltips.map((tooltip, index) => (
      <div key={index}>{(tooltip.props as ComponentProps<typeof RowTooltip>).tooltip}</div>
    )),
  );
}

async function historyPresentation(id: string) {
  const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
  const element: ReactElement<ComponentProps<typeof DetailLayout>> = await page({
    params: Promise.resolve({ id }),
  });
  const history = descendants(element.props.secondary).find(
    (child) => child.props['aria-label'] === 'History',
  );
  if (!history) throw new Error('Missing History');
  const expansion = descendants(history).find((child) => child.type === DetailExpand);
  const html = await renderTimeline(history);
  if (!isValidElement<ComponentProps<typeof DetailExpand>>(expansion)) {
    return { html, expanded: html, compact: html, middle: '', preview: '' };
  }
  const middle = await renderTimeline(expansion.props.children);
  const preview = await renderTimeline(expansion.props.collapsedContent);
  return {
    html,
    expanded: preview ? html.replace(preview, '') : html,
    compact: html.replace(middle, ''),
    middle,
    preview,
  };
}

describe('session detail curation-state rendering', () => {
  it.each(['ended', 'active'])(
    'uses a recorded end time rather than the current clock for a %s duration',
    async (status) => {
      t.handle.raw
        .prepare('UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?')
        .run(61_500, status, 'S-CURATED');
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
      const element: ReactElement<ComponentProps<typeof DetailLayout>> = await page({
        params: Promise.resolve({ id: 'S-CURATED' }),
      });
      const share = descendants(element.props.primaryActions).find(
        (child) => child.type === DetailShare,
      );
      if (!isValidElement<ComponentProps<typeof DetailShare>>(share))
        throw new Error('Missing Share');
      expect(share.props.data.duration).toBe('01m 01s');
      expect(share.props.data.stats?.find((stat) => stat.label === 'duration')?.value).toBe(
        '01m 01s',
      );
      const html = await renderTimeline(element);
      expect(html).not.toContain('Running for');
    },
  );

  it.each([
    ['ended', false],
    ['abandoned', false],
    ['active', true],
  ] as const)(
    'does not invent a duration for %s with no end date and deleted=%s',
    async (status, deleted) => {
      t.handle.raw
        .prepare('UPDATE sessions SET status = ?, deleted_at = ? WHERE id = ?')
        .run(status, deleted ? 2_000 : null, 'S-EMPTY');
      vi.spyOn(Date, 'now').mockReturnValue(61_500);
      const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
      const element: ReactElement<ComponentProps<typeof DetailLayout>> = await page({
        params: Promise.resolve({ id: 'S-EMPTY' }),
      });
      const share = descendants(element.props.primaryActions).find(
        (child) => child.type === DetailShare,
      );
      if (!isValidElement<ComponentProps<typeof DetailShare>>(share))
        throw new Error('Missing Share');
      expect(share.props.data.duration).toBeUndefined();
      expect(share.props.data.stats?.find((stat) => stat.label === 'duration')?.value).toBe('—');
      const html = await renderTimeline(element);
      expect(html).not.toContain('Running for');
      expect(html).not.toContain('Still running');
      expect(html).not.toContain('01m 01s');
    },
  );

  it.each([100, 3_500])(
    'keeps History compact with dot details for out-of-run capture at %i',
    async (createdAt) => {
      t.handle.raw.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(3_000, 'S-CURATED');
      t.handle.db
        .insert(memory)
        .values({
          id: 'COMPACT',
          sessionId: 'S-CURATED',
          title: 'A complete event title',
          content: 'Body',
          type: 'project',
          tags: ['timeline-tag'],
          scope: 'project',
          status: 'superseded',
          replaces: [],
          createdAt: new Date(createdAt),
          lastSeenAt: new Date(createdAt),
        })
        .run();
      const { html } = await historyPresentation('S-CURATED');
      expect(html).toContain('data-slot="tooltip-trigger"');
      expect(html).toContain('aria-label="Details: A complete event title"');
      expect(html).toContain('block truncate leading-5');
      expect(html).not.toContain('ficha-history-meta');
      expect(html).not.toContain('Outside recorded run');
      expect(html).not.toContain('timeline-tag');
      expect(html).not.toContain('>Superseded<');
      expect(html).toContain('border-warn bg-warn');
      expect(html).toContain('border-foreground bg-background');
      expect(html).not.toContain('NO PROMPT WAS CAPTURED');
      expect(html).not.toContain('NO MEMORY WAS WRITTEN');
      const details = await historyDetails('S-CURATED');
      expect(details).toContain('A complete event title');
      expect(details).toContain('superseded');
      expect(details).toContain('timeline-tag');
      expect(details).toContain('Outside recorded run');
      expect(details).toContain('project');
      expect(details).toContain('token');
    },
  );

  it.each(['S-CURATED', 'S-RAW'])(
    'does not add a Summary heading to the session content for %s',
    async (id) => {
      const html = await renderSessionDetail(id);
      expect(html).not.toMatch(/<h[1-6][^>]*>Summary(?:<|\s)/);
      expect(html).toContain(id === 'S-RAW' ? 'RAW' : 'Accomplished');
    },
  );

  it.each(['S-CURATED', 'S-RAW', 'S-EMPTY'])(
    'shares complete normalized data and preserves the sole copy payload for %s',
    async (id) => {
      if (id === 'S-EMPTY') {
        t.handle.raw
          .prepare('UPDATE sessions SET title = ?, description = ? WHERE id = ?')
          .run('Named run', 'A distinct description', id);
      }
      const promptContent = 'Full original prompt '.repeat(12);
      t.handle.db
        .insert(prompts)
        .values({
          id: 'COPY-PROMPT',
          sessionId: id,
          title: 'Prompt',
          content: promptContent,
          createdAt: new Date(1_000),
        })
        .run();
      const original = createRepositories(t.handle.db).agentSessions.adminGetDetail(id)!;
      if (original.summary)
        t.handle.raw
          .prepare('UPDATE sessions SET summary = ? WHERE id = ?')
          .run(original.summary + '\n\n' + 'Complete summary text. '.repeat(100), id);
      const page = (await import('../../app/dashboard/sessions/[id]/page')).default;
      vi.spyOn(Date, 'now').mockReturnValue(61_500);
      const element: ReactElement<ComponentProps<typeof DetailLayout>> = await page({
        params: Promise.resolve({ id }),
      });
      const primary = element.props.primaryActions;
      if (!isValidElement<{ children: ReactNode }>(primary))
        throw new Error('Missing primary actions');
      const controls = Children.toArray(primary.props.children);
      const share = controls.find((child) => isValidElement(child) && child.type === DetailShare);
      const copies = controls.filter((child) => isValidElement(child) && child.type === DetailCopy);
      expect(copies).toHaveLength(1);
      if (!isValidElement<{ data: DetailShareData }>(share)) throw new Error('Missing Share');
      const row = createRepositories(t.handle.db).agentSessions.adminGetDetail(id)!;
      const data = share.props.data;
      expect(data).toEqual({
        kind: 'session',
        label: 'Session',
        title: row.title ?? row.description ?? id,
        date: row.startedAt,
        byline: 'Run by claude-code',
        projectName: '—',
        content: {
          text: row.summary ?? row.description ?? '',
          mode: row.summary && !row.summaryFinal ? 'literal' : 'markdown',
          label: 'Full summary',
        },
        duration: row.status === 'active' ? '01m 01s' : undefined,
        stats: [
          { label: 'memories', value: '0' },
          { label: 'prompts', value: '1' },
          { label: 'duration', value: row.status === 'active' ? '01m 01s' : '—' },
        ],
      });
      const copy = copies[0];
      if (!isValidElement<{ text: string }>(copy)) throw new Error('Missing Copy');
      expect(copy.props.text).toBe(
        [
          `# ${row.title ?? row.description ?? id}`,
          '',
          row.description ? `${row.description}\n` : '',
          row.summary && row.summaryFinal ? `## Summary\n\n${row.summary}` : '',
          '## Run\n\nAgent `claude-code` · started 1970-01-01T00:00:00.500Z · status ' +
            row.status +
            '.',
          `## Prompts captured\n\n- ${promptContent.slice(0, 120)}`,
        ]
          .filter((part) => part !== '')
          .join('\n'),
      );
      const on = await renderToHtml(
        <DetailImageCard
          data={data}
          options={{ content: true, project: true, stats: true }}
          logo="/logo.png"
        />,
      );
      const off = await renderToHtml(
        <DetailImageCard
          data={data}
          options={{ content: true, project: true, stats: false }}
          logo="/logo.png"
        />,
      );
      expect(on).toContain('detail-image-stats');
      if (data.duration) expect(on).toContain(` · ${data.duration}`);
      expect(off).not.toContain('detail-image-stats');
      if (data.duration) expect(off).not.toContain(` · ${data.duration}`);
      if (id === 'S-RAW') {
        expect(on).toContain('detail-image-literal');
        expect(on).toContain('**Fixed it.**');
      }
    },
  );

  it('merges captures into chronological History without moving out-of-run dates or hiding run boundaries', async () => {
    t.handle.raw.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(3_000, 'S-CURATED');
    const times = [500, 100, 1_000, 1_500, 2_000, 2_500, 3_500];
    t.handle.db
      .insert(memory)
      .values(
        times.map((time, i) => ({
          id: `M-${i}`,
          sessionId: 'S-CURATED',
          title: `Memory ${i}`,
          content: 'Body',
          type: 'project' as const,
          tags: ['durable'],
          scope: 'project' as const,
          status: 'active' as const,
          replaces: [],
          createdAt: new Date(time),
          lastSeenAt: new Date(time),
        })),
      )
      .run();
    t.handle.db
      .insert(prompts)
      .values([
        {
          id: 'P-START',
          sessionId: 'S-CURATED',
          title: 'Start prompt',
          content: 'Start excerpt',
          tags: ['request'],
          createdAt: new Date(500),
        },
        {
          id: 'P-END',
          sessionId: 'S-CURATED',
          title: 'End prompt',
          content: 'End excerpt',
          createdAt: new Date(3_000),
        },
      ])
      .run();
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain('aria-label="History"');
    const history = html.slice(
      html.indexOf('aria-label="History"'),
      html.indexOf('aria-label="Properties"'),
    );
    expect(history).toContain('7 memories');
    expect(history).toContain('2 prompts');
    expect(history).toContain('aria-label="Show 4 more events" aria-expanded="false"');
    expect(await historyDetails('S-CURATED')).toContain('Outside recorded run');
    const { expanded, compact, middle } = await historyPresentation('S-CURATED');
    const ordered = [
      'Memory 1',
      'Started',
      'Memory 0',
      'Start prompt',
      'Memory 2',
      'Memory 3',
      'Memory 4',
      'Memory 5',
      'End prompt',
      'Ended',
      'Memory 6',
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(expanded.indexOf(ordered[i - 1]!)).toBeLessThan(expanded.indexOf(ordered[i]!));
    }
    expect(compact.match(/href="\/dashboard\/(?:memories|prompts)\//g)).toHaveLength(5);
    expect(middle.match(/href="\/dashboard\/(?:memories|prompts)\//g)).toHaveLength(4);
    for (let i = 0; i < 7; i++) {
      expect(history.match(new RegExp(`href="/dashboard/memories/M-${i}"`, 'g'))).toHaveLength(1);
    }
    expect(history).toContain('dateTime="1970-01-01T00:00:00.100Z"');
    expect(history).toContain('dateTime="1970-01-01T00:00:03.500Z"');
    const details = await historyDetails('S-CURATED');
    expect(details).toContain('durable');
    expect(details).toContain('request');
    expect(details).toContain('Start excerpt');
    expect(details).toContain('End excerpt');
    expect(html).not.toContain('<table');
  });
  it('keeps 100 memories plus prompts compact with first two and last three captures around one middle expansion', async () => {
    t.handle.raw
      .prepare('UPDATE sessions SET started_at = ?, ended_at = ?, deleted_at = ? WHERE id = ?')
      .run(3_500, 98_500, 50_500, 'S-CURATED');
    t.handle.db
      .insert(memory)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          id: `BULK-${i}`,
          sessionId: 'S-CURATED',
          title: `Capture ${i}`,
          content: 'Body',
          type: 'project' as const,
          tags: [`tag-${i}`],
          scope: 'project' as const,
          status: 'active' as const,
          replaces: [],
          createdAt: new Date(1_000 + i * 1_000),
          lastSeenAt: new Date(1_000),
        })),
      )
      .run();
    t.handle.db
      .insert(prompts)
      .values([
        {
          id: 'BULK-PROMPT-1',
          sessionId: 'S-CURATED',
          title: 'Prompt at first tie',
          content: 'First prompt excerpt',
          tags: ['request'],
          createdAt: new Date(1_000),
        },
        {
          id: 'BULK-PROMPT-2',
          sessionId: 'S-CURATED',
          title: 'Prompt at last tie',
          content: 'Last prompt excerpt',
          createdAt: new Date(100_000),
        },
      ])
      .run();
    const {
      html: history,
      expanded,
      compact,
      middle,
      preview,
    } = await historyPresentation('S-CURATED');
    expect(history).toContain('100 memories');
    expect(history).toContain('2 prompts');
    expect(history.match(/aria-label="Show 97 more events"/g)).toHaveLength(1);
    expect(history).toContain('aria-expanded="false"');
    expect(history.match(/href="\/dashboard\/memories\/BULK-/g)).toHaveLength(100);
    expect(history.match(/href="\/dashboard\/prompts\/BULK-PROMPT-/g)).toHaveLength(2);
    const details = await historyDetails('S-CURATED');
    for (let i = 0; i < 100; i++) {
      expect(details).toContain(`tag-${i}`);
      if (i > 0)
        expect(expanded.indexOf(`href="/dashboard/memories/BULK-${i - 1}"`)).toBeLessThan(
          expanded.indexOf(`href="/dashboard/memories/BULK-${i}"`),
        );
    }
    expect(expanded.indexOf('Capture 0</a>')).toBeLessThan(expanded.indexOf('Prompt at first tie'));
    expect(expanded.indexOf('Capture 99</a>')).toBeLessThan(expanded.indexOf('Prompt at last tie'));
    expect(compact.match(/href="\/dashboard\/(?:memories|prompts)\//g)).toHaveLength(5);
    expect(middle.match(/href="\/dashboard\/(?:memories|prompts)\//g)).toHaveLength(97);
    expect(preview).not.toContain('href=');
    for (const milestone of ['Started', 'Ended', 'Deleted']) {
      expect(preview).toContain(milestone);
      expect(compact.match(new RegExp(`>${milestone}<`, 'g'))).toHaveLength(1);
      expect(expanded.match(new RegExp(`>${milestone}<`, 'g'))).toHaveLength(1);
    }
    expect(expanded.indexOf('Capture 2</a>')).toBeLessThan(expanded.indexOf('>Started<'));
    expect(expanded.indexOf('>Started<')).toBeLessThan(expanded.indexOf('Capture 3</a>'));
    expect(expanded.indexOf('Capture 49</a>')).toBeLessThan(expanded.indexOf('>Deleted<'));
    expect(expanded.indexOf('>Deleted<')).toBeLessThan(expanded.indexOf('Capture 50</a>'));
    expect(expanded.indexOf('Capture 97</a>')).toBeLessThan(expanded.indexOf('>Ended<'));
    expect(expanded.indexOf('>Ended<')).toBeLessThan(expanded.indexOf('Capture 98</a>'));
    expect(compact).not.toContain('href="/dashboard/memories/BULK-1"');
    expect(compact).toContain('href="/dashboard/memories/BULK-98"');
    expect(compact).toContain('href="/dashboard/memories/BULK-99"');
    const expand = history.indexOf('aria-label="Show 97 more events"');
    expect(history.indexOf('Prompt at first tie')).toBeLessThan(expand);
    expect(history.indexOf('Capture 1</a>')).toBeGreaterThan(expand);
    expect(details).toContain('First prompt excerpt');
    expect(details).toContain('Last prompt excerpt');
    expect(history).toContain('Started');
    expect(history).toContain('Ended');
    expect(history).toContain('dateTime="1970-01-01T00:00:03.500Z"');
    expect(history).toContain('dateTime="1970-01-01T00:01:38.500Z"');
    expect(details).toContain('Outside recorded run');
    expect(history).not.toContain('<table');
  });

  it.each(['ended', 'abandoned'] as const)(
    'shows only recorded lifecycle dates for %s',
    async (status) => {
      t.handle.raw
        .prepare('UPDATE sessions SET status = ?, ended_at = ?, deleted_at = ? WHERE id = ?')
        .run(status, 2_000, 3_000, 'S-EMPTY');
      const { html } = await historyPresentation('S-EMPTY');
      expect(html).toContain(status === 'abandoned' ? 'Abandoned' : 'Ended');
      expect(html).toContain('Deleted');
      expect(html).toContain('dateTime="1970-01-01T00:00:02.000Z"');
      expect(html).toContain('dateTime="1970-01-01T00:00:03.000Z"');
      expect(html).not.toContain('Still running');
      expect(html).not.toMatch(/Resumed|Heartbeat|Summary saved/);
      t.handle.raw.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run('S-EMPTY');
      const missing = await historyPresentation('S-EMPTY');
      expect(missing.html).toContain('End time not recorded');
      expect(missing.html).not.toContain('Still running');
      expect(missing.html).not.toContain('dateTime="1970-01-01T00:00:02.000Z"');
    },
  );

  it('shows all five captures without an expansion and labels an active run honestly', async () => {
    t.handle.db
      .insert(prompts)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          id: `SMALL-${i}`,
          sessionId: 'S-EMPTY',
          title: `Prompt ${i}`,
          content: 'Excerpt',
          createdAt: new Date(1_000 + i),
        })),
      )
      .run();
    const { html, middle } = await historyPresentation('S-EMPTY');
    expect(html.match(/href="\/dashboard\/prompts\/SMALL-/g)).toHaveLength(5);
    expect(middle).toBe('');
    expect(html).not.toContain('Show ');
    expect(html).toContain('Still running');
    expect(html).not.toContain('End time not recorded');
  });

  it('orders equal timestamps by lifecycle boundary, capture kind and record id', async () => {
    t.handle.raw
      .prepare('UPDATE sessions SET ended_at = ?, deleted_at = ? WHERE id = ?')
      .run(500, 500, 'S-CURATED');
    t.handle.db
      .insert(memory)
      .values(
        ['Z', 'A'].map((id) => ({
          id: `TIE-${id}`,
          sessionId: 'S-CURATED',
          title: `Tied memory ${id}`,
          content: 'Body',
          type: 'project' as const,
          tags: [],
          scope: 'project' as const,
          status: 'active' as const,
          replaces: [],
          createdAt: new Date(500),
          lastSeenAt: new Date(500),
        })),
      )
      .run();
    t.handle.db
      .insert(prompts)
      .values({
        id: 'TIE-PROMPT',
        sessionId: 'S-CURATED',
        title: 'Tied prompt',
        content: 'Excerpt',
        createdAt: new Date(500),
      })
      .run();
    const { html } = await historyPresentation('S-CURATED');
    const ordered = [
      '>Started<',
      'Tied memory A',
      'Tied memory Z',
      'Tied prompt',
      '>Ended<',
      '>Deleted<',
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(html.indexOf(ordered[i - 1]!)).toBeLessThan(html.indexOf(ordered[i]!));
    }
    expect(html.match(/dateTime="1970-01-01T00:00:00.500Z"/g)).toHaveLength(6);
    expect(html).not.toContain('Outside recorded run');
    expect(html).not.toContain('Show ');
  });

  it('uses Ficha with one title, primary controls and collapsed rail after prose', async () => {
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain('detail-layout detail-ficha');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Stats"');
    expect(html).toContain('aria-label="History"');
    expect(html).toContain('class="ficha-byline"');
    expect(html).toContain('started <time');
    expect(html).toContain('claude-code');
    const agentBadge = html.match(/<span[^>]*data-slot="badge"[^>]*>claude-code<\/span>/)?.[0];
    expect(agentBadge).toBeDefined();
    expect(agentBadge).toContain('bg-primary');
    expect(agentBadge).toContain('text-primary-foreground');
    expect(html).toContain('</svg>Share</button>');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:="")?/);
    expect(html.match(/seed goal here/g)).toHaveLength(1);
    expect(html).not.toContain('Prompts captured');
    expect(html.indexOf('Accomplished')).toBeLessThan(html.indexOf('aria-label="Stats"'));
    expect(html.indexOf('aria-label="Stats"')).toBeLessThan(html.indexOf('aria-label="History"'));
    expect(html.indexOf('aria-label="History"')).toBeLessThan(
      html.indexOf('aria-label="Properties"'),
    );
    expect(html).not.toContain('aria-label="Memories"');
    expect(html).not.toContain('aria-label="Prompts"');
    expect(html).toContain('aria-label="Session actions"');
    expect(html).toContain('aria-label="Session content"');
    expect(html).not.toMatch(/<p[^>]*>Session log<\/p>/);
    expect(html.match(/aria-label="Copy"/g)).toHaveLength(1);
    expect(html).not.toContain('Copy markdown');
  });
  it('renders a curated summary as Markdown with no RAW chip', async () => {
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain('<strong class="font-medium text-primary">Accomplished</strong>');
    expect(html).not.toContain('>RAW<');
    expect(html).toContain('seed goal here');
    expect(html).toContain('text-sm leading-7 text-foreground');
    expect(html).toMatch(/<blockquote[^>]*text-foreground[^>]*>/);
    expect(html).toContain('Evidence with spaces.');
  });

  it('renders an uncurated summary as escaped preformatted text with a RAW chip', async () => {
    const html = await renderSessionDetail('S-RAW');
    expect(html).toContain('>RAW<');
    expect(html).toMatch(/<pre[^>]*text-foreground[^>]*>[\s\S]*fix the bug[\s\S]*<\/pre>/);
    expect(html).not.toContain('<strong>Fixed it.</strong>');
    expect(html).toContain('**Fixed it.**');
    expect(html).toContain('seed goal here');
  });

  it.each([
    'Migration local es único DDL persistente. Pruebas existentes ROLLBACK.',
    'Migration local es únicoDDLpersistente. Pruebasexistentes ROLLBACK.',
  ])('preserves stored summary text through writing and rendering: %s', async (body) => {
    const repos = createRepositories(t.handle.db);
    const sessions = new AgentSessionsService(repos, t.handle.db);
    const summary = `## Verified+how\n\n${body}`;
    sessions.writeSummary('S-EMPTY', { tokenId: 'tk1', summary, final: true });
    expect(repos.agentSessions.adminGetDetail('S-EMPTY')?.summary).toBe(summary);
    const html = await renderSessionDetail('S-EMPTY');
    expect(html).toContain(`<p class="mb-3 leading-7 last:mb-0">${body}</p>`);
  });

  it('renders meaningful content and no chip for an empty session', async () => {
    const html = await renderSessionDetail('S-EMPTY');
    expect(html).not.toContain('>RAW<');
    expect(html).toContain('No summary has been recorded for this session.');
    expect(html).toContain('0 memories');
    expect(html).toContain('0 prompts');
    expect(html).not.toContain('NO MEMORY WAS WRITTEN DURING THIS RUN');
    expect(html).not.toContain('NO PROMPT WAS CAPTURED');
  });

  it('places the ended-session Delete form directly beside Copy and Share without an overflow menu', async () => {
    const html = await renderSessionDetail('S-CURATED');
    expect(html).not.toContain('detail-actions-panel');
    expect(html).not.toContain('class="detail-actions ');
    const actions = html.slice(html.indexOf('class="ficha-actions'));
    expect(actions).toContain('aria-label="Copy"');
    expect(actions).toContain('</svg>Share</button>');
    expect(actions).toContain('<form');
    expect(actions).toContain('name="id" value="S-CURATED"');
    expect(actions).toContain('name="csrf"');
    expect(actions).toContain('data-variant="destructive"');
    expect(actions).toContain('>Delete</button>');
  });

  it.each([
    ['active', false, ['Abandon', 'Delete']],
    ['ended', false, ['Delete']],
    ['abandoned', false, ['Delete']],
    ['active', true, ['Undelete']],
  ] as const)('preserves actions for %s with deleted=%s', async (status, deleted, labels) => {
    t.handle.raw
      .prepare('UPDATE sessions SET status = ?, deleted_at = ? WHERE id = ?')
      .run(status, deleted ? 2_000 : null, 'S-EMPTY');
    const html = await renderSessionDetail('S-EMPTY');
    for (const label of ['Abandon', 'Delete', 'Undelete']) {
      expect(html.includes(`>${label}</button>`)).toBe(
        labels.some((expected) => expected === label),
      );
    }
    expect(html).not.toContain('detail-actions-panel');
    expect(html.match(/name="csrf"/g)).toHaveLength(labels.length);
    expect(html.match(/name="id" value="S-EMPTY"/g)).toHaveLength(labels.length);
    expect(html.includes('SOFT-DELETED')).toBe(deleted);
    const ids = [...html.matchAll(/<form id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(labels.length);
    expect((html.match(/data-slot="alert-dialog-trigger"/g) ?? []).length).toBe(
      deleted ? 0 : labels.length,
    );
  });

  it('links the full untruncated prompt title to its exact id', async () => {
    const title = 'Complete captured request '.repeat(4);
    t.handle.db
      .insert(prompts)
      .values({
        id: 'LONG-PROMPT',
        sessionId: 'S-CURATED',
        title,
        content: 'Body',
        createdAt: new Date(1_000),
      })
      .run();
    const html = await renderSessionDetail('S-CURATED');
    expect(html).toContain(`>${title}</a>`);
    expect(html).toContain('href="/dashboard/prompts/LONG-PROMPT"');
  });

  it('retains capture metadata, prompt detail links and revoked-token metadata without duplicate tables', async () => {
    t.handle.raw.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(2_000, 'tk1');
    t.handle.db
      .insert(memory)
      .values({
        id: 'SESSION-MEM',
        sessionId: 'S-CURATED',
        title: 'Saved memory',
        content: 'Durable body',
        type: 'project',
        tags: [],
        scope: 'project',
        status: 'active',
        replaces: [],
        createdAt: new Date(1_000),
        lastSeenAt: new Date(1_000),
      })
      .run();
    t.handle.db
      .insert(prompts)
      .values({
        id: 'SESSION-PROMPT',
        sessionId: 'S-CURATED',
        title: 'Captured prompt',
        content: 'Prompt body',
        tags: ['dashboard'],
        createdAt: new Date(1_000),
      })
      .run();
    const html = await renderSessionDetail('S-CURATED');
    expect(html).not.toContain('<table');
    expect(html).toContain('aria-label="History"');
    expect(html).toContain('Saved memory');
    expect(html).toContain('Captured prompt');
    expect(html).toContain('border-primary bg-primary');
    const details = await historyDetails('S-CURATED');
    expect(details).toContain('Prompt body');
    expect(details).toContain('dashboard');
    expect(details).toContain('project');
    expect(details).toContain('active');
    expect(html).toContain('dateTime="1970-01-01T00:00:01.000Z"');
    expect(html.indexOf('Saved memory')).toBeLessThan(html.indexOf('Captured prompt'));
    expect(html).toContain('href="/dashboard/memories/SESSION-MEM"');
    expect(html).toContain('href="/dashboard/prompts/SESSION-PROMPT"');
    expect(html).toContain('test (revoked)');
    expect(html).not.toContain('Prompts captured');
  });
});
