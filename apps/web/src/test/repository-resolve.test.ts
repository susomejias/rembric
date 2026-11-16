import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CreatedToken } from '@rembric/core';
import { type Project } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET, POST } from '../app/api/repositories/resolve/route';
import { resetMcpRateLimiterForTests } from '../lib/rate-limit';
import { getServices } from '../lib/services';

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
const F = 'a1'.repeat(20);
const G = 'b2'.repeat(32);
const ENV_KEYS = [
  'MAX_BODY_BYTES',
  'AUTH_LOCKOUT_MAX_FAILURES',
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_BURST',
  'RATE_LIMIT_RPS',
] as const;

let dataDir: string;
let services: ReturnType<typeof getServices>;
let shop: Project;
let sandbox: Project;
let secret: Project;
let shopWriter: CreatedToken;
let bothWriter: CreatedToken;
let shopReader: CreatedToken;

function boot(): void {
  resetAppGlobals();
  services = getServices();
  shop = services.projects.create({ slug: 'shop' });
  sandbox = services.projects.create({ slug: 'sandbox' });
  secret = services.projects.create({ slug: 'secret' });
  shopWriter = services.tokens.create({ name: 'shop-writer', project: shop, access: 'write' });
  bothWriter = services.tokens.create({
    name: 'both-writer',
    projects: [shop, sandbox],
    access: 'write',
  });
  shopReader = services.tokens.create({ name: 'shop-reader', project: shop, access: 'read' });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-resolve-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  delete process.env['REMBRIC_PUBLIC_URL'];
  boot();
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  resetAppGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
  resetMcpRateLimiterForTests();
  delete process.env['REMBRIC_DATA_DIR'];
  rmSync(dataDir, { recursive: true, force: true });
});

function resolveRequest(token: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`${ORIGIN}/api/repositories/resolve`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function resolve(
  token: string | null,
  body: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await POST(resolveRequest(token, body));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: res.status, text, json };
}

function bind(fingerprint: string, project: Project, remotes: string[] = []): void {
  services.repositoryBindings.bind({ fingerprint, projectId: project.id, createdBy: 'test' });
  if (remotes.length > 0) {
    services.repos.repositoryBindings.updateRemotes(fingerprint, project.id, remotes);
  }
}

function pendingRows(): Record<string, unknown>[] {
  return services.db.raw
    .prepare<[], Record<string, unknown>>('SELECT * FROM repository_pending ORDER BY id')
    .all();
}

function tablesDump(): string {
  return JSON.stringify(
    ['project_repositories', 'repository_pending', 'repository_pending_tokens'].map((t) =>
      services.db.raw.prepare(`SELECT * FROM ${t}`).all(),
    ),
  );
}

