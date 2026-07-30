import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../../test/db.js';

import { MemoryRepository } from './memory-repository.js';

/**
 * The shipped breadth-first walks, transcribed verbatim as equivalence ORACLES —
 * the idiom `memory-repository.perf.test.ts` uses for `LEGACY_NOT_EXISTS`. Every
 * assertion below compares the recursive CTE against these rather than against a
 * hand-written expectation, so an assertion cannot silently encode the new
 * behaviour it is supposed to be checking.
 */
function oracleAncestorIds(
  findReplaces: (id: string) => string[] | undefined,
  start: readonly string[],
  cap: number,
): string[] {
  const visited = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    if (visited.size === cap) break;
    for (const p of findReplaces(id) ?? []) if (!visited.has(p)) queue.push(p);
  }
  return [...visited];
}

interface Node {
  id: string;
  replaces: string[];
}

let t: TestDb;
let repo: MemoryRepository;

function seed(nodes: Node[]): void {
  const raw = t.handle.raw;
  const insert = raw.prepare(
    `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at, last_seen_at)
     VALUES (?, 'global', NULL, 'project', ?, 'body', '[]', 'active', ?, 1, 1)`,
  );
  for (const n of nodes) insert.run(n.id, `t-${n.id}`, JSON.stringify(n.replaces));
}

const findReplacesVia = (): ((id: string) => string[] | undefined) => (id) => repo.findReplaces(id);

beforeEach(() => {
  t = createTestDb();
  repo = new MemoryRepository(t.handle.db);
});

afterEach(() => {
  t.cleanup();
});

describe('unsafeAncestorIds — equivalence with the walk it replaces', () => {
  const CAP = 10;

  const check = (startIds: string[], cap = CAP) => {
    const expected = oracleAncestorIds(findReplacesVia(), startIds, cap);
    const actual = repo.unsafeAncestorIds({ startIds, limit: cap });
    // Ids AND order: the traversal order is what `memory.get` publishes.
    expect(actual).toEqual(expected);
    return actual;
  };

  it('a linear chain longer than the bound', () => {
    // n0 <- n1 <- ... <- n39, so n39 replaces n38, etc.
    seed(
      Array.from({ length: 40 }, (_, i) => ({
        id: `n${i}`,
        replaces: i === 0 ? [] : [`n${i - 1}`],
      })),
    );
    const ids = check(['n39']);
    expect(ids).toHaveLength(CAP);
    expect(ids[0]).toBe('n39');
  });

  it('a diamond with two start ids and a shared grandparent', () => {
    seed([
      { id: 'gp', replaces: [] },
      { id: 'l', replaces: ['gp'] },
      { id: 'r', replaces: ['gp'] },
    ]);
    const ids = check(['l', 'r']);
    // UNION, not UNION ALL: the shared grandparent appears once.
    expect(ids.filter((i) => i === 'gp')).toHaveLength(1);
  });

  it('a `replaces` cycle terminates', () => {
    seed([
      { id: 'a', replaces: ['b'] },
      { id: 'b', replaces: ['a'] },
    ]);
    expect(check(['a']).sort()).toEqual(['a', 'b']);
  });

  it('an ancestor id with no `memory` row', () => {
    seed([{ id: 'child', replaces: ['ghost'] }]);
    // The bound counts the dangling id in both forms; the walk simply stops.
    check(['child']);
  });

  it('a fan-in wide enough to truncate mid-level', () => {
    seed([
      { id: 'child', replaces: Array.from({ length: 25 }, (_, i) => `p${i}`) },
      ...Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, replaces: [] })),
    ]);
    const ids = check(['child']);
    expect(ids).toHaveLength(CAP);
  });

  it('empty and degenerate inputs', () => {
    seed([
      { id: 'lone', replaces: [] },
      { id: 'child', replaces: ['lone'] },
    ]);
    // `check([])` would compare [] to [] — vacuous, since the guard clause returns
    // before any query. Asserted directly instead, then the cases that do query.
    expect(repo.unsafeAncestorIds({ startIds: [], limit: CAP })).toEqual([]);
    expect(check(['does-not-exist'])).toEqual(['does-not-exist']);
    expect(check(['lone'])).toEqual(['lone']);
  });

  it('a non-positive bound returns nothing without querying', () => {
    seed([{ id: 'a', replaces: [] }]);
    expect(repo.unsafeAncestorIds({ startIds: ['a'], limit: 0 })).toEqual([]);
    expect(repo.unsafeAncestorIds({ startIds: ['a'], limit: -1 })).toEqual([]);
  });

  it('is flat in chain depth: 40 deep and 1000 deep read the same rows', () => {
    seed(
      Array.from({ length: 1000 }, (_, i) => ({
        id: `d${i}`,
        replaces: i === 0 ? [] : [`d${i - 1}`],
      })),
    );
    const deep = repo.unsafeAncestorIds({ startIds: ['d999'], limit: CAP });
    const shallow = repo.unsafeAncestorIds({ startIds: ['d39'], limit: CAP });
    expect(deep).toHaveLength(CAP);
    expect(shallow).toHaveLength(CAP);
    // The bound is inside SQL, so depth does not change what is read.
    expect(deep).toEqual(oracleAncestorIds(findReplacesVia(), ['d999'], CAP));
  });

  it('the database refuses to store a malformed `replaces`, so the stricter failure mode is unreachable', () => {
    seed([{ id: 'ok', replaces: [] }]);
    // The CTE uses `json_each(m.replaces)`, which RAISES on malformed JSON where
    // the old per-hop loop read the column into JS and would have seen garbage.
    // That difference cannot be reached: `memory_replaces_ai`/`_au` (migration
    // 0021) run `json_each(NEW.replaces)` on every write, so the corrupt state is
    // rejected at INSERT and UPDATE, not merely undocumented. No defensive
    // `json_valid` guard is added, because there is no path to guard.
    expect(() =>
      t.handle.raw.prepare(`UPDATE memory SET replaces = 'not json' WHERE id = 'ok'`).run(),
    ).toThrow(/malformed JSON/i);
    expect(repo.findReplaces('ok')).toEqual([]);
  });
});

