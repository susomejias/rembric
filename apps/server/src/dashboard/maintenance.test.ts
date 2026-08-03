import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiagnostics } from '../db/diagnostics.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { PromptsService } from '../services/prompts.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';
import { extractCsrf } from '../test/forms.js';

import { createMaintenanceRouter } from './maintenance.js';
import type { ResolvedSession } from './types.js';

describe('maintenance — on-demand backup', () => {
  let t: TestDb;
  let repos: Repositories;
  let sessions: SessionsService;
  let tokensSvc: TokensService;

  function appWithSession(session: ResolvedSession): Hono {
    const app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route(
      '/',
      createMaintenanceRouter({
        diagnostics: createDiagnostics(t.handle),
        sessions,
        agentSessions: new AgentSessionsService(repos, t.handle.db),
        memory: new MemoryService(repos, t.handle.db),
        prompts: new PromptsService(repos, t.handle.db),
        tokens: tokensSvc,
        dataDir: t.dataDir,
      }),
    );
    return app;
  }

  function sessionFor(scope: '*' | 'read:*'): ResolvedSession {
    const token = tokensSvc.create({ name: 'test', scope });
    const created = sessions.create(token.token.id);
    return { session: created.session, sessions, tokenId: token.token.id };
  }

  beforeEach(() => {
    t = createTestDb();
    repos = createRepositories(t.handle.db);
    sessions = new SessionsService(repos, randomBytes(32));
    tokensSvc = new TokensService(repos);
  });

  afterEach(() => t.cleanup());

  it('shows "no backup yet" before any backup is taken', async () => {
    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    expect(html).toContain('No on-demand backup yet.');
    expect(html).toContain('action="/dashboard/maintenance/backup"');
    expect(html).toContain('data-confirm-tone="warn"');
  });

  it('POST /backup writes a VACUUM INTO snapshot and the list page then shows it', async () => {
    const app = appWithSession(sessionFor('*'));
    const before = await (await app.request('/')).text();
    const csrf = extractCsrf(before, '/dashboard/maintenance/backup');

    const res = await app.request('/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/dashboard\/maintenance\?backed-up=\d+/);

    const backupsDir = join(t.dataDir, 'backups');
    expect(existsSync(backupsDir)).toBe(true);
    const files = readdirSync(backupsDir).filter((f) => f.startsWith('on-demand-'));
    expect(files).toHaveLength(1);

    const after = await (await app.request('/?backed-up=1234')).text();
    expect(after).toContain('BACKED UP');
    expect(after).toContain('Download');
    expect(after).not.toContain('No on-demand backup yet.');
  });

  it('keeps only the 3 most recent on-demand backups', async () => {
    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    const csrf = extractCsrf(html, '/dashboard/maintenance/backup');
    const body = new URLSearchParams({ csrf }).toString();

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/backup', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      expect(res.status).toBe(302);
    }

    const backupsDir = join(t.dataDir, 'backups');
    const files = readdirSync(backupsDir).filter((f) => f.startsWith('on-demand-'));
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('GET /backup/download serves the latest snapshot as an attachment', async () => {
    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    const csrf = extractCsrf(html, '/dashboard/maintenance/backup');
    await app.request('/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });

    const download = await app.request('/backup/download');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('content-disposition')).toContain('on-demand-');
    const buf = Buffer.from(await download.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('GET /backup/download/:file downloads a specific on-demand snapshot by name (fix-audited-defects)', async () => {
    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    const csrf = extractCsrf(html, '/dashboard/maintenance/backup');
    await app.request('/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });

    const backupsDir = join(t.dataDir, 'backups');
    const [file] = readdirSync(backupsDir).filter((f) => f.startsWith('on-demand-'));
    const download = await app.request(`/backup/download/${file}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(file!);
  });

  it('lists and serves a pre-update snapshot, previously undownloadable (fix-audited-defects)', async () => {
    const app = appWithSession(sessionFor('*'));
    const backupsDir = join(t.dataDir, 'backups');
    mkdirSync(backupsDir, { recursive: true });
    const preUpdateFile = 'pre-update-v0.24.0-1700000000000.sqlite';
    writeFileSync(join(backupsDir, preUpdateFile), 'not a real sqlite file, just bytes');

    const listPage = await (await app.request('/')).text();
    expect(listPage).toContain(`/dashboard/maintenance/backup/download/${preUpdateFile}`);
    expect(listPage).toContain('pre-update');

    const download = await app.request(`/backup/download/${preUpdateFile}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(preUpdateFile);
  });

  it('rejects a filename outside the producer-generated shape (path traversal)', async () => {
    const app = appWithSession(sessionFor('*'));
    const download = await app.request(
      `/backup/download/${encodeURIComponent('../../../../etc/passwd')}`,
    );
    expect(download.status).not.toBe(200);
    expect(download.headers.get('content-disposition')).toBeNull();
  });

  it('rejects a filename that does not exist even if shaped correctly', async () => {
    const app = appWithSession(sessionFor('*'));
    const download = await app.request('/backup/download/on-demand-9999999999999.sqlite');
    expect(download.status).not.toBe(200);
  });

  it('a non-admin (read:*) token cannot see or trigger a backup', async () => {
    const app = appWithSession(sessionFor('read:*'));
    const html = await (await app.request('/')).text();
    expect(html).toContain('requires an admin-scoped');

    const res = await app.request('/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'irrelevant' }).toString(),
    });
    expect(res.status).toBe(403);

    const download = await app.request('/backup/download');
    expect(download.status).toBe(403);
  });
});
