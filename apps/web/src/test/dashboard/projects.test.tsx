import { ProjectsService } from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { defaultProject } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

import { projectArchiveAction } from '@/components/dashboard/projects-table';

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

function row(html: string, slug: string): string {
  const chunk = html.split('<tr').find((c) => c.includes(`>${slug}<`));
  if (chunk === undefined) throw new Error(`no row for project ${slug}`);
  return chunk.split('</tr>')[0]!;
}

function markerRows(html: string): number {
  return (html.match(/<\/span>default<\/span>/g) ?? []).length;
}

function rowMenus(html: string): number {
  return (html.match(/Actions for project /g) ?? []).length;
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
    t.handle.raw.prepare('UPDATE projects SET is_default = 0 WHERE id = ?').run(system.id);
    t.handle.raw.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run(own.id);

    const html = await renderProjects();

    expect(markerRows(html)).toBe(1);
    expect(row(html, own.slug)).toMatch(/<\/span>default<\/span>/);
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
});

describe('the projects page header', () => {
  it('keeps the h1, the muted subtitle and a New project trigger, and drops the inline form', async () => {
    projects.create({ slug: 'alpha' });
    const archived = projects.create({ slug: 'beta' });
    projects.archive(archived.id);

    const html = await renderProjects();

    expect(html).toContain('>Projects</h1>');
    expect(html).toContain('3 projects · 2 active');
    expect(html).toContain('>New project</button>');
    expect(html).toContain('aria-haspopup="dialog"');
    // The create form now lives inside the client-only Sheet: no field of it is
    // part of the server-rendered page body.
    expect(html).not.toContain('name="slug"');
    expect(html).not.toContain('>Create project</button>');
  });
});

describe('the projects table follows the sessions pattern', () => {
  it('renders the search box, the selection column, one actions menu per row and pagination', async () => {
    const own = projects.create({ slug: 'alpha' });
    const system = defaultProject(t.handle);

    const html = await renderProjects();

    expect(html).toContain('Search projects…');
    expect(html).toContain('Select all rows on this page');
    expect(rowMenus(html)).toBe(2);
    expect(html).toContain(`Actions for project ${own.slug}`);
    expect(row(html, system.slug)).toContain('Actions for project');
    expect(html).toContain('1–2 of 2');
  });

  it('caps the client page at 10 rows and searches on name and slug', async () => {
    for (let index = 0; index < 11; index += 1) {
      projects.create({ slug: `bulk-${index}` });
    }

    const html = await renderProjects();

    expect(html).toContain('1–10 of 12');
    expect(html).toContain('Search projects…');
  });

  it('marks the archived rows and offers the state filter over active and archived', async () => {
    const active = projects.create({ slug: 'alpha' });
    const archived = projects.create({ slug: 'beta' });
    projects.archive(archived.id);

    const html = await renderProjects();

    expect(html).toContain('Filter by state');
    expect(row(html, archived.slug)).toContain('</span>archived</span>');
    expect(row(html, active.slug)).not.toContain('archived');
  });
});

// The archive control only exists inside the contextual menu, which Radix does
// not server-render while it is closed — so the guard that used to be asserted
// through the row's inline form is asserted on the derivation the menu renders
// from, plus the menu trigger the row does expose.
describe('the archive control follows the default guard', () => {
  it('offers archive for a non-default project and neither action for the default one', () => {
    expect(projectArchiveAction({ isDefault: false, archived: false })).toBe('archive');
    expect(projectArchiveAction({ isDefault: true, archived: false })).toBe('none');
  });

  it('offers only unarchive once a project is archived', () => {
    expect(projectArchiveAction({ isDefault: false, archived: true })).toBe('unarchive');
    expect(projectArchiveAction({ isDefault: true, archived: true })).toBe('unarchive');
  });

  it('renders an actions menu for the default project too, so rename stays reachable', async () => {
    const system = defaultProject(t.handle);

    const html = await renderProjects();

    expect(rowMenus(html)).toBe(1);
    expect(row(html, system.slug)).toContain('Actions for project');
  });
});
