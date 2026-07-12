import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import type { RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { ProjectsService } from '../services/projects.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { pendingSuggestionGate } from './project-suggestion-gate.js';

/**
 * Unit tests for the project-suggestion gate. Asserts the gate is a
 * no-op in every scenario except the one specific shape the design
 * specifies as a guarded condition: path-less + no pinned project +
 * at-least-one-unminted suggestion.
 */

let db: TestDb;
let router: SessionRouter;
let projects: ProjectsService;

const TOKEN_ID = 'tok-fake';
const MCP_SESSION_ID = 'mcp-sess-fake';

function buildCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    token: { id: TOKEN_ID, name: 'fake-token' } as RequestContext['token'],
    scope: '*',
    project: null,
    requestedSlug: null,
    mcpSessionId: MCP_SESSION_ID,
    bridgeInstanceId: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = createTestDb();
  router = new SessionRouter();
  projects = new ProjectsService(createRepositories(db.handle.db));
});

afterEach(() => db.cleanup());

describe('pendingSuggestionGate', () => {
  it('returns null when the suggestions list is empty (no roots run)', () => {
    expect(pendingSuggestionGate(buildCtx(), { router, projects })).toBeNull();
  });

  it('returns null when the connection is path-scoped', () => {
    router.setSuggestedSlugs(TOKEN_ID, MCP_SESSION_ID, ['some-slug']);
    expect(
      pendingSuggestionGate(buildCtx({ requestedSlug: 'some-slug' }), { router, projects }),
    ).toBeNull();
  });

  it('returns null when a project is already pinned for the transport', () => {
    const proj = projects.create({ slug: 'already-pinned' });
    router.setActiveProject(TOKEN_ID, MCP_SESSION_ID, proj.id, 'tool-explicit');
    router.setSuggestedSlugs(TOKEN_ID, MCP_SESSION_ID, ['acme-research']);
    expect(pendingSuggestionGate(buildCtx(), { router, projects })).toBeNull();
  });

  it('returns null when every suggested slug already exists as a project', () => {
    projects.create({ slug: 'acme-research' });
    router.setSuggestedSlugs(TOKEN_ID, MCP_SESSION_ID, ['acme-research']);
    expect(pendingSuggestionGate(buildCtx(), { router, projects })).toBeNull();
  });

  it('returns the unminted slugs when at least one suggestion is missing', () => {
    router.setSuggestedSlugs(TOKEN_ID, MCP_SESSION_ID, ['acme-research', 'analytics']);
    const result = pendingSuggestionGate(buildCtx(), { router, projects });
    expect(result).toEqual(['acme-research', 'analytics']);
  });

  it('filters out suggestions that already resolve to a project', () => {
    projects.create({ slug: 'acme-research' });
    router.setSuggestedSlugs(TOKEN_ID, MCP_SESSION_ID, ['acme-research', 'analytics']);
    const result = pendingSuggestionGate(buildCtx(), { router, projects });
    expect(result).toEqual(['analytics']);
  });

  it('returns null when mcpSessionId is null (initialize-time call)', () => {
    router.setSuggestedSlugs(TOKEN_ID, MCP_SESSION_ID, ['acme-research']);
    expect(
      pendingSuggestionGate(buildCtx({ mcpSessionId: null }), { router, projects }),
    ).toBeNull();
  });
});
