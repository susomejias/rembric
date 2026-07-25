import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildObservabilityHandlers, parseKeyLearnings } from './observability-tools.js';

describe('parseKeyLearnings — capture_passive parser', () => {
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

  // fix-audited-defects: matching used to be case-sensitive and H2-only, so
  // ordinary formatting variation silently discarded the whole capture.
  it('is case-insensitive on the heading (fix-audited-defects)', () => {
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

describe('memory.capture_passive — handler-level (fix-audited-defects)', () => {
  let db: TestDb;
  let repos: Repositories;
  let memory: MemoryService;
  let handlers: ReturnType<typeof buildObservabilityHandlers>;

  function fakeContext(): RequestContext {
    const token: Token = {
      id: 'tk_capture_passive_test',
      name: 'tester',
      hash: 'hash',
      scope: '*',
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    return { token, scope: '*', project: null, requestedSlug: null, mcpSessionId: null };
  }

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    memory = new MemoryService(repos, db.handle.db);
    const relations = new RelationsService(repos, db.handle.db);
    const projects = new ProjectsService(repos);
    const agentSessions = new AgentSessionsService(repos, db.handle.db);
    handlers = buildObservabilityHandlers({
      memory,
      agentSessions,
      repos,
      router: new SessionRouter(),
      projects,
      doctor: () => ({
        db: { open: true, journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
        embeddings: { model: 'test', backlog: 0 },
        entities: { backlog: 0 },
        consolidation: { lastRunAt: null, lastRunOps: {} },
        sessions: { active: 0 },
        review: { needsReview: 0, pendingJudgments: 0 },
        warnings: [],
      }),
      relations,
      candidates: { perSaveMax: 5 },
      // No embedNow: exercises the FTS-only detection path deterministically,
      // matching save-time-candidates.test.ts's own no-embedder convention.
    });
  });

  afterEach(() => db.cleanup());

  it('routes through the shared curation pipeline and surfaces a candidate conflicting with an existing memory', async () => {
    // Same fixture shape as save-time-candidates.test.ts's FTS-candidate test:
    // near-identical title/content reliably clears the (still-unfixed,
    // deferred) FTS threshold at this small a corpus size.
    memory.save(
      {
        type: 'feedback',
        title: 'Use two-space indentation always',
        content: 'use two-space indentation always',
      },
      SCOPE_GLOBAL,
    );

    const text =
      '## Key Learnings:\n\n1. use two-space indentation always with single quotes\n2. a second, unrelated learning';

    const r = await runWithContext(fakeContext(), () => handlers.capturePassive({ text }));
    const out = parse<{
      saved: number;
      ids: string[];
      candidates?: { targetId: string; source: string }[];
    }>(r);

    expect(out.saved).toBe(2);
    expect(out.ids).toHaveLength(2);
    expect(out.candidates).toBeDefined();
    expect(out.candidates!.length).toBeGreaterThanOrEqual(1);
    expect(out.candidates!.every((c) => c.source === 'fts' || c.source === 'vec')).toBe(true);

    // Every saved row went through saveWithTopicKey, not a bare insert — it
    // has whatever save-time bookkeeping the real save path applies.
    for (const id of out.ids) {
      expect(memory.unsafeGetById(id)).toBeDefined();
    }
  });

  it('reports an explicit reason instead of a bare {saved:0} when no heading is found', async () => {
    const r = await runWithContext(fakeContext(), () =>
      handlers.capturePassive({ text: 'no learnings heading anywhere in this text' }),
    );
    const out = parse<{ saved: number; ids: string[]; reason?: string }>(r);

    expect(out.saved).toBe(0);
    expect(out.ids).toEqual([]);
    expect(out.reason).toBeTruthy();
    expect(out.reason).toMatch(/Key Learnings/);
  });
});

function parse<T>(resp: unknown): T {
  const r = resp as { content: { text: string }[] };
  return JSON.parse(r.content[0]?.text ?? '') as T;
}
