import { createRepositories, projectScope, type Repositories, type Scope } from '@rembric/db';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentSessionsService,
  captureKeyLearnings,
  lastCodePoints,
  MemoryService,
  parseKeyLearnings,
  RedactionTally,
  RelationsService,
  subagentLearningTags,
  TokensService,
  type CaptureKeyLearningsDeps,
} from '@rembric/core';

import {
  createTestDb,
  defaultProjectScope,
  fakeGithubToken,
  seedProject,
  type TestDb,
} from '../test-support/index.js';

describe('parseKeyLearnings', () => {
  it('returns [] when no Key Learnings section exists', () => {
    expect(parseKeyLearnings('## Other section\n- item one')).toEqual([]);
    expect(parseKeyLearnings('plain text without any heading')).toEqual([]);
  });

  it('extracts numbered items', () => {
    const text = `## Key Learnings:

1. bcrypt cost=12 is the right balance
2. JWT refresh tokens need atomic rotation
3. session timeouts should be 24h not 7d`;
    expect(parseKeyLearnings(text)).toEqual([
      'bcrypt cost=12 is the right balance',
      'JWT refresh tokens need atomic rotation',
      'session timeouts should be 24h not 7d',
    ]);
  });

  it('extracts bulleted items', () => {
    const text = `## Key Learnings:

- alpha
* beta
- gamma`;
    expect(parseKeyLearnings(text)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('stops at the next H2', () => {
    const text = `## Key Learnings:

1. one
2. two

## Next Section

3. should not appear`;
    expect(parseKeyLearnings(text)).toEqual(['one', 'two']);
  });

  it('is case-insensitive on the heading', () => {
    expect(parseKeyLearnings('## key learnings:\n1. still works')).toEqual(['still works']);
    expect(parseKeyLearnings('## KEY LEARNINGS:\n1. still works')).toEqual(['still works']);
  });

  it('accepts an H3 heading', () => {
    expect(parseKeyLearnings('### Key Learnings\n1. works too')).toEqual(['works too']);
  });

  it('accepts the heading without a trailing colon', () => {
    expect(parseKeyLearnings('## Key Learnings\n1. no colon needed')).toEqual(['no colon needed']);
  });

  it('property: number of extracted items equals the number of well-formed list lines (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 40 }).map((s) => s.replace(/\n/g, ' ')),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        fc.array(fc.constantFrom('-', '*', '1.', '2.', '3.'), { minLength: 1, maxLength: 8 }),
        (items, markers) => {
          const n = Math.min(items.length, markers.length);
          const usedItems = items.slice(0, n).map((s) => s.trim() || 'placeholder');
          const lines = usedItems.map((it, i) => `${markers[i]} ${it}`);
          const text = `## Key Learnings:\n\n${lines.join('\n\n')}\n\n## Done`;
          const parsed = parseKeyLearnings(text);
          expect(parsed.length).toBe(n);
          expect(parsed).toEqual(usedItems);
        },
      ),
    );
  });

  it('tolerates blank lines and mixed list markers', () => {
    const text = `## Key Learnings:


1. first


* second

- third
   4. fourth`;
    expect(parseKeyLearnings(text)).toEqual(['first', 'second', 'third', 'fourth']);
  });
});

describe('lastCodePoints', () => {
  it('keeps the trailing code points and never splits a surrogate pair', () => {
    expect(lastCodePoints('abcdef', 3)).toBe('def');
    expect(lastCodePoints('abc', 10)).toBe('abc');
    expect(lastCodePoints('a😀b😀', 3)).toBe('😀b😀');
    expect(lastCodePoints('😀😀😀', 2)).toBe('😀😀');
  });
});

describe('subagentLearningTags', () => {
  it('adds the normalized agent type after the fixed tag, and drops one that normalizes to nothing', () => {
    expect(subagentLearningTags(undefined)).toEqual(['subagent-learning']);
    expect(subagentLearningTags('Explore')).toEqual(['subagent-learning', 'explore']);
    expect(subagentLearningTags(' Code Reviewer ')).toEqual(['subagent-learning', 'code-reviewer']);
    expect(subagentLearningTags('::')).toEqual(['subagent-learning']);
  });
});

const THREE = '## Key Learnings\n1. alpha learning\n2. beta learning\n3. gamma learning';

