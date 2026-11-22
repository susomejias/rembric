import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../index.js';
import { projectScope } from '../scope.js';
import { createTestDb, type TestDb } from '../test-support/db.js';
import { defaultProjectScope, seedProject } from '../test-support/default-project.js';

let db: TestDb;
let repos: Repositories;

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
});

afterEach(() => db.cleanup());

function insertMemory(id: string, projectId: string): void {
  repos.memory.insert({
    id,
    scope: 'project',
    projectId,
    type: 'feedback',
    title: id,
    content: id,
    status: 'active',
    createdAt: new Date(0),
  });
}

interface Captured {
  sql: string;
  args: unknown[];
}

function captureStatements(fn: () => void): Captured[] {
  const raw = db.handle.raw;
  const original = raw.prepare.bind(raw);
  const calls: Captured[] = [];
  raw.prepare = ((sql: string) => {
    const stmt = original(sql);
    // as unknown as: the driver's overloaded methods are rewrapped with one uniform signature.
    const methods = stmt as unknown as Record<'all' | 'get' | 'run', (...a: unknown[]) => unknown>;
    for (const method of ['all', 'get', 'run'] as const) {
      const call = methods[method].bind(stmt);
      methods[method] = (...args: unknown[]) => {
        calls.push({ sql, args });
        return call(...args);
      };
    }
    return stmt;
  }) as typeof raw.prepare;
  try {
    fn();
  } finally {
    raw.prepare = original;
  }
  return calls;
}

function planOf(fn: () => void): string[] {
  const pinStatements = captureStatements(fn).filter((c) => c.sql.includes('memory_pin_events'));
  expect(pinStatements.length).toBeGreaterThan(0);
  return pinStatements.flatMap(({ sql, args }) =>
    db.handle.raw
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args)
      .map((r) => r.detail),
  );
}

describe('memory_pin_events', () => {
  it('closes the action domain at the database level', () => {
    const scope = defaultProjectScope(db.handle);
    insertMemory('m1', scope.projectId);
    const insert = (action: string) =>
      db.handle.raw
        .prepare(
          'INSERT INTO memory_pin_events (memory_id, project_id, action, cause, event_ts) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', scope.projectId, action, 'agent', 0);

    expect(() => insert('pin')).not.toThrow();
    expect(() => insert('star')).toThrow(/CHECK constraint failed/);
  });

  it('orders events by insertion even within one millisecond', () => {
    const scope = defaultProjectScope(db.handle);
    insertMemory('m1', scope.projectId);
    const at = new Date(1_000);
    for (const action of ['pin', 'unpin', 'pin', 'unpin'] as const) {
      repos.memory.insertPinEvent({
        memoryId: 'm1',
        projectId: scope.projectId,
        action,
        cause: 'agent',
        eventTs: at,
      });
    }

    expect(repos.memory.latestPinActionsByIds(['m1']).get('m1')).toBe('unpin');
    expect(repos.memory.pinnedInScope(scope)).toEqual([]);
  });

  it("never lists a memory outside the scope, even under an event naming the scope's project", () => {
    const scope = defaultProjectScope(db.handle);
    seedProject(db.handle, 'p2');
    insertMemory('foreign', 'p2');
    repos.memory.insertPinEvent({
      memoryId: 'foreign',
      projectId: scope.projectId,
      action: 'pin',
      cause: 'agent',
      eventTs: new Date(0),
    });

    expect(repos.memory.pinnedInScope(scope)).toEqual([]);
    expect(repos.memory.pinnedInScope(projectScope('p2'))).toEqual([]);
  });

  it('the latest-event lookup searches the covering memory index', () => {
    const plan = planOf(() => repos.memory.latestPinActionsByIds(['a', 'b']));
    expect(plan).toContain(
      'SEARCH memory_pin_events USING COVERING INDEX memory_pin_events_memory_idx (memory_id=?)',
    );
  });

  it('the pinned list of a project searches the covering project index', () => {
    const plan = planOf(() => repos.memory.pinnedInScope(projectScope('p1')));
    expect(plan).toContain(
      'SEARCH memory_pin_events USING COVERING INDEX memory_pin_events_project_idx (project_id=?)',
    );
  });
});
