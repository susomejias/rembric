import { createRepositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { seedProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/consolidation');

const PAGE_SIZE = 20;
const SEEDED = PAGE_SIZE + 2;

const MALFORMED_SUMMARY = '{not json <b>raw</b>';

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  const repos = createRepositories(t.handle.db);
  repos.consolidation.insertRun({
    id: 'RUN-MALFORMED',
    startedAt: new Date(1_000),
    scope: 'global',
    summary: MALFORMED_SUMMARY,
  });
  repos.consolidation.insertRun({
    id: 'RUN-STRUCTURED',
    startedAt: new Date(2_000),
    scope: 'global',
    summary: JSON.stringify({ archives: 2, orphaned: 1 }),
  });
});

afterEach(() => t.cleanup());

async function renderRunDetail(id: string): Promise<string> {
  const page = (await import('../../app/dashboard/consolidation/[id]/page')).default;
  return renderToHtml(await page({ params: Promise.resolve({ id }) }));
}

async function renderConsolidation(): Promise<string> {
  const page = (await import('../../app/dashboard/consolidation/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve({}) }));
}

describe('consolidation detail composition', () => {
  it('keeps summary and operations primary, with undo attached only to actionable operations', async () => {
    const repos = createRepositories(t.handle.db);
    for (const [id, opType, revertedAt] of [
      ['OP-ACTIVE', 'decay', null],
      ['OP-TERMINAL', 'session_purge', null],
      ['OP-REVERTED', 'decay', new Date(3_000)],
    ] as const) {
      repos.consolidation.insertOp({
        id,
        runId: 'RUN-STRUCTURED',
        opType,
        revertedAt,
        affectedIds: ['MEM-A'],
        createdId: 'MEM-B',
        reasoning: '<b>reason</b>',
        appliedAt: new Date(2_000),
      });
    }
    const html = await renderRunDetail('RUN-STRUCTURED');
    expect(html).toContain('detail-layout detail-ficha');
    expect(html).toContain('>Consolidation</a>');
    expect(html).not.toContain('detail-actions-panel');
    expect(html).not.toContain('>Share</button>');
    expect(html).not.toContain('aria-label="Copy');
    expect(html).toMatch(/<details[^>]*aria-label="Properties"/);
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    expect(article).toContain('2 archived · 1 orphaned');
    expect(article).toContain('aria-label="Operations"');
    expect(article).toContain('aria-label="Operation OP-ACTIVE"');
    expect(article).toContain('aria-label="Operation OP-TERMINAL"');
    expect(article).toContain('aria-label="Operation OP-REVERTED"');
    expect(article).not.toContain('<table');
    expect(article).not.toContain('truncate');
    expect(article).toContain('[&amp;_dt]:text-[var(--chart-2)]');
    expect(article).toContain('name="opId" value="OP-ACTIVE"');
    expect(article).not.toContain('name="opId" value="OP-TERMINAL"');
    expect(article).not.toContain('name="opId" value="OP-REVERTED"');
    expect(article).toContain('terminal (not undoable)');
    expect(article).toContain('reverted');
    expect(article).toContain('href="/dashboard/memories/MEM-A"');
    expect(article).toContain('href="/dashboard/memories/MEM-B"');
    expect(article).toContain('&lt;b&gt;reason&lt;/b&gt;');
    expect(article).not.toContain('<details');
    expect(html).toContain('name="runId" value="RUN-STRUCTURED"');
    expect(html.match(/data-slot="alert-dialog-trigger"/g)).toHaveLength(2);
    expect(html.match(/name="csrf"/g)).toHaveLength(2);
  });

  it('omits undo for an entirely reverted run and preserves resolved scope with raw fallback', async () => {
    const repos = createRepositories(t.handle.db);
    seedProject(t.handle, 'p0', 'project-zero');
    for (const [id, scope] of [
      ['RESOLVED', 'project:p0'],
      ['MISSING', 'project:gone'],
    ] as const) {
      repos.consolidation.insertRun({ id, scope, startedAt: new Date(1_000) });
      repos.consolidation.insertOp({
        id: `OP-${id}`,
        runId: id,
        opType: 'decay',
        affectedIds: [],
        appliedAt: new Date(1_000),
        revertedAt: new Date(2_000),
      });
      const html = await renderRunDetail(id);
      expect(html).toContain(id === 'RESOLVED' ? 'project-zero' : 'project:gone');
      expect(html).toContain('all ops reverted');
      expect(html).not.toContain('name="runId"');
      expect(html).not.toContain('name="opId"');
      expect(html).not.toContain('ficha-actions');
    }
  });

  it('keeps empty operations visible and omits run undo when no active operation exists', async () => {
    const html = await renderRunDetail('RUN-MALFORMED');
    expect(html).toContain('NO OPERATION WAS RECORDED FOR THIS RUN');
    expect(html).toContain('all ops reverted');
    expect(html).not.toContain('name="runId"');
    expect(html).not.toContain('ficha-actions');
  });

  it('retains whole-run eligibility for unreverted terminal operations without offering per-op undo', async () => {
    createRepositories(t.handle.db).consolidation.insertOp({
      id: 'TERMINAL-ONLY',
      runId: 'RUN-STRUCTURED',
      opType: 'prompt_purge',
      affectedIds: [],
      appliedAt: new Date(2_000),
    });
    const html = await renderRunDetail('RUN-STRUCTURED');
    expect(html).toContain('name="runId" value="RUN-STRUCTURED"');
    expect(html).not.toContain('name="opId"');
    expect(html).toContain('terminal (not undoable)');
    expect(html.match(/data-slot="alert-dialog-trigger"/g)).toHaveLength(1);
  });
});

describe('consolidation run summary fallback', () => {
  it('renders a malformed stored summary escaped instead of throwing', async () => {
    const html = await renderRunDetail('RUN-MALFORMED');
    expect(html).toContain('{not json &lt;b&gt;raw&lt;/b&gt;');
    expect(html).toMatch(/<pre tabindex="0"[^>]*whitespace-pre-wrap!/);
    expect(html).toContain('wrap-anywhere!');
    expect(html).not.toContain('<b>raw</b>');
  });

  it('decodes a structured sweep summary into prose inside the same <pre>', async () => {
    const html = await renderRunDetail('RUN-STRUCTURED');
    expect(html).toMatch(/<pre[^>]*>[\s\S]*2 archived · 1 orphaned[\s\S]*<\/pre>/);
  });
});

describe('consolidation list page slice', () => {
  it(`caps the runs list at PAGE_SIZE for ${SEEDED} seeded runs`, async () => {
    const repos = createRepositories(t.handle.db);
    for (let i = 0; i < SEEDED; i++) {
      repos.consolidation.insertRun({
        id: `RUN${i}`,
        startedAt: new Date(1_000 + i),
        scope: 'global',
      });
    }

    const html = await renderConsolidation();
    expect(html).toContain(`${PAGE_SIZE} OF ${SEEDED + 2}`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} OF`);
  });
});
