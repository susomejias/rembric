import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../db/client.js';
import { createRepositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { MemoryService, PREDECESSOR_CAP } from './memory.js';
import { DISMISSAL_ANCESTRY_CAP, findSaveTimeCandidates } from './save-time-candidates.js';

/**
 * Statement counts for the two ancestry walks, before and after the recursive CTE.
 *
 * The counter wraps the terminal `all`/`get`/`run` of each prepared statement, not
 * `prepare` itself: one statement executed ten times is one `prepare` and ten
 * executions, so counting prepares undercounts silently.
 *
 * A fresh connection is used defensively, not because these paths need it.
 * Measured: attaching the same proxy to the connection that seeded a 30-save
 * chain reports the identical count (4), because drizzle's `db.all(sql…)` and
 * builder `.all()` both go through one-time query preparation here. The extra
 * connection costs nothing and keeps the instrument correct for any path that
 * DOES hold a prepared statement across executions.
 */
function countStatements<T>(t: TestDb, run: (repos: ReturnType<typeof createRepositories>) => T) {
  // Force every statement to be prepared again by handing the repositories a
  // connection the seeding never touched.
  const fresh = createDb({ dataDir: t.dataDir });
  const raw = fresh.raw;
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
            seen.push(text.replace(/\s+/g, ' ').trim());
            return method.apply(target, params);
          };
        }
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          return result === target ? wrap(target, text) : result;
        };
      },
    });
  Object.defineProperty(raw, 'prepare', {
    value: (text: string): object => wrap(bound(text) as object, text),
    configurable: true,
    writable: true,
  });
  const result = run(createRepositories(fresh.db));
  fresh.raw.close();
  return { result, statements: seen };
}

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

function seedChain(depth: number): { headId: string; tailId: string } {
  const repos = createRepositories(t.handle.db);
  const svc = new MemoryService(repos, t.handle.db);
  let previous: string | undefined;
  let first: string | undefined;
  // A real topic_key chain: `saveWithTopicKey` is the only path that sets
  // `replaces`, atomically superseding the previously-active row.
  for (let i = 0; i < depth; i += 1) {
    const { memory: saved } = svc.saveWithTopicKey(
      {
        type: 'project',
        title: `revision ${i}`,
        content: `body of revision ${i}, long enough to be worth not reading`.repeat(20),
        topicKey: 'chain/under-test',
      },
      { kind: 'global' },
    );
    first ??= saved.id;
    previous = saved.id;
  }
  return { headId: previous!, tailId: first! };
}

