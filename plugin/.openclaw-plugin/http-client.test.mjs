import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHttpClient, readProjectSlug } from './http-client.mjs';

describe('readProjectSlug', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rembric-openclaw-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns slug when .rembric is valid', () => {
    writeFileSync(path.join(dir, '.rembric'), 'PROJECT_SLUG=foo-bar\n');
    expect(readProjectSlug(dir)).toBe('foo-bar');
  });

  it('returns null when file is missing', () => {
    expect(readProjectSlug(dir)).toBe(null);
  });

  it('returns null when PROJECT_SLUG fails regex (uppercase)', () => {
    writeFileSync(path.join(dir, '.rembric'), 'PROJECT_SLUG=Foo\n');
    expect(readProjectSlug(dir)).toBe(null);
  });

  it('returns null when PROJECT_SLUG ends with hyphen', () => {
    writeFileSync(path.join(dir, '.rembric'), 'PROJECT_SLUG=foo-\n');
    expect(readProjectSlug(dir)).toBe(null);
  });

  it('strips quotes', () => {
    writeFileSync(path.join(dir, '.rembric'), 'PROJECT_SLUG="foo-bar"\n');
    expect(readProjectSlug(dir)).toBe('foo-bar');
  });

  it('ignores other keys + comments', () => {
    writeFileSync(path.join(dir, '.rembric'), '# header comment\nOTHER=ignore\nPROJECT_SLUG=ok\n');
    expect(readProjectSlug(dir)).toBe('ok');
  });

  it('returns null for missing PROJECT_SLUG', () => {
    writeFileSync(path.join(dir, '.rembric'), 'OTHER=x\n');
    expect(readProjectSlug(dir)).toBe(null);
  });
});

describe('createHttpClient', () => {
  const baseConfig = { serverUrl: 'http://example.test', apiToken: 'rbr_abcdef' };
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('createSession POSTs to /api/<slug>/sessions with bearer auth', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, sessionId: 'sess-123' }),
      };
    });
    const client = createHttpClient(baseConfig);
    const res = await client.createSession({
      slug: 'foo',
      id: 'sess-12345678',
      cwd: '/path',
      agent: 'openclaw',
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: true, sessionId: 'sess-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://example.test/api/foo/sessions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer rbr_abcdef');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      id: 'sess-12345678',
      cwd: '/path',
      agent: 'openclaw',
    });
  });

  it('createSession omits null optional fields', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, sessionId: 'sess-123' }),
      };
    });
    const client = createHttpClient(baseConfig);
    await client.createSession({
      slug: 'foo',
      id: 'sess-12345678',
      cwd: null,
      agent: 'openclaw',
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      id: 'sess-12345678',
      agent: 'openclaw',
    });
  });

  it('surfaces 4xx errors as { ok: false }', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ ok: false, code: 'invalid_input', message: 'bad id' }),
    }));
    const client = createHttpClient(baseConfig);
    const res = await client.createSession({ slug: 'foo', id: 'short' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('invalid_input');
    expect(res.message).toBe('bad id');
  });

  it('surfaces network failures as { ok: false, code: "network_error" }', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network error');
    });
    const client = createHttpClient(baseConfig);
    const res = await client.createSession({ slug: 'foo', id: 'sess-12345678' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('network_error');
  });

  it('summarizeSession encodes slug and session id', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const client = createHttpClient(baseConfig);
    await client.summarizeSession({
      slug: 'foo',
      sessionId: 'sess-12345678',
      summary: 'transcript',
      final: false,
    });
    expect(calls[0].url).toBe('http://example.test/api/foo/sessions/sess-12345678/summary');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      summary: 'transcript',
      final: false,
    });
  });

  it('endSession with empty body posts {}', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const client = createHttpClient(baseConfig);
    await client.endSession({ slug: 'foo', sessionId: 'sess-12345678' });
    expect(calls[0].url).toBe('http://example.test/api/foo/sessions/sess-12345678/end');
    expect(JSON.parse(calls[0].init.body)).toEqual({});
  });
});
