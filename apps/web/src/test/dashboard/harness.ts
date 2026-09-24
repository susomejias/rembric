import {
  AgentSessionsService,
  MemoryService,
  ProjectsService,
  PromptsService,
  RelationsService,
} from '@rembric/core';
import { createRepositories, type DbHandle } from '@rembric/db';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { vi } from 'vitest';

export const servicesRef: { current: unknown } = { current: undefined };

export function buildDashboardServices(handle: DbHandle): Record<string, unknown> {
  const repos = createRepositories(handle.db);
  return {
    repos,
    memory: new MemoryService(repos, handle.db),
    projects: new ProjectsService(repos),
    agentSessions: new AgentSessionsService(repos, handle.db),
    relations: new RelationsService(repos, handle.db),
    prompts: new PromptsService(repos, handle.db),
  };
}

export function installViewMocks(pathname = '/dashboard'): void {
  vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: { href?: string; children?: unknown }) =>
      createElement('a', { href, ...rest }, children as never),
  }));
  vi.mock('next/navigation', () => ({
    usePathname: () => pathname,
    useRouter: () => ({
      refresh: vi.fn(),
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    }),
    notFound: () => {
      throw new Error('NEXT_NOT_FOUND');
    },
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    },
  }));
  vi.mock('@/lib/services', () => ({ getServices: () => servicesRef.current }));
  vi.mock('@/lib/session', () => ({ dashboardCsrfToken: () => 'test-csrf-token' }));
  vi.mock('@/lib/actions/guard', () => ({
    guardAction: () => ({ ok: false, error: 'not exercised' }),
    guardFailure: () => ({ error: null }),
  }));

  vi.mock(
    '@/components/dashboard/action-form',
    async () => await import('../../components/dashboard/action-form'),
  );
  vi.mock(
    '@/components/dashboard/confirm-submit',
    async () => await import('../../components/dashboard/confirm-submit'),
  );
  vi.mock(
    '@/components/dashboard/csrf-field',
    async () => await import('../../components/dashboard/csrf-field'),
  );
  vi.mock(
    '@/components/dashboard/filters',
    async () => await import('../../components/dashboard/filters'),
  );
  vi.mock(
    '@/components/dashboard/markdown-panel',
    async () => await import('../../components/dashboard/markdown-panel'),
  );
  vi.mock(
    '@/components/dashboard/support',
    async () => await import('../../components/dashboard/support'),
  );
  vi.mock('@/components/dashboard/ui', async () => await import('../../components/dashboard/ui'));
  vi.mock('@/components/dashboard/command-bar', () => {
    return {
      CommandFrame: ({
        children,
        totals = {},
      }: {
        children?: unknown;
        totals?: Record<string, number>;
      }) =>
        createElement(
          'div',
          { 'data-shell': 'true' },
          Object.entries(totals).map(([key, value]) =>
            createElement('span', { key, 'data-total': key }, String(value)),
          ),
          children as never,
        ),
    };
  });
  vi.mock('@/lib/version', async () => await import('../../lib/version'));
  vi.mock('@/lib/nav', async () => await import('../../lib/nav'));
  vi.mock(
    '@/components/motion/number-ticker',
    async () => await import('../../components/motion/number-ticker'),
  );
  vi.mock(
    '@/components/ui/alert-dialog',
    async () => await import('../../components/ui/alert-dialog'),
  );
  vi.mock('@/components/ui/button', async () => await import('../../components/ui/button'));
  vi.mock('@/components/ui/input', async () => await import('../../components/ui/input'));
  vi.mock('@/components/ui/label', async () => await import('../../components/ui/label'));
  vi.mock('@/components/ui/select', async () => await import('../../components/ui/select'));
  vi.mock('@/components/ui/table', async () => await import('../../components/ui/table'));
  vi.mock('@/lib/utils', async () => await import('../../lib/utils'));
  vi.mock('@/lib/ease', async () => await import('../../lib/ease'));
}

export async function renderToHtml(element: unknown): Promise<string> {
  const stream = (await renderToReadableStream(element as never)) as ReadableStream<Uint8Array> & {
    allReady?: Promise<unknown>;
  };
  if (stream.allReady !== undefined) await stream.allReady;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) html += decoder.decode(value, { stream: true });
  }
  return html;
}

export function after(html: string, marker: string, length = 400): string {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`marker not found: ${marker}`);
  return html.slice(at, at + length);
}

export function judgmentLinkOrder(html: string): string[] {
  const out: string[] = [];
  const re = /href="\/dashboard\/judgments\/([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) out.push(match[1]!);
  return out;
}
