import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { tokens } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { agentSessionRow as row, createTestDb, type TestDb } from '../test/index.js';

import { createSessionsRouter } from './sessions.js';
import type { ResolvedSession } from './types.js';

const ENDED_AT = new Date(9_000);

function norm(html: string): string {
  return html.replace(/\s+/g, ' ');
}

/** The `<tr>` of one session in the list, so a `—` elsewhere cannot satisfy an assertion. */
function listRow(html: string, id: string): string {
  const norm_ = norm(html);
  const start = norm_.indexOf(`<tr data-href="/dashboard/sessions/${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = norm_.indexOf('</tr>', start);
  return norm_.slice(start, end);
}

describe('dashboard renders a resumed session as active', () => {
  let t: TestDb;
  let app: Hono;
  let svc: AgentSessionsService;

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

    t.handle.db
      .insert(tokens)
      .values([{ id: 'tk1', name: 'test', hash: 'x', scope: '*', createdAt: new Date(500) }])
      .run();
    t.handle.db
      .insert(agentSessions)
      .values([
        row({ id: 'S-ENDED', status: 'ended', endedAt: ENDED_AT }),
        row({ id: 'S-ABANDONED', status: 'abandoned', endedAt: ENDED_AT }),
      ])
      .run();

    svc = new AgentSessionsService(repos, t.handle.db);
    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createSessionsRouter({ repos, sessions, agentSessions: svc }));
  });

  afterEach(() => t.cleanup());

  it('list: the Ended cell becomes the empty placeholder and the Abandon form returns', async () => {
    const before = listRow(await (await app.request('/')).text(), 'S-ENDED');
    expect(before).toContain(`<td class="muted"><time datetime="${ENDED_AT.toISOString()}"`);
    expect(before).not.toContain('/dashboard/sessions/S-ENDED/abandon');

    svc.resume('S-ENDED', { tokenId: 'tk1' });

    const after = listRow(await (await app.request('/')).text(), 'S-ENDED');
    expect(after).toContain('<td class="muted">—</td>');
    expect(after).not.toContain('<time datetime="9');
    expect(after).toContain('action="/dashboard/sessions/S-ENDED/abandon"');
    expect(after).toContain('<span class="pill active">active</span>');
  });

  it('detail: the Ended row becomes the empty placeholder and the Abandon form returns', async () => {
    const before = norm(await (await app.request('/S-ABANDONED')).text());
    expect(before).toContain(
      `Ended </div><div class="v "><time datetime="${ENDED_AT.toISOString()}"`,
    );
    expect(before).not.toContain('/dashboard/sessions/S-ABANDONED/abandon');

    svc.resume('S-ABANDONED', { tokenId: 'tk1' });

    const after = norm(await (await app.request('/S-ABANDONED')).text());
    expect(after).toContain('Ended </div><div class="v ">—</div>');
    expect(after).toContain('action="/dashboard/sessions/S-ABANDONED/abandon"');
    expect(after).toContain('<span class="pill active">active</span>');
    expect(after).toContain('<b>STATUS</b> ACTIVE');
  });
});
