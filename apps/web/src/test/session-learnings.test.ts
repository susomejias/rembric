import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { KEY_LEARNINGS_HEADING_HINT, type CreatedToken } from '@rembric/core';
import type * as CoreModule from '@rembric/core';
import { projectScope, type MemorySource, type Project } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GET as learningsGet,
  POST as learningsPost,
} from '../app/api/[slug]/sessions/[id]/learnings/route';
import { POST as sessionsPost } from '../app/api/[slug]/sessions/route';
import { DELETE as mcpDelete, GET as mcpGet, POST as mcpPost } from '../app/mcp/[[...path]]/route';
import { getServices } from '../lib/services';

vi.mock('@rembric/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const { FakeEmbedder } = await import('./embedder.js');
  return { ...actual, loadEmbedder: () => Promise.resolve(new FakeEmbedder()) };
});

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {}
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
}

const ORIGIN = 'http://127.0.0.1:8787';
const SESSION = 'sess-parent-1';
const REPORT = 'Done.\n\n## Key Learnings\n1. The parser drops BOMs.\n2. Retries cap at three.';

let dataDir: string;
let project: Project;
let writer: CreatedToken;
let writerB: CreatedToken;
let reader: CreatedToken;

beforeEach(async () => {
  resetAppGlobals();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-learnings-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  delete process.env['REMBRIC_PUBLIC_URL'];
  const services = getServices();
  project = services.projects.create({ slug: 'learn-proj' });
  writer = services.tokens.create({ name: 'learn-writer', project, access: 'write' });
  writerB = services.tokens.create({ name: 'learn-writer-b', project, access: 'write' });
  reader = services.tokens.create({ name: 'learn-reader', project, access: 'read' });
  const started = await sessionsPost(
    request('POST', `/api/${project.slug}/sessions`, {
      token: writer.plaintext,
      body: { id: SESSION },
    }),
    { params: Promise.resolve({ slug: project.slug }) },
  );
  expect(started.status).toBe(200);
});

afterEach(async () => {
  await globalForApp.__rembricMcpSurface?.close?.();
  await new Promise((resolve) => setImmediate(resolve));
  resetAppGlobals();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['JUDGMENT_QUEUE_ENABLED'];
  rmSync(dataDir, { recursive: true, force: true });
});