describe('unsafeAncestorIds — the plan, and why not memory_replaces', () => {
  it('seeks the memory primary key and scans neither table', () => {
    seed([
      { id: 'a', replaces: ['b'] },
      { id: 'b', replaces: [] },
    ]);
    const detail = explainWhileRunning(t, () =>
      repo.unsafeAncestorIds({ startIds: ['a'], limit: 10 }),
    ).join(' | ');
    expect(detail).toContain('SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)');
    expect(detail).not.toContain('AUTOMATIC COVERING INDEX');
    expect(detail).not.toContain('SCAN memory_replaces');
    expect(detail).not.toMatch(/SCAN m\b/);
  });

  it('memory_replaces carries no index object, which is why the ancestor direction avoids it', () => {
    const objects = t.handle.raw
      .prepare<[], { type: string; name: string }>(
        `SELECT type, name FROM sqlite_master WHERE tbl_name = 'memory_replaces'`,
      )
      .all()
      .filter((o) => o.type === 'index');
    // Its PK is (predecessor_id, successor_id) and it is WITHOUT ROWID, so the PK
    // IS the table. Nothing serves a successor_id lookup, so the ancestor
    // direction would force a transient per-query index, linear in the edge table.
    expect(objects).toEqual([]);
  });

  it('the rejected edge-table form really does build an automatic index', () => {
    seed([
      { id: 'a', replaces: ['b'] },
      { id: 'b', replaces: [] },
    ]);
    const detail = t.handle.raw
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN
         WITH RECURSIVE anc(id) AS (
           SELECT 'a'
           UNION
           SELECT mr.predecessor_id FROM anc JOIN memory_replaces mr ON mr.successor_id = anc.id
         ) SELECT id FROM anc LIMIT 10`,
      )
      .all()
      .map((r) => r.detail)
      .join(' | ');
    // Recorded as an executable fact rather than a comment, so nobody re-proposes
    // it or the `memory_replaces(successor_id)` index that would prop it up.
    expect(detail).toContain('AUTOMATIC COVERING INDEX');
  });
});

function explainWhileRunning(db: TestDb, run: () => void): string[] {
  const raw = db.handle.raw;
  const bound = raw.prepare.bind(raw);
  const seen: string[] = [];
  const wrap = (stmt: object, text: string): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        const method = value as (...a: unknown[]) => unknown;
        if (prop === 'all' || prop === 'get' || prop === 'run') {
          return (...params: unknown[]) => {
            seen.push(
              ...bound<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${text}`)
                .all(...params)
                .map((r) => r.detail),
            );
            return method.apply(target, params);
          };
        }
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          return result === target ? wrap(target, text) : result;
        };
      },
    });
  const patched = (text: string): object => wrap(bound(text), text);
  Object.defineProperty(raw, 'prepare', { value: patched, configurable: true, writable: true });
  try {
    run();
  } finally {
    Object.defineProperty(raw, 'prepare', { value: bound, configurable: true, writable: true });
  }
  return seen;
}
