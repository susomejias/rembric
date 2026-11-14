import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { TokensService } from '@rembric/core';
import { createDb, createRepositories, type DbHandle } from '@rembric/db';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { GET as routeGet, POST as routePost } from '../app/(oauth)/[...path]/route';
import { getServices } from '../lib/services';

const ADMIN_TOKEN = 'web-oauth-router-admin-token-long-enough';
const ISSUER = 'http://127.0.0.1:3100';
const REDIRECT = 'https://client.example/callback';
const BODY_LIMIT_BYTES = 100 * 1024;

let dataDir: string;
let handle: DbHandle;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-oauth-router-'));
  handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  new TokensService(createRepositories(handle.db), handle.db).bootstrapAdmin(ADMIN_TOKEN);
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;
  delete process.env['REMBRIC_SESSION_SECRET'];
  process.env['REMBRIC_PUBLIC_URL'] = ISSUER;
});

afterAll(() => {
  try {
    handle.close();
  } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  delete process.env['REMBRIC_PUBLIC_URL'];
});

function post(path: string, contentType: string, body: string, hop?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (hop !== undefined) headers['x-forwarded-for'] = hop;
  const request = new Request(`${ISSUER}${path}`, { method: 'POST', headers, body });
  return routePost(request, { params: Promise.resolve({ path: [path.slice(1)] }) });
}

function register(payload: unknown, hop?: string): Promise<Response> {
  return post('/register', 'application/json', JSON.stringify(payload), hop);
}

describe('domain errors raised from another bundle copy of @rembric/core', () => {
  it('answer 400 with their own code at /token instead of 500 server_error', async () => {
    const registered = await register({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const { client_id } = (await registered.json()) as { client_id: string };
    const oauth = getServices().oauth;
    if (oauth === null) throw new Error('fixture: OAuth is disabled');
    const foreign = Object.assign(new Error('authorization code not recognized'), {
      name: 'OAuthError',
      code: 'invalid_grant',
    });
    const spy = vi.spyOn(oauth, 'challengeForCode').mockImplementation(() => {
      throw foreign;
    });
    onTestFinished(() => spy.mockRestore());

    const response = await post(
      '/token',
      'application/x-www-form-urlencoded',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'not-a-code',
        code_verifier: 'verifier',
        client_id,
      }).toString(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'authorization code not recognized',
    });
  });

  it('keeps an error that is not a domain error a 500 server_error', async () => {
    const registered = await register({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const { client_id } = (await registered.json()) as { client_id: string };
    const oauth = getServices().oauth;
    if (oauth === null) throw new Error('fixture: OAuth is disabled');
    const spy = vi.spyOn(oauth, 'challengeForCode').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { code: 'invalid_grant' });
    });
    onTestFinished(() => spy.mockRestore());

    const response = await post(
      '/token',
      'application/x-www-form-urlencoded',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'not-a-code',
        code_verifier: 'verifier',
        client_id,
      }).toString(),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'database is locked',
    });
  });
});

describe('client registration refused by the domain', () => {
  it('answers 400 invalid_request for a non-loopback http redirect_uri', async () => {
    const response = await register(
      { redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' },
      '198.51.100.51',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: "redirect_uri 'http://evil.example/cb' must be https (or http loopback)",
    });
  });

  it('answers 400 invalid_request for a confidential client', async () => {
    const response = await register(
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' },
      '198.51.100.51',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'only public clients (token_endpoint_auth_method=none) are supported',
    });
  });

  it('registers a public client with an https redirect_uri', async () => {
    const response = await register(
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
      '198.51.100.51',
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
  });
});

describe('request body limit', () => {
  function paddedRegistration(totalBytes: number): string {
    const prefix = JSON.stringify({ redirect_uris: [] }).slice(0, -1);
    const skeleton = `${prefix},"pad":""}`;
    return `${prefix},"pad":"${'a'.repeat(totalBytes - skeleton.length)}"}`;
  }

  it('parses a body of exactly 100 KiB', async () => {
    const response = await post(
      '/register',
      'application/json',
      paddedRegistration(BODY_LIMIT_BYTES),
      '198.51.100.31',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'at least one redirect_uri is required',
    });
  });

  it('refuses a body one byte over 100 KiB with the internal-error body', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());

    const response = await post(
      '/register',
      'application/json',
      paddedRegistration(BODY_LIMIT_BYTES + 1),
      '198.51.100.31',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'internal_error' });
  });
});

