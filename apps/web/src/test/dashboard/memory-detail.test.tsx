import { createRepositories, memory, memoryRelations, type NewMemory } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { seedProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/memories');

let t: TestDb;

function fixture(id: string, overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    id,
    title: `Title ${id}`,
    content: `Body ${id}`,
    scope: 'project',
    projectId: 'p0',
    type: 'project',
    tags: ['dashboard', 'layout'],
    status: 'active',
    replaces: [],
    createdAt: new Date(),
    lastSeenAt: new Date(1_000),
    source: { agent: 'test-agent' },
    topicKey: 'layout-topic',
    ...overrides,
  };
}

beforeEach(() => {
  t = createTestDb();
  seedProject(t.handle, 'p0', 'project-zero');
  servicesRef.current = buildDashboardServices(t.handle);
});

afterEach(() => t.cleanup());

async function detail(id: string, confirmed = ''): Promise<string> {
  const page = (await import('../../app/dashboard/memories/[id]/page')).default;
  return renderToHtml(
    await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ confirmed }) }),
  );
}

function disclosure(html: string, label: string): string {
  const match = html.match(
    new RegExp(`<details[^>]*>\\s*<summary[^>]*>${label}[\\s\\S]*?</details>`),
  );
  expect(match, `disclosure ${label}`).not.toBeNull();
  return match![0];
}

