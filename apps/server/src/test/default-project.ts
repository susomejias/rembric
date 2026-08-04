import type { DbHandle } from '../db/index.js';

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
