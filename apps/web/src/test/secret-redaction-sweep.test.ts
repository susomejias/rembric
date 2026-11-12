import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { redactionPlaceholder } from '@rembric/core';
import type * as CoreModule from '@rembric/core';
import { DESCRIPTION_MAX_LENGTH } from '@rembric/mcp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as endPost } from '../app/api/[slug]/sessions/[id]/end/route';
import { POST as summaryPost } from '../app/api/[slug]/sessions/[id]/summary/route';
import { POST as turnPost } from '../app/api/[slug]/sessions/[id]/turn/route';
import { POST as sessionsPost } from '../app/api/[slug]/sessions/route';
import { DELETE, GET, POST } from '../app/mcp/[[...path]]/route';
import { getServices } from '../lib/services';

import { REDACTED_TEXT_COLUMNS } from './schema-inventory.js';

const embedded = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock('@rembric/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const { FakeEmbedder } = await import('./embedder.js');
  const embedder = new FakeEmbedder();
  embedded.texts = embedder.calls;
  return { ...actual, loadEmbedder: () => Promise.resolve(embedder) };
});

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
  __rembricSessionRouter?: unknown;
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  globalForApp.__rembricDb?.close();
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
  delete globalForApp.__rembricSessionRouter;
}

const ORIGIN = 'http://127.0.0.1:8787';
const SLUG = 'sweep';

function routeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const segments = new URL(url).pathname.split('/').filter((s) => s.length > 0);
  const rest = segments.slice(1);
  const method = (init?.method ?? 'GET').toUpperCase();
  const handler = method === 'GET' ? GET : method === 'DELETE' ? DELETE : POST;
  return handler(new Request(url, init), {
    params: Promise.resolve(rest.length > 0 ? { path: rest } : {}),
  });
}

function base64Run(label: string): string {
  return [0, 1, 2, 3]
    .map((i) => createHash('sha256').update(`${label}#${i}`).digest('base64').replace(/=/g, ''))
    .join('');
}

const secrets: string[] = [];

function secret(label: string): string {
  const value = `ghp_${base64Run(label)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 36)}`;
  secrets.push(value);
  return value;
}

