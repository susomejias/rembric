import type { DbHandle } from '../db/index.js';
import { projectScope, type Scope } from '../services/scope.js';

/**
 * The system default project, resolved by the boolean that IS its identity.
 *
 * Its slug is picked by collision avoidance at migration time — an operator who
 * already owns `default` gets `default-2` — so a test that hardcodes the string
 * teaches the wrong identity and passes only because nothing happened to take
 * the name.
 */
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

/**
 * A project with a caller-chosen id, for fixtures that address rows by a
 * literal (`'p0'`) rather than by the id the default project happens to get.
 */
export function seedProject(handle: DbHandle, id: string, slug = id): void {
  handle.raw
    .prepare('INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)')
    .run(id, slug, 0);
}
