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
async function detail(id: string, confirmed = '') {
  const page = (await import('../../app/dashboard/memories/[id]/page')).default;
  return renderToHtml(
    await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ confirmed }) }),
  );
}
function section(html: string, label: string) {
  const match = html.match(
    new RegExp(`<(section|details)[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</\\1>`),
  );
  expect(match, label).not.toBeNull();
  return match![0];
}
describe('Ficha memory detail', () => {
  it('starts Judgments and Properties collapsed without hiding Review or History', async () => {
    t.handle.db.insert(memory).values(fixture('HEAD')).run();
    const html = await detail('HEAD');
    for (const label of ['Judgments', 'Properties']) {
      const opening = html.match(new RegExp(`<details[^>]*aria-label="${label}"[^>]*>`))?.[0];
      expect(opening, label).toBeDefined();
      expect(opening).not.toMatch(/\sopen(?:=|>|\s)/);
    }
    expect(html).toContain('aria-label="Review"');
    expect(html).toContain('aria-label="History"');
  });
  it('composes the document, header tags, single actions region and ordered context rail', async () => {
    t.handle.db.insert(memory).values(fixture('HEAD')).run();
    const html = await detail('HEAD');
    expect(html).toContain('detail-ficha');
    expect(html).not.toContain('ficha-type');
    expect(html).toContain('<dt>Type</dt><dd>project</dd>');
    expect(html.match(/Title HEAD/g)).toHaveLength(1);
    expect(html).toContain('>Memories</a>');
    expect(html).toContain('role="group" aria-label="Tags"');
    for (const value of ['layout-topic', 'project-zero', 'test-agent', 'Last recalled', 'Created'])
      expect(html).toContain(value);
    expect(html.indexOf('aria-label="Tags"')).toBeLessThan(html.indexOf('Body HEAD'));
    expect(html.indexOf('Body HEAD')).toBeLessThan(html.indexOf('aria-label="Review"'));
    expect(html.indexOf('aria-label="Review"')).toBeLessThan(html.indexOf('aria-label="History"'));
    expect(html.indexOf('aria-label="History"')).toBeLessThan(
      html.indexOf('aria-label="Judgments"'),
    );
    expect(html.indexOf('aria-label="Judgments"')).toBeLessThan(
      html.indexOf('>Properties</summary>'),
    );
    expect(html.match(/aria-label="Copy"/g)).toHaveLength(1);
    expect(html.match(/>Confirm<\/button>/g)).toHaveLength(1);
    expect(html.match(/<form /g)).toHaveLength(2);
    expect(html.match(/name="csrf"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Archive<\/button>/);
    expect(html).toContain('Share</button>');
    expect(html).not.toContain('detail-actions-panel');
    expect(html).not.toContain('Details and tags');
    const ids = [...html.matchAll(/<form id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('walks multi-hop history with cycles, preserves snapshots and unresolved IDs, and excludes cross-project rows', async () => {
    seedProject(t.handle, 'p1', 'other');
    t.handle.db
      .insert(memory)
      .values([
        fixture('ORIGIN', { status: 'superseded', createdAt: new Date(1_000), replaces: ['HEAD'] }),
        fixture('MID', {
          status: 'superseded',
          createdAt: new Date(2_000),
          replaces: ['ORIGIN', 'MISSING', 'FOREIGN', 'GLOBAL'],
        }),
        fixture('PREV', { status: 'superseded', createdAt: new Date(3_000), replaces: ['MID'] }),
        fixture('FOREIGN', { projectId: 'p1', title: 'Private other project' }),
        fixture('GLOBAL', { scope: 'global', title: 'Other scope', topicKey: 'global-key' }),
        fixture('HEAD', { replaces: ['PREV'] }),
      ])
      .run();
    const history = section(await detail('HEAD'), 'History');
    for (const id of ['ORIGIN', 'MID', 'PREV', 'MISSING'])
      expect(history).toContain(`href="/dashboard/memories/${id}"`);
    expect(history).not.toContain('Private other project');
    expect(history).not.toContain('Other scope');
    expect(history).not.toContain('Body HEAD');
    expect(history).toContain('Body ORIGIN');
    expect(history).toContain('Body PREV');
    expect(history.indexOf('Title ORIGIN')).toBeLessThan(history.indexOf('Title PREV'));
    expect(history).toContain('1 intermediate versions');
    expect(history.match(/This version/g)).toHaveLength(1);
    expect(history).toContain('data-rembric-ts');
  });
  it('keeps pending judgments before three resolved ones inside the collapsed disclosure, with remaining judgments and tags expandable', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `OTHER-${i}`);
    t.handle.db
      .insert(memory)
      .values([
        fixture('HEAD', { tags: Array.from({ length: 9 }, (_, i) => `tag-${i}`) }),
        ...ids.map((id) => fixture(id, { topicKey: id })),
      ])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values(
        ids.map((id, i) => ({
          id: `REL-${i}`,
          judgmentId: `J-${i}`,
          sourceId: 'HEAD',
          targetId: id,
          status: i < 2 ? ('pending' as const) : ('judged' as const),
          relation: i < 2 ? null : ('related' as const),
          createdAt: new Date(3_000 + i),
        })),
      )
      .run();
    const html = await detail('HEAD');
    const judgments = section(html, 'Judgments');
    expect(judgments).toContain('Show all 7 judgments');
    const visible = judgments.split('hidden=""')[0]!;
    expect(visible.match(/href="\/dashboard\/judgments\//g)).toHaveLength(5);
    expect(visible.indexOf('pending')).toBeLessThan(visible.indexOf('judged'));
    for (let i = 0; i < 7; i++) expect(judgments).toContain(`href="/dashboard/judgments/REL-${i}"`);
    expect(html).toContain('aria-label="Show all 9 tags"');
    expect(html).toContain('+3');
  });
  it('places the sole stale Confirm in the notice and preserves the confirmation flash', async () => {
    t.handle.db
      .insert(memory)
      .values(fixture('STALE', { createdAt: new Date(1_000) }))
      .run();
    const html = await detail('STALE', '1');
    expect(html).toContain('Not re-affirmed since');
    expect(html).toContain('Review affirmed just now');
    expect(html.match(/>Confirm<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(/Not re-affirmed since[\s\S]*?>Confirm<\/button>[\s\S]*?<article/);
    expect(html).toContain('Overdue by');
  });
  it('hides Confirm and Review when superseded, and archives only active memories', async () => {
    t.handle.db
      .insert(memory)
      .values([fixture('OLD', { status: 'superseded' }), fixture('HEAD', { replaces: ['OLD'] })])
      .run();
    const html = await detail('OLD');
    expect(html).toContain('Replaced on');
    expect(html).toContain('href="/dashboard/memories/HEAD"');
    expect(html).not.toContain('aria-label="Review"');
    expect(html).not.toContain('>Confirm<');
    expect(html).not.toContain('>Archive<');
    expect(html).toContain('<dt>Confirmations</dt><dd>0</dd>');
    expect(createRepositories(t.handle.db).memory.adminCountConfirmations('HEAD')).toBe(0);
  });
  it.each([{ projectId: 'p1' }, { scope: 'global' as const }])(
    'does not expose an out-of-scope successor: %j',
    async (overrides) => {
      seedProject(t.handle, 'p1', 'other');
      t.handle.db
        .insert(memory)
        .values([
          fixture('OLD', { status: 'superseded' }),
          fixture('NEXT', { ...overrides, replaces: ['OLD'] }),
        ])
        .run();
      const html = await detail('OLD');
      expect(html).not.toContain('Title NEXT');
      expect(html).not.toContain('Body NEXT');
      expect(html).not.toContain('href="/dashboard/memories/NEXT"');
      expect(html).toContain('Superseded.');
    },
  );
  it.each(['archived', 'active'] as const)(
    'preserves confirmation of %s reference memories without inventing a review deadline',
    async (status) => {
      t.handle.db
        .insert(memory)
        .values(fixture('REF', { type: 'reference', status }))
        .run();
      const html = await detail('REF');
      expect(html).not.toContain('aria-label="Review"');
      expect(html).toContain('<dt>Confirmations</dt><dd>0</dd>');
      expect(html).toContain('>Confirm<');
      expect(html.includes('>Archive<')).toBe(status === 'active');
    },
  );
});