function request(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function post(
  body: unknown,
  opts: { token?: CreatedToken; session?: string; slug?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const slug = opts.slug ?? project.slug;
  const id = opts.session ?? SESSION;
  const res = await learningsPost(
    request('POST', `/api/${slug}/sessions/${id}/learnings`, {
      token: (opts.token ?? writer).plaintext,
      body,
    }),
    { params: Promise.resolve({ slug, id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Row {
  id: string;
  type: string;
  content: string;
  tags: string[];
  source: MemorySource | null;
  sessionId: string | null;
  hasVector: boolean;
}

function rows(): Row[] {
  return getServices()
    .db.raw.prepare<
      [string],
      {
        id: string;
        type: string;
        content: string;
        tags: string;
        source: string | null;
        session_id: string | null;
        has_vector: number;
      }
    >(
      `SELECT id, type, content, tags, source, session_id,
              EXISTS (SELECT 1 FROM memory_vec v WHERE v.memory_id = m.id) AS has_vector
         FROM memory m
        WHERE project_id = ? AND status = 'active'
        ORDER BY content`,
    )
    .all(project.id)
    .map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      tags: JSON.parse(r.tags) as string[],
      source: r.source === null ? null : (JSON.parse(r.source) as MemorySource),
      sessionId: r.session_id,
      hasVector: r.has_vector === 1,
    }));
}

describe('POST /:slug/sessions/:id/learnings', () => {
  it("saves a report's learnings into the parent session with server-assigned tags and provenance", async () => {
    const r = await post({ report: REPORT, agentType: 'Explore' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, saved: 2, skipped: 0, candidatesDetected: 0 });
    expect(r.json['ids']).toHaveLength(2);
    expect(r.json).not.toHaveProperty('candidates');
    expect(r.json).not.toHaveProperty('reason');
    const saved = rows();
    expect(saved.map((m) => m.id).sort()).toEqual([...(r.json['ids'] as string[])].sort());
    for (const m of saved) {
      expect(m).toMatchObject({
        type: 'reference',
        sessionId: SESSION,
        tags: ['subagent-learning', 'explore'],
        source: { tokenName: 'learn-writer', agent: 'subagent' },
        hasVector: true,
      });
    }
    expect(saved.map((m) => m.content)).toEqual([
      'Retries cap at three.',
      'The parser drops BOMs.',
    ]);
  });

  it('answers a report without learnings with a no-op naming the heading', async () => {
    const r = await post({ report: 'Found three endpoints.' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, saved: 0, skipped: 0, ids: [] });
    expect(r.json['reason']).toContain(KEY_LEARNINGS_HEADING_HINT);
    expect(rows()).toEqual([]);
  });

  it('saves the same report forwarded twice once', async () => {
    await post({ report: REPORT, agentType: 'Explore' });
    const r = await post({ report: REPORT, agentType: 'Explore' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, saved: 0, skipped: 2, ids: [] });
    expect(r.json['reason']).toMatch(/already captured in this session/);
    expect(rows().filter((m) => m.sessionId === SESSION)).toHaveLength(2);
  });

  it('keeps the closing learnings of a 120,000-character report', async () => {
    const tail = '\n## Key Learnings\n1. The closing learning one.\n2. The closing learning two.';
    const report = 'x'.repeat(120_000 - tail.length) + tail;
    expect(report).toHaveLength(120_000);
    expect(tail.length).toBeLessThanOrEqual(300);
    const r = await post({ report });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ saved: 2, skipped: 0 });
  });

  it('parses only the trailing 50,000 code points of the report', async () => {
    const head = '## Key Learnings\n- An early stale item.\n\n## Task\n';
    const tail = '\n## Key Learnings\n1. The closing learning one.\n2. The closing learning two.';
    const report = head + '😀'.repeat(60_000) + tail;
    const r = await post({ report });
    expect(r.json).toMatchObject({ saved: 2 });
    expect(rows().map((m) => m.content)).toEqual([
      'The closing learning one.',
      'The closing learning two.',
    ]);
  });

  it("refuses another token's session with 404 session_not_found and writes nothing", async () => {
    const r = await post({ report: REPORT }, { token: writerB });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, code: 'session_not_found' });
    expect(rows()).toEqual([]);
  });

  it('refuses a soft-deleted session with 409 session_deleted and writes nothing', async () => {
    getServices().agentSessions.softDelete(SESSION, { tokenId: writer.token.id });
    const r = await post({ report: REPORT });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, code: 'session_deleted' });
    expect(rows()).toEqual([]);
  });

  it('refuses a read-only token with 403 and writes nothing', async () => {
    const r = await post({ report: REPORT }, { token: reader });
    expect(r.status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it('refuses an unknown slug with 404 project_not_found', async () => {
    const admin = getServices().tokens.create({ name: 'learn-admin', scope: '*' });
    const r = await post({ report: REPORT }, { token: admin, slug: 'no-such-proj' });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, code: 'project_not_found' });
  });

  it.each([[{ report: '' }], [{ report: 42 }], [{ agentType: 'x' }]])(
    'refuses %j with 400 invalid_input naming report',
    async (body) => {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(String(r.json['message'])).toMatch(/report/);
      expect(rows()).toEqual([]);
    },
  );

  it('drops an agentType that normalizes to nothing', async () => {
    const r = await post({ report: REPORT, agentType: '::' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ saved: 2 });
    expect(rows().map((m) => m.tags)).toEqual([['subagent-learning'], ['subagent-learning']]);
  });

  it('answers not_found for any other method', async () => {
    const res = learningsGet(request('GET', `/api/${project.slug}/sessions/${SESSION}/learnings`));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('the tool and the HTTP route share one capture path', () => {
  it('memory.capture_passive skips what the route already captured in the session', async () => {
    await post({ report: REPORT, agentType: 'Explore' });
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp/${project.slug}`), {
      fetch: (url: string | URL, init?: RequestInit) => {
        const rest = new URL(url).pathname.split('/').filter(Boolean).slice(1);
        const method = (init?.method ?? 'GET').toUpperCase();
        const handler = method === 'GET' ? mcpGet : method === 'DELETE' ? mcpDelete : mcpPost;
        return handler(new Request(url, init), { params: Promise.resolve({ path: rest }) });
      },
      requestInit: { headers: { Authorization: `Bearer ${writer.plaintext}` } },
    });
    const client = new Client({ name: 'learnings-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'memory.capture_passive',
        arguments: { text: REPORT, tags: ['manual'], sessionId: SESSION },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ saved: 0, skipped: 2, ids: [] });
      expect(rows()).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});

describe('POST /:slug/sessions/:id/learnings — judgment queue switch', () => {
  const FOLLOW_UP =
    'Done.\n\n## Key Learnings\n1. The parser drops BOMs early.\n2. Retries cap at three again.';

  function pendingRows(): number {
    return (
      getServices()
        .db.raw.prepare<
          [],
          { n: number }
        >(`SELECT count(*) AS n FROM memory_relations WHERE status = 'pending'`)
        .get()?.n ?? -1
    );
  }

  const FILLER = [
    'The dashboard renders timestamps through one shared component.',
    'Backups run nightly and keep seven copies on disk.',
    'Tokens are hashed with SHA-256 before they are stored.',
    'The installer pins every client plugin to one release.',
    'Search ranks hybrid results with reciprocal rank fusion.',
    'Migrations apply in file-name order at process start.',
  ];

  async function restartWithQueue(value: string | undefined): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    resetAppGlobals();
    if (value === undefined) delete process.env['JUDGMENT_QUEUE_ENABLED'];
    else process.env['JUDGMENT_QUEUE_ENABLED'] = value;
    const { memory } = getServices();
    for (const content of FILLER) {
      memory.save({ type: 'project', title: content, content }, projectScope(project.id));
    }
  }

  it('with the switch unset, a forwarded report adds no pending judgment', async () => {
    await restartWithQueue(undefined);
    await post({ report: REPORT, agentType: 'Explore' });
    const before = pendingRows();
    const r = await post({ report: FOLLOW_UP, agentType: 'Explore' });

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, saved: 2 });
    expect(r.json['candidatesDetected']).toBeGreaterThanOrEqual(2);
    expect(r.json).not.toHaveProperty('candidates');
    expect(pendingRows()).toBe(before);
  });

  it('with JUDGMENT_QUEUE_ENABLED=1, the same report records pending judgments', async () => {
    await restartWithQueue('1');
    await post({ report: REPORT, agentType: 'Explore' });
    const before = pendingRows();
    const r = await post({ report: FOLLOW_UP, agentType: 'Explore' });

    expect(r.status).toBe(200);
    expect(r.json['candidatesDetected']).toBeGreaterThanOrEqual(2);
    expect(pendingRows()).toBeGreaterThanOrEqual(before + 2);
  });

  it('a value outside 0 and 1 is clamped like the other integer settings', async () => {
    await restartWithQueue('7');
    await post({ report: REPORT, agentType: 'Explore' });
    const before = pendingRows();
    await post({ report: FOLLOW_UP, agentType: 'Explore' });
    expect(pendingRows()).toBeGreaterThan(before);
  });
});
