import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { homeScope, projectScope, type SearchScope } from './scope.js';

let db: TestDb;
let repos: Repositories;
let mem: MemoryService;
let home: string;
let other: string;
let widened: Extract<SearchScope, { kind: 'authorized-projects' }>;

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  const projects = new ProjectsService(repos);
  home = projects.create({ slug: 'home' }).id;
  other = projects.create({ slug: 'other' }).id;
  mem = new MemoryService(repos, db.handle.db);
  widened = { kind: 'authorized-projects', projectIds: [home, other], homeProjectId: home };
});

afterEach(() => db.cleanup());

describe('homeScope', () => {
  it('returns a narrow scope unchanged', () => {
    const narrow = projectScope(home);
    expect(homeScope(narrow)).toEqual(narrow);
  });

  it('returns the home project of a widened scope, never another member', () => {
    expect(homeScope(widened)).toEqual(projectScope(home));
  });
});

describe('the widened scope reaches the search path and nothing else', () => {
  it('is accepted by search, which returns rows inside the set', async () => {
    mem.save(
      { type: 'project', title: 'Home note', content: 'rotation runbook' },
      projectScope(home),
    );
    mem.save(
      { type: 'project', title: 'Other note', content: 'rotation runbook' },
      projectScope(other),
    );

    const rows = await mem.search({ query: 'rotation runbook' }, widened);

    // Non-vacuity: an empty page satisfies the membership assertion below.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(widened.projectIds).toContain(row.projectId);
  });

  it('is refused by every write and non-search read', () => {
    // Enforced by `tsc`, not by the assertion below: give any of these a
    // `SearchScope` parameter and its directive goes unused, which reds the
    // build (openspec/specs/auth/spec.md, a widening "SHALL be of a type no
    // write path can hold"). Never invoked — a call would write a row with no
    // project and prove something else entirely.
    const refused = () => {
      // @ts-expect-error a write cannot hold a widened scope
      mem.save({ type: 'project', title: 'x', content: 'x' }, widened);
      // @ts-expect-error neither can the topic_key upsert
      mem.saveWithTopicKey({ type: 'project', title: 'x', content: 'x' }, widened);
      // @ts-expect-error nor the lifecycle verbs
      mem.archive('id', widened);
      // @ts-expect-error nor the append-only confirmation event
      mem.confirm('id', widened);
      // @ts-expect-error nor the single-row read whose miss is a not_found
      mem.get('id', widened);
      // @ts-expect-error nor the batch form of it
      mem.getMany(['id'], widened);
    };
    expect(typeof refused).toBe('function');
  });
});