describe('ancestry traversal costs one statement, not one per hop', () => {
  it('save-time detection on a chained save: the walk is a single statement', () => {
    const { headId } = seedChain(30);
    const repos0 = createRepositories(t.handle.db);
    const svc = new MemoryService(repos0, t.handle.db);
    const { memory: saved } = svc.saveWithTopicKey(
      {
        type: 'project',
        title: 'revision 30',
        content: 'next body',
        topicKey: 'chain/under-test',
      },
      { kind: 'global' },
    );
    expect(saved.replaces).toEqual([headId]);

    const { statements } = countStatements(t, (repos) =>
      findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }),
    );
    const ancestry = statements.filter((s) => s.includes('WITH RECURSIVE anc'));
    const perHopProbes = statements.filter((s) =>
      /select "replaces" from "memory" where "id" = \?/i.test(s),
    );
    // BEFORE: 12 statements, 9 of them per-hop `select "replaces"` probes.
    // AFTER: the walk is one recursive CTE and the per-hop probes are gone.
    expect(ancestry).toHaveLength(1);
    expect(perHopProbes).toHaveLength(0);
    // 12 → 4 in this harness: the CTE, listNotConflictTargetsForSources, one vec
    // probe, one FTS query. The absolute number is harness-specific — it rises by
    // one when the saved row already has an embedding, and by one more when
    // entities were extracted (production passes them; this call does not) — so
    // the durable assertions are the two above, plus a bound well under the 12
    // the per-hop walk cost.
    expect(statements.length).toBeLessThanOrEqual(6);
    expect(statements).toHaveLength(4);
  });

  it('save-time detection on a plain save issues NO ancestry statement at all', () => {
    const repos0 = createRepositories(t.handle.db);
    const svc = new MemoryService(repos0, t.handle.db);
    const saved = svc.save({ type: 'project', title: 'lone', content: 'body' }, { kind: 'global' });

    const { statements } = countStatements(t, (repos) =>
      findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }),
    );
    // The case the walk was already free in. A regression here would put a new
    // query on every non-topic-key save, which is most of them.
    expect(statements.filter((s) => s.includes('WITH RECURSIVE anc'))).toHaveLength(0);
  });

  it('memory.get on a long chain reads no predecessor content', () => {
    const { headId } = seedChain(30);

    const { result, statements } = countStatements(t, (repos) => {
      const svc = new MemoryService(repos, t.handle.db);
      return svc.get(headId, { kind: 'global' });
    });

    expect(result?.predecessors).toHaveLength(PREDECESSOR_CAP);
    expect(result?.truncated).toBe(true);

    // BEFORE: 14 statements, 11 of them full-row selects — ten predecessor bodies
    // read to emit ten titles. The projection is the point, not just the count.
    const selectsContent = statements.filter(
      (s) => /"content"/.test(s) && /from "memory"/i.test(s) && !/insert/i.test(s),
    );
    expect(statements.filter((s) => s.includes('WITH RECURSIVE anc'))).toHaveLength(1);
    // 14 → 6 in this harness. Harness-specific in one way worth naming: the
    // requested row is `active`, so `findHead` returns without a statement; a
    // superseded row costs more. What is durable is the shape — one CTE, one
    // four-field projection, and exactly one full-row select (the requested row).
    expect(statements).toHaveLength(6);
    expect(
      statements.filter((s) =>
        /select "id", "title", "status", "created_at" from "memory"/i.test(s),
      ),
    ).toHaveLength(1);
    // Exactly one, not "at most one": at zero this assertion would pass while the
    // projection had silently stopped being used.
    expect(selectsContent).toHaveLength(1);
  });
});

describe('the two bounds are decoupled', () => {
  it('suppression depth and the payload budget are separate constants', () => {
    // Same value today; the point is that neither can move the other. If a future
    // change raises PREDECESSOR_CAP to show more predecessors, suppression reach
    // must not follow it silently.
    expect(DISMISSAL_ANCESTRY_CAP).toBe(10);
    expect(PREDECESSOR_CAP).toBe(10);
  });

  it('nothing outside memory.ts reads PREDECESSOR_CAP for suppression', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./save-time-candidates.ts', import.meta.url), 'utf8');
    // The name may appear in prose explaining the decoupling; what must not
    // exist is an import or a use of it as a bound.
    expect(src).not.toMatch(/import\s*\{[^}]*PREDECESSOR_CAP/);
    expect(src).not.toMatch(/limit:\s*PREDECESSOR_CAP/);
    expect(src).toContain('limit: DISMISSAL_ANCESTRY_CAP');
  });
});

/**
 * The `memory.get` walk, transcribed verbatim from the commit before this change,
 * as the second equivalence ORACLE. The repository primitive was proven to death
 * and this consumer — whose observable contract is what actually changed — was
 * proven nowhere, which is how a `truncated` regression shipped green.
 */
function oracleGetPredecessors(
  repos: ReturnType<typeof createRepositories>,
  start: { id: string; replaces: string[] },
): { ids: string[]; truncated: boolean } {
  const visited = new Set<string>([start.id]);
  const rows: string[] = [];
  const queue = [...start.replaces];
  let truncated = false;
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    if (rows.length >= PREDECESSOR_CAP) {
      truncated = true;
      break;
    }
    const row = repos.memory.unsafeGetById(id);
    if (!row) continue;
    rows.push(row.id);
    for (const r of row.replaces) if (!visited.has(r)) queue.push(r);
  }
  return { ids: rows, truncated };
}

