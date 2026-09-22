import { projectScope, type DbHandle, type Scope } from '@rembric/db';

export function defaultProject(handle: DbHandle): { id: string; slug: string } {
  const row = handle.raw
    .prepare<[], { id: string; slug: string }>('SELECT id, slug FROM projects WHERE is_default = 1')
    .get();
  if (!row) throw new Error('no project carries is_default = 1');
  return row;
}

/** The `Scope` a path-less connection resolves to. */
export function defaultProjectScope(handle: DbHandle): Scope {
  return projectScope(defaultProject(handle).id);
}

export function seedProject(handle: DbHandle, id: string, slug = id): void {
  handle.raw
    .prepare('INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)')
    .run(id, slug, 0);
}
