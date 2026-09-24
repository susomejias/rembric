import { MemoryService } from '@rembric/core';
import { createRepositories, projectScope, projects, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../db';
import { defaultProject, defaultProjectScope } from '../default-project';

import { buildDashboardServices, installViewMocks, renderToHtml, servicesRef } from './harness';

installViewMocks('/dashboard/entities');

let t: TestDb;
let repos: Repositories;
let memory: MemoryService;

beforeEach(() => {
  t = createTestDb();
  servicesRef.current = buildDashboardServices(t.handle);
  repos = createRepositories(t.handle.db);
  memory = new MemoryService(repos, t.handle.db);
});

afterEach(() => t.cleanup());

async function renderEntities(params: Record<string, string> = {}): Promise<string> {
  const page = (await import('../../app/dashboard/entities/page')).default;
  return renderToHtml(await page({ searchParams: Promise.resolve(params) }));
}

describe('dashboard entities view', () => {
  it('lists entities across kinds with their link counts', async () => {
    const a = memory.save(
      { type: 'project', title: 'Fix', content: 'fixed apps/server/src/db/migrate.ts' },
      defaultProjectScope(t.handle),
    );
    repos.entities.linkMemory(
      a.id,
      defaultProject(t.handle).id,
      [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
      new Date(),
    );

    const html = await renderEntities();
    expect(html).toContain('apps/server/src/db/migrate.ts');
    expect(html).toContain('>path<');
  });

  it('filters by kind', async () => {
    const a = memory.save(
      { type: 'project', title: 'A', content: 'a' },
      defaultProjectScope(t.handle),
    );
    const b = memory.save(
      { type: 'project', title: 'B', content: 'b' },
      defaultProjectScope(t.handle),
    );
    repos.entities.linkMemory(
      a.id,
      defaultProject(t.handle).id,
      [{ kind: 'path', value: 'a.ts' }],
      new Date(),
    );
    repos.entities.linkMemory(
      b.id,
      defaultProject(t.handle).id,
      [{ kind: 'error_code', value: 'ENOENT' }],
      new Date(),
    );

    const html = await renderEntities({ kind: 'error_code' });
    expect(html).toContain('ENOENT');
    expect(html).not.toContain('>a.ts<');
  });

  it('renders global and project rows side by side, labeling the project and never "GLOBAL"', async () => {
    const projectId = 'demo';
    t.handle.db
      .insert(projects)
      .values({ id: projectId, slug: 'demo', createdAt: new Date() })
      .run();
    const g = memory.save(
      { type: 'project', title: 'G', content: 'g' },
      defaultProjectScope(t.handle),
    );
    const p = memory.save({ type: 'project', title: 'P', content: 'p' }, projectScope(projectId));
    repos.entities.linkMemory(
      g.id,
      defaultProject(t.handle).id,
      [{ kind: 'path', value: 'global-only.ts' }],
      new Date(),
    );
    repos.entities.linkMemory(
      p.id,
      projectId,
      [{ kind: 'path', value: 'project-only.ts' }],
      new Date(),
    );

    const html = await renderEntities();
    expect(html).toContain('global-only.ts');
    expect(html).toContain('project-only.ts');
    expect(html).toContain('demo');
    expect(html).not.toContain('GLOBAL');
  });

  it('shows the rebuild action without a pending count once everything is scanned', async () => {
    const m = memory.save(
      { type: 'project', title: 'A', content: 'apps/a.ts' },
      defaultProjectScope(t.handle),
    );
    repos.entities.linkMemory(
      m.id,
      defaultProject(t.handle).id,
      [{ kind: 'path', value: 'apps/a.ts' }],
      new Date(),
    );

    const html = await renderEntities();
    expect(html).toContain('REBUILD ENTITY INDEX');
    expect(html).not.toContain('PENDING');
  });

  it('shows the rebuild action with a pending count while a backlog exists', async () => {
    memory.save(
      { type: 'project', title: 'A', content: 'apps/a.ts' },
      defaultProjectScope(t.handle),
    );

    const html = await renderEntities();
    expect(html).toMatch(/REBUILD ENTITY INDEX[\s\S]{0,40}\(1 PENDING\)/);
  });

  it('renders the kind quick-filter pills, the search box and one client page of ten', async () => {
    const m = memory.save(
      { type: 'project', title: 'Many', content: 'many' },
      defaultProjectScope(t.handle),
    );
    const refs = Array.from({ length: 12 }, (_, i) => ({
      kind: 'path' as const,
      value: `path-${String(i).padStart(2, '0')}.ts`,
    }));
    repos.entities.linkMemory(m.id, defaultProject(t.handle).id, refs, new Date());

    const html = await renderEntities();
    expect(html).toContain('Filter by kind');
    expect(html).toContain('Search entities…');
    expect(html).toContain('1–10 of 12');
    expect(html).toContain('path-00.ts');
    expect(html).not.toContain('path-10.ts');
  });

  it('keeps the non-destructive row affordance and the metadata disclosure', async () => {
    const m = memory.save(
      { type: 'project', title: 'A', content: 'apps/a.ts' },
      defaultProjectScope(t.handle),
    );
    repos.entities.linkMemory(
      m.id,
      defaultProject(t.handle).id,
      [{ kind: 'path', value: 'apps/a.ts' }],
      new Date(),
    );

    const html = await renderEntities();
    expect(html).toContain('View memories →');
    expect(html).toContain('Show path entity — apps/a.ts"');
  });
});