function privateKey(label: string): string {
  const body = base64Run(label);
  const block = `-----BEGIN PRIVATE KEY-----\n${body.slice(0, 64)}\n${body.slice(64, 128)}\n-----END PRIVATE KEY-----`;
  secrets.push(body.slice(0, 64));
  return block;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const WRITE_TOOLS = [
  'memory.save',
  'memory.capture_passive',
  'memory.confirm_batch',
  'memory.save_prompt',
  'memory.judge_batch',
  'memory.compare',
  'memory.session_start',
  'memory.session_summary',
] as const;

describe('secret redaction sweep — every write path through its real boundary', () => {
  let dataDir: string;
  let adminToken: string;
  let client: Client;
  let services: ReturnType<typeof getServices>;
  const responses: Record<string, Record<string, unknown>> = {};
  const httpBodies: Record<string, unknown>[] = [];

  async function tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    expect(result.isError, `${name} failed: ${JSON.stringify(result)}`).toBeFalsy();
    return result.structuredContent ?? {};
  }

  async function http<P extends Record<string, string>>(
    handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
    path: string,
    params: P,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await handler(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve(params) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status, `${path}: ${JSON.stringify(json)}`).toBe(200);
    return json;
  }

  beforeAll(async () => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-redaction-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    delete process.env['REMBRIC_PUBLIC_URL'];
    services = getServices();
    services.projects.create({ slug: SLUG });
    adminToken = services.tokens.create({ name: 'sweep-admin', scope: '*' }).plaintext;
    client = new Client({ name: 'rembric-sweep', version: '0.0.0' }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp/${SLUG}`), {
        fetch: routeFetch,
        requestInit: { headers: { Authorization: `Bearer ${adminToken}` } },
      }),
    );

    responses['session_start'] = await tool('memory.session_start', {
      agent: `agent ${secret('agent')}`,
      description: `desc ${secret('description')}`,
    });
    responses['session_summary'] = await tool('memory.session_summary', {
      summary: `## Goal\nship with ${secret('summary')}`,
      title: `title ${secret('summary-title')}`,
    });

    const rotated = secret('scenario');
    responses['save_scenario'] = await tool('memory.save', {
      type: 'project',
      title: `rotated ${rotated}`,
      content: `old ${rotated}\n${privateKey('scenario-key')}`,
      tags: ['deploy'],
    });
    const topicKey = `creds/${secret('topic')}`;
    responses['save_tagged'] = await tool('memory.save', {
      type: 'project',
      title: 'tagged',
      content: 'release notes',
      tags: ['ops', secret('tag')],
      topic_key: topicKey,
    });
    await tool('memory.save', {
      type: 'project',
      title: 'tagged v2',
      content: 'release notes v2',
      tags: ['ops'],
      topic_key: topicKey,
    });
    responses['save_clean'] = await tool('memory.save', {
      type: 'project',
      title: 'kafka consumer lag',
      content: 'kafka consumer lag fixed by raising fetch max bytes on the orders topic',
      tags: ['kafka'],
    });

    responses['capture'] = await tool('memory.capture_passive', {
      text: `## Key Learnings\n1. The registry push used ${secret('capture-1')} as its credential.\n2. The mirror job also read ${secret('capture-2')} from its environment.`,
      tags: ['sweep'],
    });
    responses['confirm'] = await tool('memory.confirm_batch', {
      ids: [responses['save_scenario']['id']],
      verdict: 'affirm',
      reason: `checked against ${secret('confirm')}`,
    });
    responses['prompt'] = await tool('memory.save_prompt', {
      content: `run the deploy with ${secret('prompt')}`,
      title: `prompt ${secret('prompt-title')}`,
      tags: [secret('prompt-tag')],
    });

    const duplicate = await tool('memory.save', {
      type: 'project',
      title: 'kafka consumer lag again',
      content: 'kafka consumer lag fixed by raising fetch max bytes on the orders topic',
      tags: ['kafka'],
    });
    const candidates = duplicate['candidates'] as { judgmentId: string }[];
    expect(
      candidates.length,
      'the duplicate save must surface a candidate to judge',
    ).toBeGreaterThan(0);
    responses['judge'] = await tool('memory.judge_batch', {
      judgments: [
        {
          judgmentId: candidates[0]!.judgmentId,
          relation: 'related',
          reason: `same fix, see ${secret('judge')}`,
          evidence: { quote: secret('judge-evidence') },
        },
      ],
    });
    responses['compare'] = await tool('memory.compare', {
      memoryIdA: responses['save_scenario']['id'],
      memoryIdB: responses['save_clean']['id'],
      relation: 'related',
      confidence: 0.5,
      reason: `both mention ${secret('compare')}`,
      evidence: [secret('compare-evidence')],
    });

    const sessions = `/api/${SLUG}/sessions`;
    httpBodies.push(
      await http(
        sessionsPost,
        sessions,
        { slug: SLUG },
        {
          id: 'sweep-http-1',
          agent: `hook ${secret('http-agent')}`,
          description: `hook desc ${secret('http-description')}`,
          cwd: '/work/sweep',
        },
      ),
    );
    const one = { slug: SLUG, id: 'sweep-http-1' };
    httpBodies.push(
      await http(turnPost, `${sessions}/sweep-http-1/turn`, one, {
        usedTools: true,
        title: `turn ${secret('http-turn')}`,
      }),
    );
    httpBodies.push(
      await http(summaryPost, `${sessions}/sweep-http-1/summary`, one, {
        summary: `## Goal\nhttp ${secret('http-summary')}`,
        title: `http ${secret('http-title')}`,
      }),
    );
    httpBodies.push(
      await http(endPost, `${sessions}/sweep-http-1/end`, one, {
        summary: `## Goal\nend ${secret('http-end')}`,
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await globalForApp.__rembricMcpSurface?.close?.();
    await new Promise((resolve) => setImmediate(resolve));
    resetAppGlobals();
    delete process.env['REMBRIC_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores no raw secret in any column of any table', () => {
    const raw = services.db.raw;
    const tables = (
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toContain('memory_entities');
    const leaks: string[] = [];
    for (const table of tables) {
      for (const row of raw.prepare(`SELECT * FROM "${table}"`).all() as Record<
        string,
        unknown
      >[]) {
        for (const [column, value] of Object.entries(row)) {
          const text =
            typeof value === 'string'
              ? value
              : Buffer.isBuffer(value)
                ? value.toString('latin1')
                : '';
          for (const s of secrets) if (text.includes(s)) leaks.push(`${table}.${column}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('fills every column classified redacted with a placeholder', () => {
    const raw = services.db.raw;
    const unreached = REDACTED_TEXT_COLUMNS.filter((qualified) => {
      const [table, column] = qualified.split('.') as [string, string];
      const row = raw
        .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" LIKE '%redacted%'`)
        .get() as { n: number };
      return row.n === 0;
    });
    expect(unreached, 'redacted column(s) no write path in this sweep reached').toEqual([]);
  });

  it('keeps the secrets out of the FTS index', () => {
    const raw = services.db.raw;
    const match = raw.prepare('SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?');
    expect((match.get('redacted') as { n: number }).n).toBeGreaterThan(0);
    for (const s of secrets) {
      const body = s.startsWith('ghp_') ? s.slice(4) : s.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      expect((match.get(`"${body}"`) as { n: number }).n, body).toBe(0);
      const vocab = raw
        .prepare('SELECT COUNT(*) AS n FROM memory_fts_vocab WHERE term = ?')
        .get(body.toLowerCase()) as { n: number };
      expect(vocab.n, body).toBe(0);
    }
  });

  it('hands the embedder the placeholder, never the secret', () => {
    for (const kind of ['github_token', 'private_key'] as const) {
      expect(
        embedded.texts.some((t) => t.includes(redactionPlaceholder(kind))),
        kind,
      ).toBe(true);
    }
    for (const t of embedded.texts) for (const s of secrets) expect(t).not.toContain(s);
  });

  it('reports redactions on every MCP write and omits them on a clean one', () => {
    expect(responses['save_scenario']!['redactions']).toEqual([
      { kind: 'private_key', count: 1 },
      { kind: 'github_token', count: 2 },
    ]);
    expect(responses['save_tagged']!['redactions']).toEqual([{ kind: 'github_token', count: 2 }]);
    expect(responses['save_clean']).not.toHaveProperty('redactions');
    for (const key of ['session_start', 'session_summary', 'compare']) {
      expect(responses[key]!['redactions'], key).toEqual([{ kind: 'github_token', count: 2 }]);
    }
    expect(responses['capture']!['redactions']).toEqual([{ kind: 'github_token', count: 4 }]);
    expect(responses['confirm']!['redactions']).toEqual([{ kind: 'github_token', count: 1 }]);
    expect(responses['prompt']!['redactions']).toEqual([{ kind: 'github_token', count: 3 }]);
    const [judged] = responses['judge']!['results'] as Record<string, unknown>[];
    expect(judged!['redactions']).toEqual([{ kind: 'github_token', count: 2 }]);
  });

  it('leaves the HTTP session response bodies without a redactions field', () => {
    for (const body of httpBodies) expect(body).not.toHaveProperty('redactions');
  });

  it('states the behaviour in every write tool description within the ceiling', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of WRITE_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      const description = tool?.description ?? '';
      const stated =
        name === 'memory.session_summary'
          ? JSON.stringify(tool?.inputSchema.properties?.['summary'])
          : description;
      expect(stated, name).toContain('[REDACTED:<kind>]');
      expect(description.length, name).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    }
  });
});