describe('memory.get predecessors — equivalence with the walk it replaces', () => {
  function chain(depth: number) {
    const t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const svc = new MemoryService(repos, t.handle.db);
    const ids: string[] = [];
    for (let i = 0; i < depth; i += 1) {
      const { memory: m } = svc.saveWithTopicKey(
        { type: 'project', title: `rev ${i}`, content: `body ${i}`, topicKey: 'chain/eq' },
        { kind: 'global' },
      );
      ids.push(m.id);
    }
    return { t, repos, svc, ids };
  }

  const compare = (
    repos: ReturnType<typeof createRepositories>,
    svc: MemoryService,
    id: string,
  ) => {
    const start = repos.memory.unsafeGetById(id)!;
    const expected = oracleGetPredecessors(repos, start);
    const got = svc.get(id, { kind: 'global' })!;
    // Order, count and the truncation flag — the three things the response
    // publishes and the three the CTE had to preserve.
    expect(got.predecessors.map((p) => p.id)).toEqual(expected.ids);
    expect(got.predecessorCount).toBe(expected.ids.length);
    expect(got.truncated).toBe(expected.truncated);
    return got;
  };

  it('below the bound: order preserved, count exact, not truncated', () => {
    const { t, repos, svc, ids } = chain(4);
    const got = compare(repos, svc, ids[3]!);
    expect(got.predecessorCount).toBe(3);
    expect(got.truncated).toBe(false);
    expect(got.predecessors.map((p) => p.title)).toEqual(['rev 2', 'rev 1', 'rev 0']);
    t.cleanup();
  });

  it('at the bound: truncated, and the count is the bound', () => {
    const { t, repos, svc, ids } = chain(14);
    const got = compare(repos, svc, ids[13]!);
    expect(got.predecessorCount).toBe(PREDECESSOR_CAP);
    expect(got.truncated).toBe(true);
    t.cleanup();
  });

  it('exactly at the boundary: cap predecessors is NOT truncation', () => {
    const { t, repos, svc, ids } = chain(PREDECESSOR_CAP + 1);
    const got = compare(repos, svc, ids[PREDECESSOR_CAP]!);
    expect(got.predecessorCount).toBe(PREDECESSOR_CAP);
    expect(got.truncated).toBe(false);
    t.cleanup();
  });

  it('a cycle back to the requested row does NOT mask truncation', () => {
    // Regression guard. The start id used to consume a slot of the probe window,
    // so a reachable start id pushed the real eleventh ancestor out and
    // `truncated` came back false with ancestry unreached. Found by review, not
    // by this suite — which is why the oracle comparison now covers this path.
    const { t, repos, svc, ids } = chain(12);
    const head = ids[11]!;
    t.handle.raw
      .prepare(`UPDATE memory SET replaces = ? WHERE id = ?`)
      .run(JSON.stringify([ids[9], head]), ids[10]!);
    const got = compare(repos, svc, head);
    expect(got.truncated).toBe(true);
    expect(got.predecessors.map((p) => p.id)).not.toContain(head);
    t.cleanup();
  });

  it('a dangling ancestor id consumes the bound — the one intended divergence', () => {
    const { t, svc, ids } = chain(14);
    // Chain kept INTACT and a dangling id added beside it, so the graph is still
    // deep enough to truncate. Purge cannot produce this state (it refuses to
    // purge a row another row's `replaces` references), so the fixture is
    // synthetic on purpose.
    t.handle.raw
      .prepare(`UPDATE memory SET replaces = ? WHERE id = ?`)
      .run(JSON.stringify([ids[10], 'ghost-id']), ids[11]!);
    const got = svc.get(ids[13]!, { kind: 'global' })!;
    // The bound now counts ancestor IDS, so the dangling id occupies one and the
    // projection comes back one short of the cap while truncation still holds.
    expect(got.predecessorCount).toBeLessThan(PREDECESSOR_CAP);
    expect(got.truncated).toBe(true);
    t.cleanup();
  });

  it('predecessors carry no content, by construction', () => {
    const { t, svc, ids } = chain(3);
    const got = svc.get(ids[2]!, { kind: 'global' })!;
    expect(got.predecessors.length).toBeGreaterThan(0);
    for (const p of got.predecessors) {
      expect(Object.keys(p).sort()).toEqual(['createdAt', 'id', 'status', 'title']);
    }
    t.cleanup();
  });
});
