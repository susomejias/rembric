import { randomBytes } from 'node:crypto';

import { deriveTitle } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import { SessionsService } from '@rembric/core';
import { TokensService } from '@rembric/core';
import { createRepositories, memory, memoryRelations, type NewMemory } from '@rembric/db';
import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/db.js';
import { seedProject } from '../test/default-project.js';

import { createJudgmentsRouter } from './judgments.js';
import type { ResolvedSession } from './types.js';

/**
 * `evidence` is a JSON-mode text column, so a stored string can still hold text
 * that is not itself JSON (the column parses, the inner text does not). The
 * detail page must fall back to the raw text rather than throw on the re-parse.
 */
const MALFORMED_EVIDENCE = '{not json <b>raw</b>';

function widget(id: string): NewMemory {
  const content = `widget ${id}`;
  return {
    id,
    title: deriveTitle(content),
    content,
    scope: 'project',
    projectId: 'p0',
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
  };
}

describe('judgment evidence fallback', () => {
  let t: TestDb;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
    seedProject(t.handle, 'p0', 'project-zero');
    const repos = createRepositories(t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokensSvc = new TokensService(repos, t.handle.db);
    const admin = tokensSvc.create({ name: 'admin', scope: '*' });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    t.handle.db
      .insert(memory)
      .values([widget('RS'), widget('RT')])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values({
        id: 'REL-MALFORMED',
        judgmentId: 'J-MALFORMED',
        sourceId: 'RS',
        targetId: 'RT',
        relation: null,
        status: 'pending',
        evidence: MALFORMED_EVIDENCE,
        createdAt: new Date(1_000),
      })
      .run();

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    const relations = new RelationsService(repos, t.handle.db);
    app.route('/', createJudgmentsRouter({ repos, relations, sessions }));
  });

  afterEach(() => t.cleanup());

  it('renders a malformed stored evidence value escaped instead of a 500', async () => {
    const res = await app.request('/REL-MALFORMED');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<pre>{not json &lt;b&gt;raw&lt;/b&gt;</pre>');
    expect(body).not.toContain('<b>raw</b>');
  });
});
