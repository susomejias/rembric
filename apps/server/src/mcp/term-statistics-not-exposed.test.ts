import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { projectScope, type Scope } from '../services/scope.js';
import { createTestDb, defaultProject, mintTestToken, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';
import { buildObservabilityHandlers } from './observability-tools.js';

/**
 * The relevance level's term statistics are index-global aggregates read
 * outside scope resolution. memory/spec.md bounds that exception by forbidding
 * them from reaching a payload: "No response field SHALL expose a raw term
 * statistic." Asserted over the SERIALIZED text every tool actually returns,
 * not over the types.
 */

const FORBIDDEN = [
  /"documentCount"/,
  /"documentTotal"/,
  /"documentFrequenc/,
  /"termWeight/,
  /"idf"/,
  /"\w*[dD]ocFreq/,
];

let db: TestDb;
/** The scope a path-less connection resolves to: the default project. */
let defaultScope: Scope;
let repos: Repositories;
let memory: MemoryService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let observability: ReturnType<typeof buildObservabilityHandlers>;
let token: Token;

function context(): RequestContext {
  return {
    token,
    scope: '*',
    project: null,
    requestedSlug: null,
    mcpSessionId: 'mcp-sess-term-stats',
  };
}

function text(resp: unknown): string {
  return (resp as { content: { text: string }[] }).content[0]?.text ?? '';
}

beforeEach(() => {
  db = createTestDb();
  defaultScope = projectScope(defaultProject(db.handle).id);
  repos = createRepositories(db.handle.db);
  const projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  token = mintTestToken(db.handle, { scope: '*' }).token;
  const agentSessions = new AgentSessionsService(repos, db.handle.db);
  const relations = new RelationsService(repos, db.handle.db);
  const router = new SessionRouter();
  const deps = {
    repos,
    memory,
    projects,
    agentSessions,
    prompts: new PromptsService(repos, db.handle.db),
    relations,
    router,
  };
  handlers = buildMemoryHandlers({ ...deps, orphanAfterMs: 86_400_000 });
  observability = buildObservabilityHandlers({
    ...deps,
    doctor: () => {
      throw new Error('memory.doctor is not under test here');
    },
  });
});

afterEach(() => db.cleanup());

describe('term statistics are not a response channel', () => {
  it('no payload carries a document frequency, a document total or a per-term weight', async () => {
    const rows = [
      { title: 'Ubiquitous scheduler note', content: 'ubiquitousterm scheduler cron pipeline' },
      { title: 'Rare deploy note', content: 'ubiquitousterm rareterm deploy pipeline' },
      { title: 'Third note', content: 'ubiquitousterm retry backoff' },
    ].map((r) => memory.save({ type: 'project', ...r }, defaultScope));

    const payloads = [
      text(
        await runWithContext(context(), () =>
          handlers.search({ query: 'ubiquitousterm rareterm pipeline' }),
        ),
      ),
      text(await runWithContext(context(), () => handlers.context({}))),
      text(await runWithContext(context(), () => handlers.get({ id: rows[0]!.id }))),
      text(
        await runWithContext(context(), () =>
          handlers.save({
            scope: 'global',
            type: 'project',
            title: 'A fourth note',
            content: 'rareterm pipeline',
          }),
        ),
      ),
      text(await runWithContext(context(), () => observability.stats())),
    ];

    // Control: the probe is reading real payloads, so a match would mean something.
    expect(payloads.every((p) => p.length > 0)).toBe(true);
    expect(payloads[0]).toContain('ubiquitousterm');

    for (const payload of payloads) {
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(payload), `${pattern} appeared in ${payload.slice(0, 200)}`).toBe(
          false,
        );
      }
    }
  });
});
