import { ProjectsService } from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { defaultProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/projects');

let t: TestDb;
let projects: ProjectsService;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  projects = new ProjectsService(createRepositories(t.handle.db));
});

afterEach(() => t.cleanup());

async function renderProjects(): Promise<string> {
  const page = (await import('../../app/dashboard/projects/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve({}) }));
}

/** One row's markup, keyed on the slug cell. */
function row(html: string, slug: string): string {
  const chunk = html.split('<tr').find((c) => c.includes(`>${slug}<`));
  if (chunk === undefined) throw new Error(`no row for project ${slug}`);
  return chunk.split('</tr>')[0]!;
}

/** The `default` marker pill: the label cell's pill closes its bullet span right before it. */
function markerRows(html: string): number {
  return (html.match(/<\/span>default<\/span>/g) ?? []).length;
}

describe('the projects list marks the system default', () => {
  it('renders the marker on the is_default row and on no other', async () => {
    const own = projects.create({ slug: 'default-2', displayName: 'default' });
    const system = defaultProject(t.handle);

    const html = await renderProjects();

    expect(markerRows(html)).toBe(1);
    expect(row(html, system.slug)).toMatch(/<\/span>default<\/span>/);
    expect(row(html, own.slug)).not.toMatch(/<\/span>default<\/span>/);
  });

  it('follows the column, not the spelling, when the marker moves', async () => {
    const own = projects.create({ slug: 'default-2', displayName: 'operator project' });
    const system = defaultProject(t.handle);
    // The partial UNIQUE index admits one flagged row, so clear before setting.
    t.handle.raw.prepare('UPDATE projects SET is_default = 0 WHERE id = ?').run(system.id);
    t.handle.raw.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run(own.id);

    const html = await renderProjects();

    expect(markerRows(html)).toBe(1);
    expect(row(html, own.slug)).toMatch(/<\/span>default<\/span>/);
    // Still spelled `default`, no longer the default: a slug-keyed template fails here.
    expect(system.slug).toBe('default');
    expect(row(html, system.slug)).not.toMatch(/<\/span>default<\/span>/);
  });

  it('renames the default project and keeps both its slug and its marker', async () => {
    const system = defaultProject(t.handle);
    const renamed = projects.rename(system.id, 'billing invoice reconciliation');

    expect(renamed.slug).toBe(system.slug);
    expect(renamed.isDefault).toBe(true);
    expect(renamed.displayName).toBe('billing invoice reconciliation');

    const html = await renderProjects();
    expect(markerRows(html)).toBe(1);
    expect(row(html, system.slug)).toContain('billing invoice reconciliation');
    expect(row(html, system.slug)).toMatch(/<\/span>default<\/span>/);
  });

  it('offers no archive control for the default project, and still offers one for every other', async () => {
    const own = projects.create({ slug: 'alpha' });
    const system = defaultProject(t.handle);

    const html = await renderProjects();

    expect(row(html, own.slug)).toContain('ARCHIVE');
    expect(row(html, system.slug)).not.toContain('ARCHIVE');
  });
});