describe('content-first memory detail', () => {
  it('shows the title once and keeps one collapsed Details and tags disclosure ahead of prose', async () => {
    t.handle.db.insert(memory).values(fixture('HEAD')).run();
    const html = await detail('HEAD');
    expect(html.match(/Title HEAD/g)).toHaveLength(1);
    const details = disclosure(html, 'Details and tags');
    expect(details).not.toMatch(/<details[^>]*\bopen/);
    expect(details).toContain('dashboard');
    expect(details).toContain('layout');
    expect(details).toContain('aria-label="Tags"');
    expect(html).not.toContain('<summary>Tags</summary>');
    const beforeContent = html.slice(html.indexOf('detail-grid'), html.indexOf('<article'));
    expect(beforeContent.match(/<details /g)).toHaveLength(1);
    expect(html.indexOf('Details and tags')).toBeLessThan(html.indexOf('Body HEAD'));
    expect(html.indexOf('Body HEAD')).toBeLessThan(html.indexOf('Review</summary>'));
    expect(html.indexOf('Body HEAD')).toBeLessThan(html.indexOf('PREDECESSORS'));
    expect(html).toMatch(/<article[^>]*>[\s\S]*Body HEAD[\s\S]*<\/article>/);
    for (const value of [
      'HEAD',
      'project-zero',
      'project',
      'Confirms',
      'Created',
      'Last seen',
      'Scope',
      'layout-topic',
      'test-agent',
    ]) {
      expect(details).toContain(value);
    }
    expect(details).toContain('data-rembric-ts');
    expect(html).toContain('aria-label="Memory actions"');
    expect(html).toContain('aria-label="Copy"');
    expect(html).not.toContain('Copy markdown');
    expect(html).not.toMatch(/<p[^>]*>[\s\S]*?Memory content<\/p>/);
    expect(html).toMatch(/<h1[^>]*text-2xl[^>]*sm:text-3xl[^>]*>/);
    expect(html.match(/<form /g)).toHaveLength(2);
    expect(html.match(/>CONFIRM<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*>ARCHIVE<\/button>/,
    );
    const ids = [...html.matchAll(/<form id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps chronological compact history, unresolved replaces links and judgment links', async () => {
    t.handle.db
      .insert(memory)
      .values([
        fixture('OLD', { status: 'superseded', createdAt: new Date(1_000) }),
        fixture('NEWER', { status: 'superseded', createdAt: new Date(2_000) }),
        fixture('HEAD', { replaces: ['NEWER', 'MISSING', 'OLD'] }),
      ])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values({
        id: 'REL',
        judgmentId: 'J',
        sourceId: 'HEAD',
        targetId: 'OLD',
        status: 'pending',
        relation: null,
        createdAt: new Date(3_000),
      })
      .run();
    const html = await detail('HEAD');
    const history = disclosure(html, 'PREDECESSORS');
    expect(history).toContain('Body OLD');
    expect(history).toContain('Body NEWER');
    expect(history.indexOf('Body OLD')).toBeLessThan(history.indexOf('Body NEWER'));
    for (const id of ['OLD', 'NEWER', 'MISSING']) {
      expect(history).toContain(`href="/dashboard/memories/${id}"`);
    }
    expect(history).toContain('data-rembric-ts');
    const judgments = disclosure(html, 'JUDGMENTS');
    expect(judgments).toContain('href="/dashboard/judgments/REL"');
    expect(judgments).toContain('href="/dashboard/memories/OLD"');
    expect(judgments).toContain('pending_conflict');
    expect(html).not.toContain('<table');
  });

  it('keeps every link inside collapsed secondary panels even with many judgments', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `PREDECESSOR-${index}`);
    t.handle.db
      .insert(memory)
      .values([
        ...ids.map((id) => fixture(id, { status: 'superseded' })),
        fixture('HEAD', { replaces: ids }),
      ])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values(
        ids.map((id, index) => ({
          id: `REL-${index}`,
          judgmentId: `J-${index}`,
          sourceId: 'HEAD',
          targetId: id,
          status: 'pending' as const,
          relation: null,
          createdAt: new Date(3_000 + index),
        })),
      )
      .run();
    const html = await detail('HEAD');
    const history = disclosure(html, 'PREDECESSORS');
    const judgments = disclosure(html, 'JUDGMENTS');
    expect(history).not.toMatch(/<details[^>]*\bopen/);
    expect(judgments).not.toMatch(/<details[^>]*\bopen/);
    expect(history).toContain('detail-secondary-body');
    expect(judgments).toContain('detail-secondary-body');
    for (const [index, id] of ids.entries()) {
      expect(history).toContain(`href="/dashboard/memories/${id}"`);
      expect(judgments).toContain(`href="/dashboard/memories/${id}"`);
      expect(judgments).toContain(`href="/dashboard/judgments/REL-${index}"`);
    }
  });

  it('keeps stale, confirmed and superseded notices ahead of content and omits inapplicable review', async () => {
    t.handle.db
      .insert(memory)
      .values([
        fixture('STALE', { createdAt: new Date(1_000), topicKey: 'stale-topic' }),
        fixture('OLD', { status: 'superseded' }),
        fixture('HEAD', { replaces: ['OLD'] }),
      ])
      .run();
    const stale = await detail('STALE', '1');
    expect(stale).toContain('NEEDS REVIEW');
    expect(stale).toContain('CONFIRMED');
    expect(stale.indexOf('NEEDS REVIEW')).toBeLessThan(stale.indexOf('Body STALE'));
    expect(stale.indexOf('CONFIRMED')).toBeLessThan(stale.indexOf('Body STALE'));
    expect(stale.match(/>CONFIRM<\/button>/g)).toHaveLength(1);
    expect(stale.match(/<form /g)).toHaveLength(2);
    expect(stale).toContain('>ARCHIVE<');
    const superseded = await detail('OLD');
    expect(superseded).toContain('Superseded by');
    expect(superseded.indexOf('Superseded by')).toBeLessThan(superseded.indexOf('Body OLD'));
    expect(superseded).toContain('href="/dashboard/memories/HEAD"');
    expect(superseded).not.toContain('Review after');
    expect(superseded).not.toContain('>ARCHIVE<');
    expect(superseded.match(/<form /g)).toHaveLength(1);
    expect(superseded).toContain('>CONFIRM<');
    const fresh = await detail('HEAD');
    expect(fresh).not.toContain('Superseded by');
    expect(fresh).toContain('Review after');
    expect(createRepositories(t.handle.db).memory.adminCountConfirmations('HEAD')).toBe(0);
  });

  it.each(['archived', 'active'] as const)(
    'omits review timing for a %s reference memory',
    async (status) => {
      t.handle.db
        .insert(memory)
        .values(fixture('REF', { type: 'reference', status }))
        .run();
      const html = await detail('REF');
      expect(html).not.toContain('Review after');
      expect(html).not.toContain('NEEDS REVIEW');
      expect(html).toContain('>CONFIRM<');
      expect(html.includes('>ARCHIVE<')).toBe(status === 'active');
      expect(html.match(/name="csrf"/g)).toHaveLength(status === 'active' ? 2 : 1);
    },
  );
});
