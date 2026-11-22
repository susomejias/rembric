import { MemoryService, PIN_MAX_PER_PROJECT } from '@rembric/core';
import { createRepositories, projectScope, type Repositories, type Scope } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { seedProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/memories');

let t: TestDb;
let repos: Repositories;
let memory: MemoryService;
let scope: Scope;

beforeEach(() => {
  t = createTestDb();
  seedProject(t.handle, 'p0', 'project-zero');
  repos = createRepositories(t.handle.db);
  memory = new MemoryService(repos, t.handle.db);
  scope = projectScope('p0');
  servicesRef.current = { ...buildDashboardServices(t.handle), memory };
});

afterEach(() => t.cleanup());

const OPERATOR = { cause: 'operator', name: 'dashboard-operator' } as const;

function save(title: string): string {
  return memory.save({ type: 'feedback', title, content: `${title} body` }, scope).id;
}

async function list(params: Record<string, string> = {}) {
  const page = (await import('../../app/dashboard/memories/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

async function detail(id: string) {
  const page = (await import('../../app/dashboard/memories/[id]/page')).default;
  return renderToHtml(
    await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  );
}

function pinForm(id: string, pinned: boolean): FormData {
  const data = new FormData();
  data.set('csrf', 'test-csrf-token');
  data.set('id', id);
  data.set('pinned', pinned ? '1' : '0');
  return data;
}

function rowOf(html: string, title: string): string {
  const chunk = html.split('<tr').find((c) => c.includes(`memory — ${title}"`));
  if (chunk === undefined) throw new Error(`no row for ${title}`);
  return chunk.split('</tr>')[0]!;
}

describe('memories list pin state', () => {
  it('badges pinned rows and the Pinned filter lists only them with an exact total', async () => {
    const pinned = save('pinned-marker');
    save('plain-marker');
    memory.setPinned(pinned, scope, true, OPERATOR);

    const all = await list();
    expect(rowOf(all, 'pinned-marker')).toContain('>pinned<');
    expect(rowOf(all, 'plain-marker')).not.toContain('>pinned<');

    const filtered = await list({ pinned: '1' });
    expect(filtered).toContain('pinned-marker');
    expect(filtered).not.toContain('plain-marker');
    expect(filtered).toContain('1–1 of 1');

    const searched = await list({ pinned: '1', q: 'marker' });
    expect(searched).toContain('pinned-marker');
    expect(searched).not.toContain('plain-marker');
  });
});

describe('memory detail pin state', () => {
  it('shows the badge, the Unpin action and the pin history with an automatic release', async () => {
    const id = save('rule');
    memory.setPinned(id, scope, true, OPERATOR);

    const pinnedHtml = await detail(id);
    expect(pinnedHtml).toContain('>pinned<');
    expect(pinnedHtml).toMatch(/>Unpin<\/button>/);
    expect(pinnedHtml).toContain('aria-label="Pin history"');

    memory.archive(id, scope);
    const archived = await detail(id);
    const history = archived.match(/aria-label="Pin history"[\s\S]*?<\/section>/)![0];
    const text = history.replace(/<!-- -->/g, '');
    expect(text).toMatch(/>pin<\/span> operator · dashboard-operator/);
    expect(text).toMatch(/>unpin<\/span> archive/);
    expect(archived).not.toContain('>pinned<');
  });

  it('an unpinned memory offers Pin and renders no pin history', async () => {
    const html = await detail(save('rule'));
    expect(html).toMatch(/>Pin<\/button>/);
    expect(html).not.toContain('aria-label="Pin history"');
  });
});

describe('dashboard pin action', () => {
  it('pins and unpins as the operator', async () => {
    const { pinFromForm } = await import('../../app/dashboard/memories/pin-action');
    const id = save('rule');

    expect(pinFromForm(memory, pinForm(id, true))).toEqual({ error: null, id });
    expect(memory.unsafePinnedIdsAmong([id]).has(id)).toBe(true);
    expect(pinFromForm(memory, pinForm(id, false))).toEqual({ error: null, id });
    expect(repos.memory.adminPinEventsForMemory(id).map((e) => [e.action, e.cause])).toEqual([
      ['pin', 'operator'],
      ['unpin', 'operator'],
    ]);
  });

  it('reports the count refusal naming the current pins and pins nothing', async () => {
    const { pinFromForm } = await import('../../app/dashboard/memories/pin-action');
    for (let i = 0; i < PIN_MAX_PER_PROJECT; i++) {
      memory.setPinned(save(`standing rule ${i}`), scope, true, OPERATOR);
    }
    const extra = save('one too many');

    const outcome = pinFromForm(memory, pinForm(extra, true));

    expect(outcome.error).toContain(`${PIN_MAX_PER_PROJECT} pinned memories`);
    expect(outcome.error).toContain('standing rule 0');
    expect(outcome.error).toContain(`standing rule ${PIN_MAX_PER_PROJECT - 1}`);
    expect(memory.unsafePinnedIdsAmong([extra]).has(extra)).toBe(false);
  });
});
