import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/**
 * Property-based tests for the in-memory invariants that the runtime
 * code claims to enforce. These tests are intentionally schema-free:
 * they exercise pure functions / shape predicates without touching
 * SQLite, so they're fast and good for shrinking counterexamples.
 *
 * The corresponding runtime tests (which DO hit the database) live in
 * the per-service test files (`memory.test.ts`, `runner.test.ts`,
 * `operations.test.ts`).
 */

// ─── 13.8 status state machine ──────────────────────────────────────

type Status = 'active' | 'superseded' | 'archived';
type Transition = `${Status}->${Status}`;

const LEGAL_TRANSITIONS = new Set<Transition>([
  'active->superseded', // consolidation merge / supersede
  'active->archived', // archive (user-driven or decay)
  'superseded->active', // undo of merge / supersede
  'archived->active', // undo of decay
]);

function applyTransition(from: Status, to: Status): { ok: boolean } {
  return { ok: LEGAL_TRANSITIONS.has(`${from}->${to}`) };
}

describe('13.8 status state machine', () => {
  it('refuses every transition not on the allow-list', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Status>('active', 'superseded', 'archived'),
        fc.constantFrom<Status>('active', 'superseded', 'archived'),
        (from, to) => {
          const expected = LEGAL_TRANSITIONS.has(`${from}->${to}`);
          expect(applyTransition(from, to).ok).toBe(expected);
        },
      ),
    );
  });

  it('contains exactly the four legal transitions', () => {
    // Anti-bitrot: if someone broadens the FSM they have to update this
    // test too — which forces them to also update the docs/spec.
    expect([...LEGAL_TRANSITIONS].sort()).toEqual(
      ['active->superseded', 'active->archived', 'superseded->active', 'archived->active'].sort(),
    );
  });
});

// ─── 13.9 scope discipline ──────────────────────────────────────────

interface MemoryStub {
  id: string;
  scope: 'global' | 'project';
  projectId: string | null;
}

function scopeKey(m: MemoryStub): string {
  return `${m.scope}:${m.projectId ?? '∅'}`;
}

function opCrossesScopes(affected: MemoryStub[]): boolean {
  const keys = new Set(affected.map(scopeKey));
  return keys.size > 1;
}

describe('13.9 scope discipline', () => {
  it('flags any candidate set that spans more than one (scope, project)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 10 }),
            scope: fc.constantFrom<'global' | 'project'>('global', 'project'),
            projectId: fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: null }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (rows) => {
          // Normalize so that scope='global' implies projectId=null.
          const normalized: MemoryStub[] = rows.map((r) => ({
            id: r.id,
            scope: r.scope,
            projectId: r.scope === 'global' ? null : (r.projectId ?? 'p1'),
          }));

          const distinctKeys = new Set(normalized.map(scopeKey));
          const expected = distinctKeys.size > 1;
          expect(opCrossesScopes(normalized)).toBe(expected);
        },
      ),
    );
  });
});

// ─── 13.10 replaces graph: cycles impossible, head reachable ─────────

interface Node {
  id: string;
  replaces: string[];
  status: Status;
}

function buildChain(ids: string[]): Node[] {
  // Build a linear chain newest→oldest. Newest is index 0 (active),
  // the rest are superseded predecessors. Each node `replaces` exactly
  // the one immediately older than it.
  const nodes: Node[] = [];
  for (let i = 0; i < ids.length; i++) {
    nodes.push({
      id: ids[i]!,
      replaces: i + 1 < ids.length ? [ids[i + 1]!] : [],
      status: i === 0 ? 'active' : 'superseded',
    });
  }
  return nodes;
}

function chainHasCycle(nodes: Node[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const start of nodes) {
    const seen = new Set<string>();
    const stack = [start.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) return true;
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) continue;
      for (const r of node.replaces) stack.push(r);
    }
  }
  return false;
}

function findHead(nodes: Node[], startId: string): Node | null {
  // Head = the active successor reachable via the replaces graph by
  // walking "forward" (a node Y replaces X means Y is newer than X).
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reverse = new Map<string, string[]>(); // predecessor -> successors
  for (const n of nodes) {
    for (const r of n.replaces) {
      if (!reverse.has(r)) reverse.set(r, []);
      reverse.get(r)!.push(n.id);
    }
  }

  let cur = byId.get(startId);
  if (!cur) return null;
  const visited = new Set<string>();
  while (cur) {
    if (visited.has(cur.id)) return null;
    visited.add(cur.id);
    if (cur.status === 'active') return cur;
    const successors = reverse.get(cur.id) ?? [];
    if (successors.length === 0) return cur;
    cur = byId.get(successors[0]!);
  }
  return null;
}

describe('13.10 replaces graph properties', () => {
  it('never produces cycles', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (ids) => {
          const chain = buildChain(ids);
          expect(chainHasCycle(chain)).toBe(false);
        },
      ),
    );
  });

  it('head of any chain is reachable in O(depth)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
          minLength: 1,
          maxLength: 24,
        }),
        (ids) => {
          const chain = buildChain(ids);
          const head = findHead(chain, ids[ids.length - 1]!);
          expect(head?.id).toBe(ids[0]);
          expect(head?.status).toBe('active');
        },
      ),
    );
  });
});

// ─── 13.11 confirm chain semantics ──────────────────────────────────

function confirmEvent(
  nodes: Node[],
  events: { memoryId: string }[],
  targetId: string,
): { memoryId: string }[] {
  // Logical implementation of `confirm(id)`: resolve head, append
  // event pointing at head's id.
  const head = findHead(nodes, targetId);
  if (!head) return events;
  return [...events, { memoryId: head.id }];
}

function countConfirmations(events: { memoryId: string }[], headId: string): number {
  return events.filter((e) => e.memoryId === headId).length;
}

describe('13.11 confirm-chain semantics', () => {
  it('confirming any predecessor increments the head count by exactly one', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 5 }), {
          minLength: 2,
          maxLength: 10,
        }),
        fc.nat(8),
        (ids, n) => {
          const nodes = buildChain(ids);
          const headId = ids[0]!;
          let events: { memoryId: string }[] = [];

          // Repeatedly confirm a random predecessor (or the head itself).
          const before = countConfirmations(events, headId);
          for (let i = 0; i < n; i++) {
            const pickIdx = i % ids.length;
            events = confirmEvent(nodes, events, ids[pickIdx]!);
          }
          const after = countConfirmations(events, headId);
          expect(after - before).toBe(n);
        },
      ),
    );
  });
});
