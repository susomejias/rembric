import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreatedToken } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '../app/healthz/route';
import { getServices } from '../lib/services';
import { REMBRIC_VERSION } from '../lib/version';

import { mintTestToken } from './tokens';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {}
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
}

const ORIGIN = 'http://127.0.0.1:8787';

let dataDir: string;

beforeEach(() => {
  resetAppGlobals();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-healthz-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  delete process.env['REMBRIC_PUBLIC_URL'];
  process.env['AUTH_LOCKOUT_MAX_FAILURES'] = '2';
});

afterEach(() => {
  resetAppGlobals();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['AUTH_LOCKOUT_MAX_FAILURES'];
  rmSync(dataDir, { recursive: true, force: true });
});

function mintAdmin(name = 'healthz-admin'): CreatedToken {
  return mintTestToken(getServices().db, { scope: '*' }, name);
}

async function call(token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const response = await GET(new Request(`${ORIGIN}/healthz`, { method: 'GET', headers }));
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

describe('GET /healthz', () => {
  it('answers 200 with the running release identity for a valid bearer', async () => {
    const admin = mintAdmin();
    const r = await call(admin.plaintext);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version: REMBRIC_VERSION });
  });

  it('reports a version that parses as a release, never the 0.0.0 sentinel', () => {
    expect(REMBRIC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REMBRIC_VERSION).not.toBe('0.0.0');
  });

  it('opens the resolved data dir, applying migrations', async () => {
    expect(existsSync(join(dataDir, 'data.db'))).toBe(false);
    expect((await call()).status).toBe(401);
    expect(existsSync(join(dataDir, 'data.db'))).toBe(true);
  });

  it('answers 401 missing_token when the Authorization header is absent', async () => {
    const r = await call();
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      ok: false,
      code: 'missing_token',
      message: 'missing Authorization header',
    });
  });

  it('answers 401 token_invalid for an unknown bearer', async () => {
    const r = await call('not-a-real-token');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      ok: false,
      code: 'token_invalid',
      message: 'token not recognized',
    });
  });

  it('answers 401 malformed_authorization for a non-bearer header', async () => {
    const response = await GET(
      new Request(`${ORIGIN}/healthz`, {
        method: 'GET',
        headers: { authorization: 'NotBearer something' },
      }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('malformed_authorization');
  });

  it('answers 401 token_revoked for a revoked bearer', async () => {
    const services = getServices();
    const created = services.tokens.create({ name: 'healthz-revoked', scope: '*' });
    services.tokens.revoke('healthz-revoked');
    const r = await call(created.plaintext);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      ok: false,
      code: 'token_revoked',
      message: 'token has been revoked',
    });
  });

  it('answers 429 rate_limited after the lockout threshold of failed attempts', async () => {
    const first = await call('nope');
    const second = await call('nope');
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);

    const response = await GET(
      new Request(`${ORIGIN}/healthz`, {
        method: 'GET',
        headers: { authorization: 'Bearer nope' },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(await response.json()).toEqual({
      ok: false,
      code: 'rate_limited',
      message: 'too many failed attempts',
    });
  });

  it('answers 503 db_unavailable when the database connection is dead', async () => {
    const admin = mintAdmin();
    expect((await call(admin.plaintext)).status).toBe(200);

    const handle = globalForApp.__rembricDb;
    if (!handle) throw new Error('fixture: GET /healthz did not open the database');
    handle.raw.close();

    const r = await call(admin.plaintext);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, code: 'db_unavailable' });
  });
});