describe('captureKeyLearnings', () => {
  let db: TestDb;
  let repos: Repositories;
  let memory: MemoryService;
  let scope: Scope;
  let deps: CaptureKeyLearningsDeps;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    memory = new MemoryService(repos, db.handle.db);
    scope = defaultProjectScope(db.handle);
    const token = new TokensService(repos, db.handle.db).create({ name: 'tester', scope: '*' });
    const sessions = new AgentSessionsService(repos, db.handle.db);
    for (const id of ['sess-aaaa1', 'sess-bbbb1']) {
      sessions.ensure({ id, tokenId: token.token.id, projectId: scope.projectId, agent: 'test' });
    }
    deps = {
      memory,
      repos,
      relations: new RelationsService(repos, db.handle.db),
      candidates: { perSaveMax: 5 },
    };
  });

  afterEach(() => db.cleanup());

  function capture(
    text: string,
    sessionId: string | null,
    at: Scope = scope,
    d: CaptureKeyLearningsDeps = deps,
  ) {
    return captureKeyLearnings(
      d,
      {
        text,
        tags: ['learning'],
        resolveSessionId: () => sessionId,
        source: { tokenName: 'tester', agent: 'passive' },
      },
      at,
    );
  }

  function activeIn(sessionId: string, at: Scope = scope): string[] {
    return db.handle.raw
      .prepare<[string, string], { content: string }>(
        "SELECT content FROM memory WHERE session_id = ? AND project_id = ? AND status = 'active'",
      )
      .all(sessionId, at.projectId)
      .map((r) => r.content)
      .sort();
  }

  it('saves each extracted item as a reference memory attached to the session', async () => {
    const out = await capture(THREE, 'sess-aaaa1');
    expect(out).toMatchObject({ saved: 3, skipped: 0 });
    expect(out.ids).toHaveLength(3);
    expect(out.reason).toBeUndefined();
    for (const id of out.ids) {
      const m = memory.unsafeGetById(id)!;
      expect(m).toMatchObject({
        type: 'reference',
        sessionId: 'sess-aaaa1',
        tags: ['learning'],
        source: { tokenName: 'tester', agent: 'passive' },
      });
    }
  });

  it('returns a reason naming the heading, and resolves no session, when nothing is extracted', async () => {
    let resolved = 0;
    const out = await captureKeyLearnings(
      deps,
      {
        text: 'no heading here',
        tags: ['learning'],
        resolveSessionId: () => {
          resolved += 1;
          return 'sess-aaaa1';
        },
        source: { tokenName: 'tester', agent: 'passive' },
      },
      scope,
    );
    expect(out).toMatchObject({ saved: 0, skipped: 0, ids: [], candidatesDetected: 0 });
    expect(out.reason).toMatch(/## Key Learnings/);
    expect(resolved).toBe(0);
  });

  it('skips and counts an exact same-session duplicate, with a reason when every item is skipped', async () => {
    await capture(THREE, 'sess-aaaa1');
    const again = await capture(THREE, 'sess-aaaa1');
    expect(again).toMatchObject({ saved: 0, skipped: 3, ids: [] });
    expect(again.reason).toMatch(/already captured in this session/);
    expect(activeIn('sess-aaaa1')).toEqual(['alpha learning', 'beta learning', 'gamma learning']);
  });

  it('saves only the new items of a partly captured text, without a reason', async () => {
    await capture('## Key Learnings\n- alpha learning', 'sess-aaaa1');
    const out = await capture('## Key Learnings\n- alpha learning\n- delta learning', 'sess-aaaa1');
    expect(out).toMatchObject({ saved: 1, skipped: 1 });
    expect(out.reason).toBeUndefined();
    expect(activeIn('sess-aaaa1')).toEqual(['alpha learning', 'delta learning']);
  });

  it('skips per session: another session saves the same items again', async () => {
    await capture(THREE, 'sess-aaaa1');
    const other = await capture(THREE, 'sess-bbbb1');
    expect(other).toMatchObject({ saved: 3, skipped: 0 });
    expect(activeIn('sess-bbbb1')).toHaveLength(3);
  });

  it('skips nothing when no session resolves', async () => {
    await capture(THREE, null);
    const again = await capture(THREE, null);
    expect(again).toMatchObject({ saved: 3, skipped: 0 });
  });

  it('saves again once the earlier capture is no longer active', async () => {
    const first = await capture('## Key Learnings\n- alpha learning', 'sess-aaaa1');
    memory.archive(first.ids[0]!, scope);
    const again = await capture('## Key Learnings\n- alpha learning', 'sess-aaaa1');
    expect(again).toMatchObject({ saved: 1, skipped: 0 });
  });

  it('skips per scope: the same session id in another project does not suppress the save', async () => {
    seedProject(db.handle, 'p-other');
    const otherScope = projectScope('p-other');
    await capture(THREE, 'sess-aaaa1', otherScope);
    const out = await capture(THREE, 'sess-aaaa1');
    expect(out).toMatchObject({ saved: 3, skipped: 0 });
  });

  it('compares the redacted content, so a learning carrying a secret is still skipped', async () => {
    const text = `## Key Learnings\n- the deploy token is ${fakeGithubToken(7)}`;
    const first = await capture(text, 'sess-aaaa1');
    expect(first.saved).toBe(1);
    expect(memory.unsafeGetById(first.ids[0]!)!.content).toContain('[REDACTED');
    const again = await capture(text, 'sess-aaaa1');
    expect(again).toMatchObject({ saved: 0, skipped: 1 });
  });

  it('inserts once when two captures of one text run concurrently', async () => {
    const slow: CaptureKeyLearningsDeps = {
      ...deps,
      embedNow: () => new Promise((resolve) => setImmediate(() => resolve(false))),
    };
    const [a, b] = await Promise.all([
      capture(THREE, 'sess-aaaa1', scope, slow),
      capture(THREE, 'sess-aaaa1', scope, slow),
    ]);
    expect(a.saved + b.saved).toBe(3);
    expect(a.skipped + b.skipped).toBe(3);
    expect(activeIn('sess-aaaa1')).toEqual(['alpha learning', 'beta learning', 'gamma learning']);
  });

  it('runs the duplicate lookup inside the transaction that inserts the item', async () => {
    const seen: boolean[] = [];
    const lookup = repos.memory.hasActiveWithContentInSession.bind(repos.memory);
    repos.memory.hasActiveWithContentInSession = (...args) => {
      seen.push(db.handle.raw.inTransaction);
      return lookup(...args);
    };
    await capture(THREE, 'sess-aaaa1');
    expect(seen).toEqual([true, true, true]);
  });

  it('threads one redaction tally through every save', async () => {
    const redactions = new RedactionTally();
    await captureKeyLearnings(
      deps,
      {
        text: `## Key Learnings\n- token ${fakeGithubToken(1)}\n- token ${fakeGithubToken(2)}`,
        tags: ['learning'],
        resolveSessionId: () => null,
        source: { tokenName: 'tester', agent: 'passive' },
      },
      scope,
      redactions,
    );
    expect(redactions.list()).toEqual([{ kind: 'github_token', count: 4 }]);
  });
});