describe('request body parsing', () => {
  async function publicClient(hop: string): Promise<string> {
    const registered = await register(
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
      hop,
    );
    return ((await registered.json()) as { client_id: string }).client_id;
  }

  it('refuses a repeated form parameter instead of keeping the last value', async () => {
    const clientId = await publicClient('198.51.100.41');
    const form = `grant_type=refresh_token&grant_type=refresh_token&refresh_token=unknown&client_id=${clientId}`;

    const response = await post(
      '/token',
      'application/x-www-form-urlencoded',
      form,
      '198.51.100.41',
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('refuses a declared length over 100 KiB before reading the body', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    const request = new Request(`${ISSUER}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(BODY_LIMIT_BYTES + 1),
        'x-forwarded-for': '198.51.100.44',
      },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });

    const response = await routePost(request, { params: Promise.resolve({ path: ['register'] }) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'internal_error' });
  });

  function streamed(
    chunks: number,
    chunkBytes: number,
  ): {
    body: ReadableStream<Uint8Array>;
    pulled: () => number;
    cancelled: () => boolean;
  } {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, pulled: () => sent, cancelled: () => cancelled };
  }

  function streamedPost(path: string, body: ReadableStream<Uint8Array>): Promise<Response> {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      duplex: 'half',
    };
    const request = new Request(`${ISSUER}${path}`, init);
    return routePost(request, { params: Promise.resolve({ path: [path.slice(1)] }) });
  }

  it('stops reading a streamed body without a declared length once it passes 100 KiB', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    const chunkBytes = 16 * 1024;
    const source = streamed(640, chunkBytes);

    const response = await streamedPost('/token', source.body);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'internal_error' });
    expect(source.pulled()).toBeLessThanOrEqual(BODY_LIMIT_BYTES / chunkBytes + 2);
    expect(source.cancelled()).toBe(true);
  });

  it('reads a streamed body without a declared length that stays under 100 KiB', async () => {
    const source = streamed(4, 1024);

    const response = await streamedPost('/token', source.body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(source.pulled()).toBe(4);
  });

  it('refuses a compressed body with the internal-error body', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    const clientId = await publicClient('198.51.100.43');
    const request = new Request(`${ISSUER}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-encoding': 'gzip',
        'x-forwarded-for': '198.51.100.43',
      },
      body: gzipSync(`grant_type=refresh_token&refresh_token=unknown&client_id=${clientId}`),
    });

    const response = await routePost(request, { params: Promise.resolve({ path: ['token'] }) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'internal_error' });
  });
});

describe('rate-limit identity', () => {
  async function exhaustRegistration(hop: string): Promise<void> {
    for (let sent = 0; sent < 20; sent += 1) {
      const response = await register({ redirect_uris: [] }, hop);
      expect(response.status).not.toBe(429);
      await response.arrayBuffer();
    }
  }

  it('counts every IPv6 address of one /56 against one budget', async () => {
    await exhaustRegistration('2001:db8:1:100::1');

    expect((await register({ redirect_uris: [] }, '2001:db8:1:1ff::2')).status).toBe(429);
    expect((await register({ redirect_uris: [] }, '2001:db8:1:200::1')).status).not.toBe(429);
  });

  it('counts an IPv4-mapped IPv6 address against its IPv4 budget', async () => {
    await exhaustRegistration('198.51.100.77');

    expect((await register({ redirect_uris: [] }, '::ffff:198.51.100.77')).status).toBe(429);
    expect((await register({ redirect_uris: [] }, '198.51.100.78')).status).not.toBe(429);
  });
});

describe('rate limiter failure', () => {
  it('answers the internal-error body instead of a 429', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = vi
      .spyOn(RateLimiterMemory.prototype, 'consume')
      .mockRejectedValue(new Error('limiter storage failed'));
    onTestFinished(() => {
      broken.mockRestore();
      quiet.mockRestore();
    });

    const response = await register({ redirect_uris: [REDIRECT] }, '198.51.100.61');

    expect(broken).toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'internal_error' });
  });
});

describe('redirect_uri matching at /authorize', () => {
  async function authorize(clientId: string, redirectUri: string): Promise<Response> {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
    return routeGet(new Request(`${ISSUER}/authorize?${query.toString()}`), {
      params: Promise.resolve({ path: ['authorize'] }),
    });
  }

  async function clientFor(redirectUri: string): Promise<string> {
    const response = await register({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    });
    return ((await response.json()) as { client_id: string }).client_id;
  }

  it('accepts a loopback redirect_uri on any port', async () => {
    const id = await clientFor('http://127.0.0.1:1234/callback');

    const response = await authorize(id, 'http://127.0.0.1:9999/callback');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(
      /^http:\/\/127\.0\.0\.1:3100\/dashboard\/oauth\/consent\?areq=/,
    );
  });

  it('refuses a non-loopback redirect_uri on another port', async () => {
    const id = await clientFor(REDIRECT);

    const response = await authorize(id, 'https://client.example:8443/callback');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Unregistered redirect_uri',
    });
  });
});
