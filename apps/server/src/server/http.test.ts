import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiagnostics } from '../db/diagnostics.js';
import { createRepositories } from '../db/repositories/index.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, mintTestToken, type TestDb } from '../test/index.js';
import { REMBRIC_VERSION } from '../version.js';

import { createHealthzHandler } from './http.js';

let db: TestDb;
let tokens: TokensService;
let projects: ProjectsService;
let app: Hono;

function mount(): Hono {
  const a = new Hono();
  a.get(
    '/healthz',
    createHealthzHandler({ tokens, projects, diagnostics: createDiagnostics(db.handle) }),
  );
  return a;
}

async function call(token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request('/healthz', { method: 'GET', headers });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

beforeEach(() => {
  db = createTestDb();
  tokens = new TokensService(createRepositories(db.handle.db));
  projects = new ProjectsService(createRepositories(db.handle.db));
  app = mount();
});

afterEach(() => db.cleanup());

describe('GET /healthz', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const r = await call();
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('missing_token');
  });

  it('returns 401 when the token is unknown', async () => {
    const r = await call('not-a-real-token');
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('token_invalid');
  });

  it('returns 401 when the Authorization header is malformed', async () => {
    const res = await app.request('/healthz', {
      method: 'GET',
      headers: { authorization: 'NotBearer something' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('malformed_authorization');
  });

  it('returns 200 with version on a valid admin token + healthy DB', async () => {
    const adminTok = mintTestToken(db.handle, '*');
    const r = await call(adminTok.plaintext);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version: REMBRIC_VERSION });
  });

  it('accepts a project-scoped token (availability is not project-scoped)', async () => {
    const proj = projects.create({ slug: 'health-proj' });
    const projTok = tokens.create({ name: 'proj-tok', scope: `project:${proj.id}` });
    const r = await call(projTok.plaintext);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version: REMBRIC_VERSION });
  });

  it('returns 503 when the database is unavailable', async () => {
    const adminTok = mintTestToken(db.handle, '*');
    db.handle.raw.close();
    const r = await call(adminTok.plaintext);
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('db_unavailable');
  });

  it('returns 401 when a revoked token is used', async () => {
    const tok = mintTestToken(db.handle, '*', 'will-be-revoked');
    tokens.revoke('will-be-revoked');
    const r = await call(tok.plaintext);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('token_revoked');
  });
});