describe('POST /api/repositories/resolve', () => {
  it('a bound fingerprint resolves', async () => {
    bind(F, shop, ['github.com/acme/shop']);
    const r = await resolve(shopWriter.plaintext, {
      fingerprint: F,
      remotes: ['github.com/acme/shop'],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, outcome: 'bound', slug: 'shop' });
  });

  it('an unbound fingerprint is recorded as pending', async () => {
    const r = await resolve(shopWriter.plaintext, {
      fingerprint: G,
      remotes: ['github.com/acme/tools'],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, outcome: 'unbound', reason: 'not_bound' });
    const row = services.repos.pendingRepositories.findByIdentity(G, 'unbound', null);
    expect(row?.remotes).toEqual(['github.com/acme/tools']);
  });

  it('an explicit selection is echoed with its conflict and records a suggestion', async () => {
    bind(F, shop);
    const r = await resolve(bothWriter.plaintext, {
      fingerprint: F,
      remotes: [],
      explicit: { slug: 'sandbox', source: 'rembric-root' },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      outcome: 'explicit',
      slug: 'sandbox',
      conflict: { boundSlugs: ['shop'] },
    });
    expect(
      services.repos.pendingRepositories.findByIdentity(F, 'suggestion', sandbox.id),
    ).toBeDefined();
    expect(services.repos.repositoryBindings.unsafeListAllForFingerprint(F)).toHaveLength(1);
  });

  it('two visible bindings answer 409 repository_ambiguous naming them', async () => {
    bind(F, shop);
    bind(F, sandbox);
    const r = await resolve(bothWriter.plaintext, { fingerprint: F, remotes: [] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      ok: false,
      code: 'repository_ambiguous',
      slugs: ['sandbox', 'shop'],
    });
    const control = await resolve(shopWriter.plaintext, { fingerprint: F, remotes: [] });
    expect(control.json).toEqual({ ok: true, outcome: 'bound', slug: 'shop' });
  });

  it('answers byte-identically for a binding the token cannot read and for no binding', async () => {
    bind(F, secret);
    const invisible = await resolve(shopWriter.plaintext, { fingerprint: F, remotes: [] });
    const none = await resolve(shopWriter.plaintext, { fingerprint: G, remotes: [] });
    expect(invisible.status).toBe(none.status);
    expect(invisible.text).toBe(none.text);
    expect(invisible.text).not.toContain('secret');
  });

  it('a teammate resolves an admin binding with a read grant, recording nothing', async () => {
    bind(F, shop);
    const r = await resolve(shopReader.plaintext, { fingerprint: F, remotes: [] });
    expect(r.json).toEqual({ ok: true, outcome: 'bound', slug: 'shop' });
  });

  it('a read-only token resolves without creating or refreshing a pending row', async () => {
    const created = await resolve(shopReader.plaintext, {
      fingerprint: G,
      remotes: ['github.com/acme/tools'],
    });
    expect(created.json).toEqual({ ok: true, outcome: 'unbound', reason: 'not_bound' });
    await resolve(shopReader.plaintext, {
      fingerprint: G,
      remotes: [],
      explicit: { slug: 'shop', source: 'rembric-root' },
    });
    expect(pendingRows()).toEqual([]);

    await resolve(shopWriter.plaintext, { fingerprint: G, remotes: [] });
    const before = tablesDump();
    await new Promise((r) => setTimeout(r, 5));
    await resolve(shopReader.plaintext, { fingerprint: G, remotes: ['github.com/new/remote'] });
    expect(tablesDump()).toBe(before);
  });

  it('a project-scoped writer records a suggestion, not a binding', async () => {
    const r = await resolve(shopWriter.plaintext, {
      fingerprint: G,
      remotes: [],
      explicit: { slug: 'shop', source: 'rembric-root' },
    });
    expect(r.json).toEqual({ ok: true, outcome: 'explicit', slug: 'shop', conflict: null });
    expect(
      services.repos.pendingRepositories.findByIdentity(G, 'suggestion', shop.id),
    ).toBeDefined();
    expect(services.repos.repositoryBindings.unsafeListAllForFingerprint(G)).toEqual([]);
  });

  it('a repository without fingerprint is unbound with no_fingerprint and records nothing', async () => {
    const r = await resolve(shopWriter.plaintext, {
      fingerprint: null,
      remotes: [],
      rootName: 'shop',
    });
    expect(r.json).toEqual({ ok: true, outcome: 'unbound', reason: 'no_fingerprint' });
    expect(pendingRows()).toEqual([]);
  });

  it('strips credentials so no stored value or response carries them', async () => {
    const r = await resolve(shopWriter.plaintext, {
      fingerprint: G,
      remotes: ['https://user:secret@git.example.com/acme/shop.git'],
    });
    expect(r.text).not.toContain('secret');
    expect(services.repos.pendingRepositories.findByIdentity(G, 'unbound', null)?.remotes).toEqual([
      'git.example.com/acme/shop',
    ]);
    expect(tablesDump()).not.toContain('secret');
  });

  it('stores the root basename only for a pending row without a remote', async () => {
    await resolve(shopWriter.plaintext, { fingerprint: G, remotes: [], rootName: 'shop' });
    expect(services.repos.pendingRepositories.findByIdentity(G, 'unbound', null)?.rootName).toBe(
      'shop',
    );
  });

  describe('strict validation', () => {
    const invalid: Record<string, unknown> = {
      'uppercase fingerprint': { fingerprint: 'XYZ', remotes: [] },
      'uppercase hex fingerprint': { fingerprint: 'A'.repeat(40), remotes: [] },
      'short fingerprint': { fingerprint: 'a'.repeat(39), remotes: [] },
      'nine remotes': {
        fingerprint: G,
        remotes: Array.from({ length: 9 }, (_, i) => `github.com/acme/r${i}`),
      },
      'extra path property': { fingerprint: G, remotes: [], path: '/home/alice/shop' },
      'missing remotes': { fingerprint: G },
      'missing fingerprint': { remotes: [] },
      'overlong remote': { fingerprint: G, remotes: [`github.com/${'x'.repeat(512)}`] },
      'root name with a slash': { fingerprint: G, remotes: [], rootName: 'home/shop' },
      'root name with a backslash': { fingerprint: G, remotes: [], rootName: 'home\\shop' },
      'overlong root name': { fingerprint: G, remotes: [], rootName: 'x'.repeat(256) },
      'explicit with a bad source': {
        fingerprint: G,
        remotes: [],
        explicit: { slug: 'shop', source: 'guess' },
      },
      'explicit with a bad slug': {
        fingerprint: G,
        remotes: [],
        explicit: { slug: 'Shop!', source: 'env' },
      },
      'explicit with an extra key': {
        fingerprint: G,
        remotes: [],
        explicit: { slug: 'shop', source: 'env', path: '/x' },
      },
      'not an object': [G],
      'not json': 'not json',
    };

    it.each(Object.keys(invalid))('refuses %s with 400 and records nothing', async (name) => {
      const r = await resolve(shopWriter.plaintext, invalid[name]);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(pendingRows()).toEqual([]);
    });

    it('control: the same valid request succeeds and records the sighting', async () => {
      const r = await resolve(shopWriter.plaintext, {
        fingerprint: G,
        remotes: Array.from({ length: 8 }, (_, i) => `github.com/acme/r${i}`),
        rootName: 'shop',
        explicit: null,
      });
      expect(r.status).toBe(200);
      expect(pendingRows()).toHaveLength(1);
    });
  });

  describe('the same gates as /api/<slug>/*', () => {
    it('refuses a missing or unknown bearer with 401', async () => {
      expect((await resolve(null, { fingerprint: G, remotes: [] })).status).toBe(401);
      const bad = await resolve('not-a-token', { fingerprint: G, remotes: [] });
      expect(bad.status).toBe(401);
      expect(pendingRows()).toEqual([]);
    });

    it('locks out an identity after repeated failed authentications', async () => {
      process.env['AUTH_LOCKOUT_MAX_FAILURES'] = '2';
      resetAppGlobals();
      services = getServices();
      await resolve('bad-1', { fingerprint: G, remotes: [] });
      await resolve('bad-2', { fingerprint: G, remotes: [] });
      const locked = await resolve(shopWriter.plaintext, { fingerprint: G, remotes: [] });
      expect(locked.status).toBe(429);
      expect(locked.json).toMatchObject({ code: 'rate_limited' });
    });

    it('applies the per-token rate limit when enabled', async () => {
      process.env['RATE_LIMIT_ENABLED'] = 'true';
      process.env['RATE_LIMIT_BURST'] = '1';
      process.env['RATE_LIMIT_RPS'] = '0.01';
      resetMcpRateLimiterForTests();
      const first = await resolve(shopWriter.plaintext, { fingerprint: G, remotes: [] });
      expect(first.status).toBe(200);
      const second = await resolve(shopWriter.plaintext, { fingerprint: G, remotes: [] });
      expect(second.status).toBe(429);
      const otherToken = await resolve(bothWriter.plaintext, { fingerprint: G, remotes: [] });
      expect(otherToken.status).toBe(200);
    });

    it('refuses a body over MAX_BODY_BYTES with 413', async () => {
      process.env['MAX_BODY_BYTES'] = '64';
      const r = await resolve(shopWriter.plaintext, {
        fingerprint: G,
        remotes: ['github.com/acme/tools'],
      });
      expect(r.status).toBe(413);
      expect(r.json).toMatchObject({ code: 'payload_too_large' });
      delete process.env['MAX_BODY_BYTES'];
      const control = await resolve(shopWriter.plaintext, {
        fingerprint: G,
        remotes: ['github.com/acme/tools'],
      });
      expect(control.status).toBe(200);
    });

    it('answers other methods with not_found', () => {
      const res = GET(
        new Request(`${ORIGIN}/api/repositories/resolve`, {
          headers: { authorization: `Bearer ${shopWriter.plaintext}` },
        }),
      );
      expect(res.status).toBe(404);
    });
  });
});
