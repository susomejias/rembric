import { randomBytes } from 'node:crypto';

import { SessionsService } from '@rembric/core';
import { TokensService } from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/db.js';

import { createConsolidationRouter } from './consolidation.js';
import type { ResolvedSession } from './types.js';

/**
 * `summary` is a plain text column: the sweep writes structured counts, but a
 * legacy LLM run wrote prose and nothing constrains the column to JSON. The
 * run detail page must fall back to the raw text rather than throw on parse.
 */
const MALFORMED_SUMMARY = '{not json <b>raw</b>';

describe('consolidation run summary fallback', () => {
  let t: TestDb;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
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

    repos.consolidation.insertRun({
      id: 'RUN-MALFORMED',
      startedAt: new Date(1_000),
      scope: 'global',
      summary: MALFORMED_SUMMARY,
    });

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route(
      '/',
      createConsolidationRouter({
        repos,
        sessions,
        triggerSweep: () => {
          throw new Error('not exercised');
        },
        undoRun: () => {
          throw new Error('not exercised');
        },
        undoOp: () => {
          throw new Error('not exercised');
        },
      }),
    );
  });

  afterEach(() => t.cleanup());

  it('renders a malformed stored summary escaped instead of a 500', async () => {
    const res = await app.request('/RUN-MALFORMED');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<pre>{not json &lt;b&gt;raw&lt;/b&gt;</pre>');
    expect(body).not.toContain('<b>raw</b>');
  });
});
