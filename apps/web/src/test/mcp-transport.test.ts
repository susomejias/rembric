import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ABSTENTION_FLOOR,
  AgentSessionsService,
  EMPTY_POOL_REASON,
  MemoryService,
  ProjectsService,
  RELATION_ANNOTATION_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_MERGE_RULE,
  SUMMARY_SECTIONS,
  TokensService,
} from '@rembric/core';
import type * as CoreModule from '@rembric/core';
import { agentSessions, createRepositories } from '@rembric/db';
import {
  CONTEXT_MEMORIES_MAX,
  CONTEXT_PROMPTS_MAX,
  CONTEXT_SESSIONS_MAX,
  DESCRIPTION_MAX_LENGTH,
  TIMELINE_WINDOW_MAX,
} from '@rembric/mcp';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DELETE, GET, POST } from '../app/mcp/[[...path]]/route';
import { getServices } from '../lib/services';

import { defaultProject } from './default-project.js';

vi.mock('@rembric/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const { FakeEmbedder } = await import('./embedder.js');
  return { ...actual, loadEmbedder: () => Promise.resolve(new FakeEmbedder()) };
});

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
  __rembricSessionRouter?: unknown;
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {}
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
  delete globalForApp.__rembricSessionRouter;
}

const ORIGIN = 'http://127.0.0.1:8787';

function routeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const pathname = new URL(url).pathname;
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const rest = segments.slice(1);
  const method = (init?.method ?? 'GET').toUpperCase();
  const request = new Request(url, init);
  const handler = method === 'GET' ? GET : method === 'DELETE' ? DELETE : POST;
  return handler(request, { params: Promise.resolve(rest.length > 0 ? { path: rest } : {}) });
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function readJson(result: ToolResult): unknown {
  const first = result.content.find((c) => c.type === 'text');
  if (!first?.text) return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

describe('MCP protocol conformance', () => {
  let dataDir: string;
  let adminToken: string;
  let services: ReturnType<typeof getServices>;

  beforeAll(() => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-mcp-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    delete process.env['REMBRIC_PUBLIC_URL'];
    services = getServices();
    adminToken = services.tokens.create({ name: 'integration-admin', scope: '*' }).plaintext;
  });

  afterAll(async () => {
    await globalForApp.__rembricMcpSurface?.close?.();
    await new Promise((resolve) => setImmediate(resolve));
    resetAppGlobals();
    delete process.env['REMBRIC_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function connect(
    opts: { token?: string; projectSlug?: string; rootUri?: string } = {},
  ): Promise<Client> {
    const token = opts.token ?? adminToken;
    const transport = new StreamableHTTPClientTransport(
      new URL(`${ORIGIN}/mcp${opts.projectSlug ? `/${opts.projectSlug}` : ''}`),
      { fetch: routeFetch, requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const client = new Client(
      { name: 'rembric-test-client', version: '0.0.0' },
      { capabilities: opts.rootUri ? { roots: {} } : {} },
    );
    if (opts.rootUri) {
      const rootUri = opts.rootUri;
      client.setRequestHandler(ListRootsRequestSchema, () => ({
        roots: [{ uri: rootUri, name: rootUri }],
      }));
    }
    await client.connect(transport);
    return client;
  }

  it('handshakes and reports server name', async () => {
    const client = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe('rembric');
    await client.close();
  });

  it('emits scope-aware instructions in the initialize result', async () => {
    const globalClient = await connect();
    const globalInstructions = globalClient.getInstructions();
    expect(globalInstructions).toMatch(/project\.use/);
    expect(globalInstructions).not.toContain('X-Rembric-Project');
    expect(globalInstructions).toContain(SUMMARY_SECTIONS);
    expect((globalInstructions ?? '').length).toBeLessThanOrEqual(1000);
    await globalClient.close();

    const projClient = await connect({ projectSlug: 'integration-proj' });
    const projInstructions = projClient.getInstructions();
    expect(projInstructions).toContain("'integration-proj'");
    expect(projInstructions).toContain(SUMMARY_SECTIONS);
    expect((projInstructions ?? '').length).toBeLessThanOrEqual(1000);
    await projClient.close();
  });

  it('publishes the canonical session-summary directive in tools/list', async () => {
    const client = await connect();
    const tools = await client.listTools();
    await client.close();
    const summary = tools.tools.find((tool) => tool.name === 'memory.session_summary');
    expect(summary?.description).toBeDefined();
    expect(summary!.description).toContain(SUMMARY_SECTIONS);
    expect(summary!.description).not.toContain(
      'Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files',
    );
    expect(summary!.description!.length).toBeLessThan(DESCRIPTION_MAX_LENGTH);
    expect(summary!.description).toContain(SUMMARY_SECTIONS.split('\n').slice(0, 2).join('\n'));
  });

  it('lists the four memory.* tools', async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining(['memory.confirm', 'memory.get', 'memory.save', 'memory.search']),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'memory.session_start',
        'memory.session_end',
        'memory.session_summary',
        'memory.context',
        'memory.timeline',
        'memory.capture_passive',
        'memory.doctor',
        'memory.stats',
        'project.use',
        'project.list',
        'project.current',
      ]),
    );
    await client.close();
  });

  it('memory.search description teaches recall, hybrid ranking, and the widen affordance', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'memory.search');
    const desc = search?.description ?? '';

    expect(desc).toMatch(/recall|remember|recuerda/i);
    expect(desc).toMatch(/hybrid/i);
    expect(desc).toMatch(/semantic/i);
    expect(desc).toMatch(/limit/i);
    expect(desc).toMatch(/offset/i);

    await client.close();
  });

  it('memory.search description explains abstention without naming a disabled gate', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'memory.search');
    expect(search, 'memory.search missing from tools/list').toBeDefined();
    const desc = search?.description ?? '';
    await client.close();

    expect(desc).toContain('not as a signal to invent or assume context');
    expect(desc).toContain('nothing relevant found');
    expect(ABSTENTION_FLOOR).toBeNull();
    expect(desc).not.toMatch(/relevance floor/i);

    expect(desc).toContain('gateShortened');
    expect(desc).toContain('a short page is not corpus exhaustion');
    expect(desc).toContain('a full page is not proof of relevance');

    expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(desc.length, 'the reword drifted from the recorded description budget').toBe(1873);
  });

  it('memory.archive description steers against autonomous retirement', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const archive = tools.find((t) => t.name === 'memory.archive');
    const desc = archive?.description ?? '';

    expect(desc).toMatch(/explicit/i);
    expect(desc).toMatch(/retire|remove|forget/i);
    expect(desc).toMatch(/supersede/i);
    expect(desc).toMatch(/topic_key/i);
    expect(desc).toMatch(/autonomous|cleanup|housekeeping/i);
    expect(desc).toMatch(/revers|undo/i);
    expect(desc).toMatch(/dashboard/i);

    await client.close();
  });

  it('memory.session_summary description matches the schema hard limit', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const sessionSummary = tools.find((t) => t.name === 'memory.session_summary');
    const desc = sessionSummary?.description ?? '';
    const schema = sessionSummary?.inputSchema as
      | { properties?: { summary?: { maxLength?: number } } }
      | undefined;

    expect(schema?.properties?.summary?.maxLength).toBe(SUMMARY_MAX_CHARS);
    expect(desc).toContain(String(SUMMARY_MAX_CHARS));
    expect(desc).not.toContain('2000');

    await client.close();
  });

  it('memory.session_summary description directs verbatim copying of carried-forward facts, not paraphrase', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const sessionSummary = tools.find((t) => t.name === 'memory.session_summary');
    const desc = sessionSummary?.description ?? '';

    expect(desc).toContain('COPY it');
    expect(desc).toContain('do not paraphrase');
    expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);

    await client.close();
  });

  it('memory.session_summary description states the section-wise merge clause, from the shared constant', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const sessionSummary = tools.find((t) => t.name === 'memory.session_summary');
    const desc = sessionSummary?.description ?? '';

    expect(desc).toContain(SUMMARY_MERGE_RULE);
    expect(desc).toContain('Sending only the sections that changed');
    expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);

    await client.close();
  });

  it('the rendered instructions and the emitted description carry the same merge sentence, from the same constant', async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? '';
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === 'memory.session_summary')?.description ?? '';

    expect(instructions).toContain(SUMMARY_MERGE_RULE);
    expect(desc).toContain(SUMMARY_MERGE_RULE);

    await client.close();
  });

  it('memory.session_summary description says condense-never-delete, names the `none` escape hatch, and the over-cap-merge rule', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const sessionSummary = tools.find((t) => t.name === 'memory.session_summary');
    const desc = sessionSummary?.description ?? '';

    expect(desc).toContain('CONDENSE, never delete');
    expect(desc).toContain('`none`');
    expect(desc).toContain('over-cap MERGE is refused, not truncated');

    await client.close();
  });

  it('memory.session_summary description discourages sending title on every write', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const sessionSummary = tools.find((t) => t.name === 'memory.session_summary');
    const desc = sessionSummary?.description ?? '';

    expect(desc).toContain('send on the FIRST write or a real change of direction');
    expect(desc).toContain('omit otherwise, it stays and is never locked');

    await client.close();
  });

  it('memory.context description advertises the judgment total and the size that lifts the age filter', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const context = tools.find((t) => t.name === 'memory.context');
    const desc = context?.description ?? '';
    const schema = context?.inputSchema as
      | { properties?: { judgments?: { maximum?: number } } }
      | undefined;

    expect(schema?.properties?.judgments?.maximum).toBe(50);
    expect(desc).toContain('pendingJudgmentsTotal');
    expect(desc).toContain('judgments');
    expect(desc).toMatch(/lifts the age filter/i);

    await client.close();
  });

  it('memory.doctor description discloses the server-wide population and names memory.stats', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const doctor = tools.find((t) => t.name === 'memory.doctor');
    expect(doctor, 'memory.doctor missing from tools/list').toBeDefined();
    const desc = doctor?.description ?? '';
    expect(desc.length).toBeGreaterThan(0);

    expect(desc).not.toMatch(/llm/i);

    expect(desc).toMatch(/server-wide/i);
    expect(desc).toMatch(/all projects/i);
    expect(desc).toContain('memory.stats');
    expect(desc).toMatch(/differ/i);

    expect(desc).toContain('entities');
    expect(desc).toContain('sessions');
    expect(desc).toContain('review');

    expect(desc.split('. ')[0]).toMatch(/server-wide/i);

    const report = (await client.callTool({ name: 'memory.doctor', arguments: {} })) as ToolResult;
    expect(report.isError).toBeFalsy();
    const payload = readJson(report) as Record<string, unknown>;
    expect('llm' in payload).toBe(false);
    expect('review' in payload).toBe(true);
    expect('entities' in payload).toBe(true);

    await client.close();
  });

  it('memory.stats description names its queue-depth totals and the divergence', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const stats = tools.find((t) => t.name === 'memory.stats');
    expect(stats, 'memory.stats missing from tools/list').toBeDefined();
    const desc = stats?.description ?? '';
    expect(desc.length).toBeGreaterThan(0);

    expect(desc).toContain('needsReviewTotal');
    expect(desc).toContain('pendingJudgmentsTotal');
    expect(desc).toMatch(/scoped to the active project/i);
    expect(desc).toContain('memory.doctor');
    expect(desc).toMatch(/server-wide/i);
    expect(desc).toMatch(/differ/i);

    await client.close();
  });

  it('project.list description says the per-project count covers active memories', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const list = tools.find((t) => t.name === 'project.list');
    expect(list, 'project.list missing from tools/list').toBeDefined();
    const desc = list?.description ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);

    expect(desc).toContain('activeMemoryCount');
    expect(desc).toMatch(/active/i);
    expect(desc).toMatch(/archived/i);

    await client.close();
  });

  it('the relations_limit parameter publishes the bounded-ask recipe on both reading tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    for (const name of ['memory.search', 'memory.get']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as
        | { properties?: { relations_limit?: { maximum?: number; description?: string } } }
        | undefined;
      const param = schema?.properties?.relations_limit;
      expect(param?.maximum, `${name}.relations_limit maximum`).toBe(RELATION_ANNOTATION_MAX);
      const desc = param?.description ?? '';
      expect(desc, name).toContain('default');
      expect(desc, name).toContain('relationsTotal');
      expect(desc, name).toContain(`min(relationsTotal, ${RELATION_ANNOTATION_MAX})`);
      expect(desc, name).toMatch(/rejected, not clamped/i);
    }
  });

  it('rejects a relations_limit above the maximum instead of clamping it', async () => {
    const client = await connect();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'project',
        title: 'relations_limit over-ask probe',
        content: 'relations-limit-over-ask-probe',
      },
    })) as ToolResult;
    const { id } = readJson(saved) as { id: string };

    for (const call of [
      { name: 'memory.search', arguments: { query: 'probe', relations_limit: 51 } },
      { name: 'memory.get', arguments: { id, relations_limit: 51 } },
    ]) {
      const rejected = (await client.callTool(call)) as ToolResult;
      expect(rejected.isError, call.name).toBe(true);
      const text = rejected.content.find((c) => c.type === 'text')?.text ?? '';
      expect(text, call.name).toContain('-32602');
      expect(text, call.name).toContain('relations_limit');
      expect(text, call.name).not.toContain('relationsTotal');
    }

    const atMax = (await client.callTool({
      name: 'memory.get',
      arguments: { id, relations_limit: RELATION_ANNOTATION_MAX },
    })) as ToolResult;
    expect(atMax.isError).toBeFalsy();
    expect(readJson(atMax)).toMatchObject({ relations: [], relationsTotal: 0 });

    await client.close();
  });

  it("memory.get's batch form reports the same review metadata and replaces as the single-id form", async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const project =
      projects.findBySlug('integration-batch-parity') ??
      projects.create({ slug: 'integration-batch-parity' });
    const client = await connect({ projectSlug: project.slug });
    await client.listTools();
    const topicKey = 'batch-parity-topic';
    const save = async (title: string): Promise<string> => {
      const res = (await client.callTool({
        name: 'memory.save',
        arguments: {
          type: 'procedural',
          title,
          content: `batch-parity ${title}`,
          topic_key: topicKey,
        },
      })) as ToolResult;
      return (readJson(res) as { id: string }).id;
    };
    const predecessorId = await save('batch parity predecessor');
    const headId = await save('batch parity head');

    const refuted = (await client.callTool({
      name: 'memory.confirm',
      arguments: { id: headId, verdict: 'refute', reason: 'batch parity probe' },
    })) as ToolResult;
    expect(refuted.isError).toBeFalsy();

    const single = (await client.callTool({
      name: 'memory.get',
      arguments: { id: headId },
    })) as ToolResult;
    const batch = (await client.callTool({
      name: 'memory.get',
      arguments: { ids: [headId, predecessorId] },
    })) as ToolResult;
    expect(single.isError).toBeFalsy();
    expect(batch.isError).toBeFalsy();

    const singleBody = readJson(single) as {
      reviewState?: string;
      reviewAfter?: string | null;
      reviewEscalated?: boolean;
      lastSeenAt?: unknown;
      memory: { replaces: string[] };
    };
    const entries = (readJson(batch) as { memories: Record<string, unknown>[] }).memories;
    const head = entries.find((m) => m.id === headId);
    const predecessor = entries.find((m) => m.id === predecessorId);
    expect(head, 'head missing from the batch page').toBeDefined();
    expect(predecessor, 'predecessor missing from the batch page').toBeDefined();

    expect(singleBody.reviewState).toBe('needs_review');
    expect(singleBody.reviewAfter).toEqual(expect.any(String));
    expect(singleBody.reviewEscalated).toBe(false);
    expect(head!.reviewState).toBe(singleBody.reviewState);
    expect(head!.reviewAfter).toBe(singleBody.reviewAfter);
    expect(head!.reviewEscalated).toBe(singleBody.reviewEscalated);
    expect(head!.replaces).toEqual([predecessorId]);
    expect(head!.replaces).toEqual(singleBody.memory.replaces);

    expect(predecessor!.status).toBe('superseded');
    for (const field of ['reviewState', 'reviewAfter', 'reviewEscalated']) {
      expect(field in predecessor!, `${field} on a superseded batch entry`).toBe(false);
    }

    expect('lastSeenAt' in head!).toBe(true);
    expect('lastSeenAt' in singleBody).toBe(false);
    for (const field of [
      'head',
      'predecessors',
      'predecessorCount',
      'truncated',
      'headTruncated',
      'confirmationCount',
    ]) {
      expect(field in head!, `${field} on a batch entry`).toBe(false);
    }

    await client.close();
  });

  it('marks a gate-shortened page over the MCP boundary inside the pool, and leaves both a past-the-pool offset and an unfiltered deep offset unmarked', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const shortened =
      projects.findBySlug('integration-gate-short') ??
      projects.create({ slug: 'integration-gate-short' });
    const untouched =
      projects.findBySlug('integration-gate-deep') ??
      projects.create({ slug: 'integration-gate-deep' });

    const save = async (client: Client, title: string, content: string) => {
      const r = (await client.callTool({
        name: 'memory.save',
        arguments: { type: 'project', title, content },
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
    };

    const shortClient = await connect({ projectSlug: shortened.slug });
    await shortClient.listTools();
    await save(shortClient, 'Quetzal ledger', 'quetzal ledger obsidian marmot tessellate');
    for (let i = 0; i < 4; i++) await save(shortClient, `Marmot ${i}`, `marmot sighting ${i}`);
    const gatedResult = (await shortClient.callTool({
      name: 'memory.search',
      arguments: { query: 'quetzal ledger obsidian marmot tessellate', limit: 8 },
    })) as ToolResult;
    const gated = readJson(gatedResult) as {
      count: number;
      abstained: boolean;
      gateShortened?: boolean;
    };
    expect(gated.count).toBeGreaterThan(0);
    expect(gated.count).toBeLessThan(8);
    expect(gated.abstained).toBe(false);
    expect(gated.gateShortened).toBe(true);
    expect(gatedResult.structuredContent).toMatchObject({
      abstained: false,
      gateShortened: true,
    });

    const gatedDeepResult = (await shortClient.callTool({
      name: 'memory.search',
      arguments: {
        query: 'quetzal ledger obsidian marmot tessellate',
        limit: 2,
        offset: 4,
      },
    })) as ToolResult;
    const gatedDeep = readJson(gatedDeepResult) as Record<string, unknown>;
    expect(gatedDeep.count).toBe(0);
    expect(gatedDeep.abstained).toBe(false);
    expect(gatedDeep.gateShortened).toBe(true);
    expect(gatedDeepResult.structuredContent).toMatchObject({
      abstained: false,
      gateShortened: true,
    });

    for (const offset of [5, 50]) {
      const pastPoolResult = (await shortClient.callTool({
        name: 'memory.search',
        arguments: {
          query: 'quetzal ledger obsidian marmot tessellate',
          limit: 2,
          offset,
        },
      })) as ToolResult;
      const pastPool = readJson(pastPoolResult) as Record<string, unknown>;
      expect(pastPool.count, `offset ${offset}`).toBe(0);
      expect(pastPool.abstained, `offset ${offset}`).toBe(false);
      expect(pastPool, `offset ${offset}`).not.toHaveProperty('gateShortened');
      expect(pastPoolResult.structuredContent, `offset ${offset}`).not.toHaveProperty(
        'gateShortened',
      );
      expect(pastPoolResult.structuredContent, `offset ${offset}`).toMatchObject({
        abstained: false,
      });
    }
    await shortClient.close();

    const deepClient = await connect({ projectSlug: untouched.slug });
    await deepClient.listTools();
    for (let i = 0; i < 3; i++)
      await save(deepClient, `Basalt ${i}`, 'basalt cistern verdigris palimpsest');
    const deep = readJson(
      (await deepClient.callTool({
        name: 'memory.search',
        arguments: { query: 'basalt cistern verdigris palimpsest', limit: 2, offset: 5 },
      })) as ToolResult,
    ) as Record<string, unknown>;
    await deepClient.close();
    expect(deep.count).toBe(0);
    expect(deep.abstained).toBe(false);
    expect(deep).not.toHaveProperty('gateShortened');
    expect(deep).not.toHaveProperty('abstainReason');
  });

  it('publishes the verdict on both search branches: a listing that never ranked still says abstained: false, and an abstention carries its reason', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const p =
      projects.findBySlug('integration-verdict') ??
      projects.create({ slug: 'integration-verdict' });
    const client = await connect({ projectSlug: p.slug });
    await client.listTools();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: { type: 'project', title: 'Cinnabar rota', content: 'cinnabar rota kestrel' },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();

    const listing = (await client.callTool({
      name: 'memory.search',
      arguments: { limit: 5 },
    })) as ToolResult;
    const listed = readJson(listing) as Record<string, unknown>;
    expect(listed.count).toBeGreaterThan(0);
    expect(listed).toHaveProperty('abstained', false);
    expect(listing.structuredContent).toHaveProperty('abstained', false);
    expect(listed).not.toHaveProperty('abstainReason');

    const abstained = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'cinnabar rota kestrel', type: 'user' },
    })) as ToolResult;
    const missed = readJson(abstained) as Record<string, unknown>;
    await client.close();
    expect(missed.count).toBe(0);
    expect(missed).toHaveProperty('abstained', true);
    expect(missed).toHaveProperty('abstainReason', EMPTY_POOL_REASON);
    expect(abstained.structuredContent).toMatchObject({
      abstained: true,
      abstainReason: EMPTY_POOL_REASON,
    });
  });

  it('keeps every tool description under the client truncation ceiling', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    const measured = tools.map((t) => ({ name: t.name, length: (t.description ?? '').length }));
    expect(measured.length, 'tools/list returned fewer tools than expected').toBeGreaterThanOrEqual(
      23,
    );

    const over = measured.filter((m) => m.length > DESCRIPTION_MAX_LENGTH);
    expect(
      over,
      `description(s) over DESCRIPTION_MAX_LENGTH=${DESCRIPTION_MAX_LENGTH}: ` +
        `${over.map((m) => `${m.name} is ${m.length} chars`).join(', ')}. ` +
        'Claude Code tail-cuts at 2048 chars, dropping the END of the description first. ' +
        'Reword to fit, or raise the cap deliberately keeping a margin below the ' +
        're-verified client ceiling (mcp-api: "Tool descriptions MUST stay below the ' +
        'client truncation ceiling").',
    ).toEqual([]);

    const save = tools.find((t) => t.name === 'memory.save')?.description ?? '';
    const savesMeasured = measured.find((m) => m.name === 'memory.save')?.length;
    expect(savesMeasured).toBe(save.length);
    expect(savesMeasured).not.toBe(Buffer.byteLength(save, 'utf8'));

    expect(save).toContain('candidatesDetected');
    expect(save).toContain('memory.suggest_topic_key');
    expect(save).toContain('CANDIDATES_PER_SAVE_MAX');
    expect(save).not.toMatch(/pass\s+`?candidatesDetected/i);
    expect(save).not.toMatch(/candidates_limit|candidates_max/i);
  });

  describe('descriptions agree with what the tools do', () => {
    let descriptions: Map<string, string>;
    let requiredBySchema: Map<string, string[]>;

    beforeAll(async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      await client.close();
      descriptions = new Map(tools.map((t) => [t.name, t.description ?? '']));
      requiredBySchema = new Map(
        tools.map((t) => [t.name, (t.outputSchema as { required?: string[] })?.required ?? []]),
      );
      expect(descriptions.size).toBeGreaterThanOrEqual(23);
    });

    it.each([
      ['memory.context', 1432],
      ['memory.search_prompts', 428],
      ['memory.session_start', 971],
      ['memory.doctor', 603],
      ['memory.timeline', 395],
      ['memory.save', 1549],
      ['memory.stats', 242],
    ])('%s is %i chars, inside the ceiling', (name, expected) => {
      const desc = descriptions.get(name);
      expect(desc, `${name} missing from tools/list`).toBeDefined();
      expect(desc!.length, `${name} length`).toBe(expected);
      expect(DESCRIPTION_MAX_LENGTH - desc!.length, `${name} headroom`).toBeGreaterThan(0);
    });

    it('memory.context names every one of its four maxima and the reject rule', () => {
      const desc = descriptions.get('memory.context') ?? '';
      expect(desc).toContain(`sessions ${CONTEXT_SESSIONS_MAX}`);
      expect(desc).toContain(`prompts ${CONTEXT_PROMPTS_MAX}`);
      expect(desc).toContain(`memories ${CONTEXT_MEMORIES_MAX}`);
      expect(desc).toMatch(/judgments 50/);
      expect(desc).toMatch(/rejected, not clamped/i);
    });

    it('memory.save_prompt restrains WHEN it is called, not only what to pass', () => {
      const desc = descriptions.get('memory.save_prompt') ?? '';
      expect(desc).toMatch(/^Persist a REUSABLE prompt/);
      expect(desc).toMatch(/do NOT call it routinely/i);
      expect(desc).toContain('memory.save');
      expect(desc).toContain('memory.session_summary');
      expect(desc).not.toMatch(/when the user states a goal/i);
    });

    it('memory.timeline names both window arguments, its bound and the remedy', () => {
      const desc = descriptions.get('memory.timeline') ?? '';
      expect(desc).toContain('before');
      expect(desc).toContain('after');
      expect(desc).toContain('memory.search');
      expect(desc).toMatch(/not clamped/i);
      expect(desc).toContain(`must not exceed ${TIMELINE_WINDOW_MAX}`);
    });

    it('memory.search_prompts teaches limit’s default and maximum', () => {
      const desc = descriptions.get('memory.search_prompts') ?? '';
      expect(desc).toMatch(/`limit` defaults to 25/);
      expect(desc).toMatch(/max 100/);
      expect(desc).toMatch(/rejected, not clamped/i);
    });

    it('memory.doctor names the filtering cause as well as the population', () => {
      const desc = descriptions.get('memory.doctor') ?? '';
      expect(desc).toMatch(/server-wide/i);
      expect(desc).toContain('memory.stats');
      expect(desc).toMatch(/unfiltered|every pending row/i);
      expect(desc).toMatch(/adjudicable/i);
      expect(desc).not.toMatch(/and they will differ\.\s/);
      expect(desc.indexOf('SERVER-WIDE')).toBeLessThan(desc.indexOf('Use at session start'));
    });

    it('memory.session_start names every field its outputSchema requires', () => {
      const desc = descriptions.get('memory.session_start') ?? '';
      const required = requiredBySchema.get('memory.session_start') ?? [];
      expect(required.sort()).toEqual([
        'agent',
        'projectId',
        'reused',
        'scope',
        'sessionId',
        'startedAt',
        'title',
      ]);
      for (const field of required) {
        expect(desc, `${field} unnamed in the description`).toContain(field);
      }
      expect(desc).toMatch(/reused:true.*ADOPTED/i);
      expect(desc).toMatch(/agent.*MAY differ from the `agent` you passed/i);
      expect(desc).toMatch(/do NOT call this again/i);
      expect(desc).toMatch(/attach to it automatically/i);
    });

    it('memory.session_resume names every field its outputSchema requires', () => {
      const desc = descriptions.get('memory.session_resume') ?? '';
      const required = requiredBySchema.get('memory.session_resume') ?? [];
      expect(required).toContain('previousStatus');
      expect(required).toContain('previousEndedAt');
      for (const field of required) {
        expect(desc, `${field} unnamed in the description`).toContain(field);
      }
      expect(desc).toMatch(/previousEndedAt` is NOT retained/);
    });

    it('no description promises a clamp receipt, and none lists one in its return shape', () => {
      for (const [name, desc] of descriptions) {
        expect(desc, name).not.toMatch(/clamped\s*:\s*true/i);
        expect(desc, name).not.toMatch(/,\s*clamped\s*\}/);
      }
    });

    it('clamped is absent from both output schemas that published it', () => {
      for (const name of ['memory.context', 'memory.search_prompts']) {
        expect(requiredBySchema.get(name), name).not.toContain('clamped');
      }
    });
  });

  it('a second memory.session_start adopts the first session and says so', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const project =
      projects.findBySlug('integration-session-reuse') ??
      projects.create({ slug: 'integration-session-reuse' });
    const client = await connect({ projectSlug: project.slug });

    const first = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test' },
    })) as ToolResult;
    const second = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test-other' },
    })) as ToolResult;
    const a = readJson(first) as { sessionId: string; reused: boolean; agent: string };
    const b = readJson(second) as { sessionId: string; reused: boolean; agent: string };

    expect(a.reused).toBe(false);
    expect(a.agent).toBe('rembric-test');
    expect(b.reused).toBe(true);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.agent).toBe('rembric-test');

    const rows = services.db.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.projectId, project.id))
      .all();
    expect(rows.map((r) => r.id)).toEqual([a.sessionId]);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('session_summary on an abandoned terminal row returns applied:false and discardReason', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const project =
      projects.findBySlug('integration-verdict-terminal') ??
      projects.create({ slug: 'integration-verdict-terminal' });
    const client = await connect({ projectSlug: project.slug });
    const agentSessions = new AgentSessionsService(
      createRepositories(services.db.db),
      services.db.db,
    );

    const start = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test' },
    })) as ToolResult;
    const sessionId = (readJson(start) as { sessionId: string }).sessionId;

    await client.callTool({
      name: 'memory.session_summary',
      arguments: { sessionId, summary: '## Goal\nfirst curated summary' },
    });
    agentSessions.markAbandoned(sessionId, { adminBypass: true });

    const second = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { sessionId, summary: '## Goal\nsecond curated' },
    })) as ToolResult;
    const body = readJson(second) as { applied: boolean; discardReason?: string };
    expect(body.applied).toBe(false);
    expect(body.discardReason).toBe('terminal_final');

    await client.close();
  });

  it('session_end on an already-terminal row returns applied:false', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const project =
      projects.findBySlug('integration-verdict-end') ??
      projects.create({ slug: 'integration-verdict-end' });
    const client = await connect({ projectSlug: project.slug });

    const start = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test' },
    })) as ToolResult;
    const sessionId = (readJson(start) as { sessionId: string }).sessionId;

    const firstEnd = (await client.callTool({
      name: 'memory.session_end',
      arguments: { sessionId },
    })) as ToolResult;
    const body1 = readJson(firstEnd) as { applied: boolean };
    expect(body1.applied).toBe(true);

    const secondEnd = (await client.callTool({
      name: 'memory.session_end',
      arguments: { sessionId },
    })) as ToolResult;
    const body2 = readJson(secondEnd) as { applied: boolean };
    expect(body2.applied).toBe(false);

    await client.close();
  });

  it("memory.doctor's pending count diverges from the scoped totals inside one project", async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const project =
      projects.findBySlug('integration-doctor-divergence') ??
      projects.create({ slug: 'integration-doctor-divergence' });
    const client = await connect({ projectSlug: project.slug });

    const save = async (title: string, content: string): Promise<string> => {
      const res = (await client.callTool({
        name: 'memory.save',
        arguments: { type: 'feedback', title, content },
      })) as ToolResult;
      const body = readJson(res) as { id: string; candidates?: unknown[] };
      expect(body.candidates ?? [], `${title} detected candidates`).toEqual([]);
      return body.id;
    };
    const doctorPending = async (): Promise<number> => {
      const res = (await client.callTool({ name: 'memory.doctor', arguments: {} })) as ToolResult;
      return (readJson(res) as { review: { pendingJudgments: number } }).review.pendingJudgments;
    };
    const statsPending = async (): Promise<number> => {
      const res = (await client.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult;
      return (readJson(res) as { pendingJudgmentsTotal: number }).pendingJudgmentsTotal;
    };
    const contextPending = async (): Promise<number> => {
      const res = (await client.callTool({
        name: 'memory.context',
        arguments: { judgments: 50 },
      })) as ToolResult;
      return (readJson(res) as { pendingJudgmentsTotal: number }).pendingJudgmentsTotal;
    };

    const sourceId = await save('quartzite ledger', 'quartzite ledger obsidian marmot');
    const targetId = await save('bramble cistern', 'bramble cistern verdigris palimpsest');
    services.db.raw
      .prepare(
        `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run('01TESTRELDIVERGENCE000001', 'jdg-divergence-itest', sourceId, targetId, Date.now());

    const doctorWithPair = await doctorPending();
    expect(doctorWithPair).toBeGreaterThanOrEqual(1);
    expect(await statsPending()).toBe(1);
    expect(await contextPending()).toBe(1);

    const archived = (await client.callTool({
      name: 'memory.archive',
      arguments: { id: targetId },
    })) as ToolResult;
    expect(archived.isError).toBeFalsy();

    expect(await doctorPending()).toBe(doctorWithPair);
    expect(await statsPending()).toBe(0);
    expect(await contextPending()).toBe(0);

    await client.close();
  });

  describe('the bounds reject over the wire, and the maximum itself is accepted', () => {
    async function callWith(
      client: Client,
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    }

    it.each([
      ['sessions', 25],
      ['prompts', 50],
      ['memories', 100],
      ['judgments', 50],
    ])('rejects memory.context %s above %i', async (arg, max) => {
      const client = await connect();
      const { tools } = await client.listTools();
      const published = (
        tools.find((t) => t.name === 'memory.context')?.inputSchema as
          | { properties?: Record<string, { maximum?: number }> }
          | undefined
      )?.properties?.[arg]?.maximum;
      expect(published, `${arg} published maximum`).toBe(max);

      const rejected = await callWith(client, 'memory.context', { [arg]: max + 1 });
      expect(rejected.isError, arg).toBe(true);
      const text = rejected.content.find((c) => c.type === 'text')?.text ?? '';
      expect(text, arg).toContain('-32602');
      expect(text, arg).toContain(arg);
      expect(text, arg).not.toContain('pendingJudgmentsTotal');
      expect(rejected.structuredContent, arg).toBeUndefined();
      await client.close();
    });

    it('accepts all four memory.context maxima and returns no clamp receipt', async () => {
      const client = await connect();
      const atMax = await callWith(client, 'memory.context', {
        sessions: 25,
        prompts: 50,
        memories: 100,
        judgments: 50,
      });
      expect(atMax.isError).toBeFalsy();
      expect(atMax.structuredContent).not.toHaveProperty('clamped');
      const keys = Object.keys(atMax.structuredContent ?? {}).sort();
      expect(keys.filter((k) => k !== 'rankedPass')).toEqual([
        'needsReview',
        'needsReviewTotal',
        'pendingJudgments',
        'pendingJudgmentsTotal',
        'recentMemories',
        'recentPrompts',
        'recentSessions',
        'relevantMemories',
        'scope',
      ]);
      await client.close();
    });

    it.each([
      ['above its maximum', 101],
      ['below its minimum', 0],
    ])('rejects memory.search_prompts limit %s', async (_label, limit) => {
      const client = await connect();
      const rejected = await callWith(client, 'memory.search_prompts', { limit });
      expect(rejected.isError, `limit ${limit}`).toBe(true);
      const text = rejected.content.find((c) => c.type === 'text')?.text ?? '';
      expect(text, `limit ${limit}`).toContain('-32602');
      expect(text, `limit ${limit}`).toContain('limit');
      await client.close();
    });

    it('accepts memory.search_prompts at its maximum and returns no clamp receipt', async () => {
      const client = await connect();
      const atMax = await callWith(client, 'memory.search_prompts', { limit: 100 });
      expect(atMax.isError).toBeFalsy();
      expect(atMax.structuredContent).not.toHaveProperty('clamped');
      expect(atMax.structuredContent).toHaveProperty('total');
      await client.close();
    });

    it('rejects an over-budget memory.timeline window and names the remedy', async () => {
      const client = await connect();
      const saved = await callWith(client, 'memory.save', {
        type: 'project',
        title: 'timeline window probe',
        content: 'timeline-window-probe',
      });
      const { id } = readJson(saved) as { id: string };

      const rejected = await callWith(client, 'memory.timeline', {
        memoryId: id,
        before: 30,
        after: 30,
      });
      expect(rejected.isError).toBe(true);
      const text = rejected.content.find((c) => c.type === 'text')?.text ?? '';
      expect(text).toContain('invalid_input');
      expect(text).toContain(String(TIMELINE_WINDOW_MAX));
      expect(text).toContain('memory.search');

      const control = await callWith(client, 'memory.timeline', {
        memoryId: id,
        before: 25,
        after: 25,
      });
      expect(control.isError).toBeFalsy();
      await client.close();
    });
  });

  it('advertises behavioral annotations consistent with the append-only/closed-store invariants', async () => {
    const READ_TOOLS = new Set([
      'memory.search',
      'memory.get',
      'memory.context',
      'memory.session_get',
      'memory.timeline',
      'memory.search_prompts',
      'memory.doctor',
      'memory.about',
      'memory.stats',
      'memory.suggest_topic_key',
      'project.list',
      'project.current',
    ]);
    const WRITE_TOOLS = new Set([
      'memory.save',
      'memory.confirm',
      'memory.archive',
      'memory.capture_passive',
      'memory.save_prompt',
      'memory.session_start',
      'memory.session_summary',
      'memory.session_end',
      'memory.session_resume',
      'memory.judge',
      'memory.compare',
      'project.use',
    ]);

    const client = await connect();
    const { tools } = await client.listTools();

    const registered = tools.map((t) => t.name).sort();
    expect(registered).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());

    for (const tool of tools) {
      const ann = tool.annotations;
      expect(ann, `${tool.name} must declare annotations`).toBeDefined();
      expect(ann?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
      expect(ann?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
      expect(typeof ann?.title, `${tool.name} title`).toBe('string');
      expect(ann?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(READ_TOOLS.has(tool.name));
    }

    await client.close();
  });

  it('every tool advertises an outputSchema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} must declare an outputSchema`).toBeDefined();
    }
    await client.close();
  });

  it('returns conforming structuredContent for the tools not exercised elsewhere', async () => {
    const client = await connect();

    const about = await client.callTool({ name: 'memory.about', arguments: {} });
    expect(about.structuredContent).toBeDefined();

    const stats = await client.callTool({ name: 'memory.stats', arguments: {} });
    expect(stats.structuredContent).toBeDefined();

    const savePrompt = await client.callTool({
      name: 'memory.save_prompt',
      arguments: { content: 'a goal worth remembering', title: 'goal' },
    });
    expect(savePrompt.structuredContent).toBeDefined();

    const searchPrompts = await client.callTool({
      name: 'memory.search_prompts',
      arguments: { query: 'goal' },
    });
    expect(searchPrompts.structuredContent).toBeDefined();

    const capture = await client.callTool({
      name: 'memory.capture_passive',
      arguments: { text: '## Key Learnings:\n- first learning\n- second learning\n' },
    });
    expect(capture.structuredContent).toBeDefined();

    const use = await client.callTool({
      name: 'project.use',
      arguments: { slug: 'outputschema-proj', autocreate: true },
    });
    expect(use.structuredContent).toBeDefined();

    const list = await client.callTool({ name: 'project.list', arguments: {} });
    expect(list.structuredContent).toBeDefined();

    const current = await client.callTool({ name: 'project.current', arguments: {} });
    expect(current.structuredContent).toBeDefined();

    await client.close();
  });

  it('round-trips save → search → get → confirm against a path-less /mcp', async () => {
    const client = await connect();

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'roundtrip marker indicator',
        content: 'roundtripmarkeraaa indicator',
        tags: ['integration'],
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();
    const savedPayload = readJson(saved) as { id: string };
    expect(savedPayload.id).toMatch(/^[0-9A-Z]+$/);

    const searched = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'roundtripmarkeraaa', limit: 5 },
    })) as ToolResult;
    if (searched.isError) {
      throw new Error(`search failed: ${JSON.stringify(readJson(searched))}`);
    }
    const searchedPayload = readJson(searched) as { count: number; memories: { id: string }[] };
    expect(searchedPayload.memories.map((m) => m.id)).toContain(savedPayload.id);

    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: savedPayload.id },
    })) as ToolResult;
    const gotPayload = readJson(got) as { memory: { id: string } };
    expect(gotPayload.memory.id).toBe(savedPayload.id);

    const confirmed = (await client.callTool({
      name: 'memory.confirm',
      arguments: { id: savedPayload.id },
    })) as ToolResult;
    expect(confirmed.isError).toBeFalsy();

    await client.close();
  });

  it('reads the default project from a path-less /mcp, with the path-scoped read as control', async () => {
    const dflt = defaultProject(services.db);

    const scoped = await connect({ projectSlug: dflt.slug });
    const saved = readJson(
      (await scoped.callTool({
        name: 'memory.save',
        arguments: {
          type: 'reference',
          title: 'default project marker row',
          content: 'defaultprojectmarkerbbb row',
        },
      })) as ToolResult,
    ) as { id: string };
    expect(saved.id).toMatch(/^[0-9A-Z]+$/);

    const scopedCtx = readJson(
      (await scoped.callTool({ name: 'memory.context', arguments: {} })) as ToolResult,
    ) as { scope: string; recentMemories: { id: string }[] };
    expect(scopedCtx.scope).toBe(`project:${dflt.id}`);
    expect(scopedCtx.recentMemories.map((m) => m.id)).toContain(saved.id);
    await scoped.close();

    const pathless = await connect();
    const pathlessCtx = readJson(
      (await pathless.callTool({ name: 'memory.context', arguments: {} })) as ToolResult,
    ) as { scope: string; recentMemories: { id: string }[] };
    expect(pathlessCtx.scope).toBe(`project:${dflt.id}`);
    expect(pathlessCtx.recentMemories.length).toBeGreaterThan(0);

    const found = readJson(
      (await pathless.callTool({
        name: 'memory.search',
        arguments: { query: 'defaultprojectmarkerbbb', limit: 5 },
      })) as ToolResult,
    ) as { memories: { id: string }[] };
    expect(found.memories.map((m) => m.id)).toContain(saved.id);

    const current = readJson(
      (await pathless.callTool({ name: 'project.current', arguments: {} })) as ToolResult,
    ) as { slug: string | null; projectId: string | null; source: string };
    expect(current).toMatchObject({ slug: dflt.slug, projectId: dflt.id, source: 'default' });
    await pathless.close();
  });

  it('project.list returns the default project as an ordinary entry, and project.use activates it', async () => {
    const dflt = defaultProject(services.db);
    const sibling = await connect();
    await sibling.callTool({
      name: 'project.use',
      arguments: { slug: 'listed-sibling', autocreate: true },
    });
    await sibling.close();

    const client = await connect();
    const listed = readJson(
      (await client.callTool({ name: 'project.list', arguments: {} })) as ToolResult,
    ) as {
      projects: {
        slug: string;
        displayName: string | null;
        archived: boolean;
        activeMemoryCount: number;
      }[];
    };
    const entry = listed.projects.find((p) => p.slug === dflt.slug);
    expect(entry, 'the default project is missing from project.list').toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual([
      'activeMemoryCount',
      'archived',
      'displayName',
      'slug',
    ]);
    expect(entry!.archived).toBe(false);
    expect(typeof entry!.displayName).toBe('string');
    expect(typeof entry!.activeMemoryCount).toBe('number');
    expect(listed.projects.length).toBeGreaterThan(1);

    const used = readJson(
      (await client.callTool({
        name: 'project.use',
        arguments: { slug: dflt.slug },
      })) as ToolResult,
    ) as { slug: string; created: boolean };
    expect(used).toMatchObject({ slug: dflt.slug, created: false });

    const stats = readJson(
      (await client.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult,
    ) as { scope: string };
    expect(stats.scope).toBe(`project:${dflt.id}`);
    await client.close();
  });

  it('seven read surfaces stay closed across a two-step project.use', async () => {
    const dflt = defaultProject(services.db);
    const ENTITY = 'src/closed-scope-probe.ts';
    const seed = async (slug: string | undefined, marker: string) => {
      const c = await connect({ projectSlug: slug });
      const saved = readJson(
        (await c.callTool({
          name: 'memory.save',
          arguments: {
            type: 'reference',
            title: `closed scope ${marker}`,
            content: `closedscopeprobe ${marker} touches ${ENTITY} once`,
          },
        })) as ToolResult,
      ) as { id: string };
      await c.close();
      return saved.id;
    };

    const a = await connect();
    readJson(
      (await a.callTool({
        name: 'project.use',
        arguments: { slug: 'closed-a', autocreate: true },
      })) as ToolResult,
    );
    await a.close();
    const b = await connect();
    readJson(
      (await b.callTool({
        name: 'project.use',
        arguments: { slug: 'closed-b', autocreate: true },
      })) as ToolResult,
    );
    await b.close();

    const defaultId = await seed(dflt.slug, 'in-default');
    const aId = await seed('closed-a', 'in-a');
    const bId = await seed('closed-b', 'in-b');

    const client = await connect();
    expect(
      readJson(
        (await client.callTool({
          name: 'project.use',
          arguments: { slug: 'closed-a' },
        })) as ToolResult,
      ),
    ).toMatchObject({ slug: 'closed-a' });
    expect(
      readJson(
        (await client.callTool({
          name: 'project.use',
          arguments: { slug: 'closed-b', confirmSwitch: true },
        })) as ToolResult,
      ),
    ).toMatchObject({ slug: 'closed-b', switched: true });

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      return { result, body: readJson(result) };
    };
    const outsiders = [defaultId, aId];

    const search = (await call('memory.search', { query: 'closedscopeprobe', limit: 20 })).body as {
      memories: { id: string }[];
    };
    expect(search.memories.map((m) => m.id)).toEqual([bId]);

    const byEntity = (await call('memory.search', { entity: ENTITY })).body as {
      memories: { id: string }[];
    };
    expect(byEntity.memories.map((m) => m.id)).toEqual([bId]);

    const bProjectId = (
      (await call('project.current', {})).body as { slug: string; projectId: string }
    ).projectId;

    const ctx = (await call('memory.context', { memories: 50 })).body as {
      scope: string;
      recentMemories: { id: string }[];
    };
    expect(ctx.scope).toBe(`project:${bProjectId}`);
    expect(ctx.recentMemories.map((m) => m.id)).toEqual([bId]);

    const stats = (await call('memory.stats', {})).body as {
      memoriesByStatus: Record<string, number>;
    };
    expect(stats.memoriesByStatus).toEqual({ active: 1 });

    const batch = (await call('memory.get', { ids: [bId, ...outsiders] })).body as {
      memories: { id: string }[];
      notFound: string[];
    };
    expect(batch.memories.map((m) => m.id)).toEqual([bId]);
    expect(batch.notFound.sort()).toEqual([...outsiders].sort());

    expect((await call('memory.get', { id: bId })).result.isError).toBeFalsy();
    for (const outside of outsiders) {
      const denied = await call('memory.get', { id: outside });
      expect(denied.result.isError).toBe(true);
      expect(JSON.stringify(denied.body)).toContain('not_found');
    }

    const timeline = (await call('memory.timeline', { memoryId: bId, before: 25, after: 25 }))
      .body as { before: { id: string }[]; after: { id: string }[] };
    const neighbors = [...timeline.before, ...timeline.after].map((m) => m.id);
    for (const outside of outsiders) expect(neighbors).not.toContain(outside);
    for (const outside of outsiders) {
      const denied = await call('memory.timeline', { memoryId: outside });
      expect(denied.result.isError).toBe(true);
    }

    await client.close();
  });

  it('project.use pins after a path-less memory.session_start, and the switch gates still refuse a real pin', async () => {
    const client = await connect();

    const started = readJson(
      (await client.callTool({
        name: 'memory.session_start',
        arguments: { agent: 'pin-after-start' },
      })) as ToolResult,
    ) as { sessionId: string };
    expect(started.sessionId).toMatch(/^[0-9A-Z]+$/);

    const used = (await client.callTool({
      name: 'project.use',
      arguments: { slug: 'pin-after-start-a', autocreate: true },
    })) as ToolResult;
    if (used.isError) throw new Error(`project.use refused: ${JSON.stringify(readJson(used))}`);
    expect(readJson(used)).toMatchObject({
      slug: 'pin-after-start-a',
      created: true,
      switched: false,
      source: 'tool-explicit',
    });

    const unconfirmed = (await client.callTool({
      name: 'project.use',
      arguments: { slug: 'pin-after-start-b', autocreate: true },
    })) as ToolResult;
    expect(unconfirmed.isError).toBe(true);
    expect(readJson(unconfirmed)).toMatchObject({
      code: 'project_switch_requires_confirm',
      currentSlug: 'pin-after-start-a',
      targetSlug: 'pin-after-start-b',
    });

    const confirmed = (await client.callTool({
      name: 'project.use',
      arguments: { slug: 'pin-after-start-b', autocreate: true, confirmSwitch: true },
    })) as ToolResult;
    expect(confirmed.isError).toBe(true);
    expect(readJson(confirmed)).toMatchObject({
      code: 'session_active_must_end',
      activeSessionId: started.sessionId,
      currentSlug: 'pin-after-start-a',
      targetSlug: 'pin-after-start-b',
    });

    await client.close();
  });

  it('a project-pinned token denied the default project is told how to reach its own, at the wire', async () => {
    const projectsSvc = new ProjectsService(createRepositories(services.db.db));
    const own = projectsSvc.create({ slug: 'pinned-remedy-proj' });
    const tokensSvc = new TokensService(createRepositories(services.db.db), services.db.db);
    const pinned = tokensSvc.create({ name: 'pinned-remedy', project: own, access: 'write' });

    const pathless = await connect({ token: pinned.plaintext });
    const refused = (await pathless.callTool({
      name: 'memory.search',
      arguments: { query: 'anything' },
    })) as ToolResult;
    expect(refused.isError).toBe(true);
    const body = readJson(refused) as { code: string; message: string };
    expect(body.code).toBe('forbidden');
    expect(body.message).toContain(`project '${defaultProject(services.db).id}'`);
    expect(body.message).toContain("project.use({slug: 'pinned-remedy-proj'})");
    expect(body.message).toContain("reconnect at '/mcp/pinned-remedy-proj'");
    await pathless.close();

    const scoped = await connect({ token: pinned.plaintext, projectSlug: own.slug });
    const allowed = (await scoped.callTool({
      name: 'memory.search',
      arguments: { query: 'anything' },
    })) as ToolResult;
    expect(allowed.isError).toBeFalsy();
    await scoped.close();
  });

  it('memory.save publishes no scope argument, and one sent anyway is rejected', async () => {
    const projectsSvc = new ProjectsService(createRepositories(services.db.db));
    const own = projectsSvc.create({ slug: 'no-scope-arg-proj' });
    const client = await connect({ projectSlug: own.slug });

    const { tools } = await client.listTools();
    const save = tools.find((t) => t.name === 'memory.save');
    expect(save, 'memory.save missing from tools/list').toBeDefined();
    const properties = (save?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('type');
    expect(Object.keys(properties)).not.toContain('scope');

    const rejected = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'reference',
        title: 'sent a retired argument',
        content: 'sentaretiredargumentaaa',
      },
    })) as ToolResult;
    expect(rejected.isError).toBe(true);
    const message = rejected.content.find((c) => c.type === 'text')?.text ?? '';
    expect(message).toContain('-32602');
    expect(message).toContain('memory.save');
    expect(message).toContain('scope');

    const accepted = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'reference',
        title: 'sent no retired argument',
        content: 'sentnoretiredargumentaaa',
      },
    })) as ToolResult;
    expect(accepted.isError).toBeFalsy();
    const saved = readJson(accepted) as { id: string };
    const row = new MemoryService(createRepositories(services.db.db), services.db.db).unsafeGetById(
      saved.id,
    );
    expect(row?.projectId).toBe(own.id);
    expect(row?.scope).toBe('project');
    await client.close();
  });

  it('memory.search publishes no include_global, and one sent anyway is rejected', async () => {
    const dflt = defaultProject(services.db);
    const projectsSvc = new ProjectsService(createRepositories(services.db.db));
    const own = projectsSvc.create({ slug: 'no-widen-arg-proj' });
    const memorySvc = new MemoryService(createRepositories(services.db.db), services.db.db);
    const outside = memorySvc.save(
      { type: 'user', title: 'widenprobe outside row', content: 'widenprobeaaa outside row' },
      { kind: 'project', projectId: dflt.id },
    );
    const inside = memorySvc.save(
      { type: 'user', title: 'widenprobe inside row', content: 'widenprobeaaa inside row' },
      { kind: 'project', projectId: own.id },
    );

    const client = await connect({ projectSlug: own.slug });
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'memory.search');
    const properties = (search?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('query');
    expect(Object.keys(properties)).not.toContain('include_global');

    const rejected = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'widenprobeaaa', include_global: true, limit: 20 },
    })) as ToolResult;
    expect(rejected.isError).toBe(true);
    const message = rejected.content.find((c) => c.type === 'text')?.text ?? '';
    expect(message).toContain('-32602');
    expect(message).toContain('memory.search');
    expect(message).toContain('include_global');

    const accepted = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'widenprobeaaa', limit: 20 },
    })) as ToolResult;
    expect(accepted.isError).toBeFalsy();
    const ids = (readJson(accepted) as { memories: { id: string }[] }).memories.map((m) => m.id);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
    await client.close();

    const pathless = await connect();
    const own2 = (await pathless.callTool({
      name: 'memory.search',
      arguments: { query: 'widenprobeaaa', limit: 20 },
    })) as ToolResult;
    expect((readJson(own2) as { memories: { id: string }[] }).memories.map((m) => m.id)).toContain(
      outside.id,
    );
    await pathless.close();
  });

  it('refuses an unknown property on every registered tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(15);

    for (const tool of tools) {
      const rejected = (await client.callTool({
        name: tool.name,
        arguments: { rembric_unknown_probe: 1 },
      })) as ToolResult;
      const message = rejected.content.find((c) => c.type === 'text')?.text ?? '';
      expect(rejected.isError, `${tool.name} accepted an unknown property`).toBe(true);
      expect(message, tool.name).toContain('rembric_unknown_probe');
      expect(message, tool.name).toContain(tool.name);
    }
    await client.close();
  });

  it('accepts a maximal legitimate argument set on the tools strictness most affects', async () => {
    const projectsSvc = new ProjectsService(createRepositories(services.db.db));
    const target = projectsSvc.create({ slug: 'strictness-controls-proj' });
    const client = await connect();
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const r = (await client.callTool({ name, arguments: args })) as ToolResult;
      expect(r.isError, `${name}: ${JSON.stringify(readJson(r))}`).toBeFalsy();
      return r;
    };

    const used = readJson(await call('project.use', { slug: target.slug, autocreate: false })) as {
      projectId: string;
    };
    expect(used.projectId).toBe(target.id);

    const started = readJson(
      await call('memory.session_start', {
        agent: 'strictness-probe',
        description: 'maximal legitimate argument set',
        project: target.slug,
      }),
    ) as { sessionId: string };

    const saved = readJson(
      await call('memory.save', {
        type: 'project',
        title: 'strictness control row',
        content: 'strictnesscontrolaaa row body',
        tags: ['strictness', 'control'],
        topic_key: 'strictness-control',
        sessionId: started.sessionId,
      }),
    ) as { id: string };

    await call('memory.search', {
      query: 'strictnesscontrolaaa',
      type: 'project',
      tag: 'strictness',
      status: 'active',
      topic_key: 'strictness-control',
      include_relations: true,
      limit: 20,
      offset: 0,
    });
    await call('memory.search', { entity: 'strictnesscontrolaaa' });
    await call('memory.get', { id: saved.id, relations_limit: 5 });
    await call('memory.get', { ids: [saved.id] });
    await call('memory.context', {
      sessions: 2,
      prompts: 2,
      memories: 5,
      judgments: 5,
      includeArchived: true,
      focus: 'strictnesscontrolaaa',
    });
    await client.close();
  });

  it('still rejects a wrong-typed declared argument, as it did before strictness', async () => {
    const client = await connect();
    const rejected = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'anything', limit: 'not-a-number' },
    })) as ToolResult;
    expect(rejected.isError).toBe(true);
    const message = rejected.content.find((c) => c.type === 'text')?.text ?? '';
    expect(message).toContain('-32602');
    expect(message).toContain('limit');
    expect(message).not.toContain('rembric_unknown_probe');
    await client.close();
  });

  it('a path-less memory.save with only type, title and content lands in the default project', async () => {
    const dflt = defaultProject(services.db);
    const client = await connect();
    const result = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'reference',
        title: 'no arguments beyond the required three',
        content: 'norequiredargumentsbeyondaaa',
      },
    })) as ToolResult;
    if (result.isError) {
      throw new Error(`path-less save refused: ${JSON.stringify(readJson(result))}`);
    }
    const saved = readJson(result) as { id: string };
    const row = new MemoryService(createRepositories(services.db.db), services.db.db).unsafeGetById(
      saved.id,
    );
    expect(row?.projectId).toBe(dflt.id);
    await client.close();
  });

  it('the five surfaces that named a retired scope no longer do, read from tools/list', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const desc = (name: string): string => {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} missing from tools/list`).toBeDefined();
      const d = t?.description ?? '';
      expect(d.length).toBeGreaterThan(0);
      return d;
    };

    const save = desc('memory.save');
    expect(save).not.toContain('scope_locked');
    expect(save).not.toMatch(/scope=global|user-wide/i);

    const search = desc('memory.search');
    expect(search).not.toContain("Every connection sees exactly one project's memories.");
    expect(search).toContain('`across_projects:true` also reads the other projects');
    expect(search).not.toContain('unscoped see globals only');
    expect(search).toBeTruthy();

    expect(desc('memory.doctor')).not.toMatch(/global/i);
    expect(desc('memory.stats')).not.toMatch(/global/i);

    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions).not.toMatch(/global|include_global|user-wide/i);
    await client.close();

    const scoped = await connect({ projectSlug: defaultProject(services.db).slug });
    const scopedInstructions = scoped.getInstructions() ?? '';
    expect(scopedInstructions.length).toBeGreaterThan(0);
    expect(scopedInstructions).not.toMatch(/global|include_global|user-wide/i);
    await scoped.close();
  });

  it('no registered tool names a retired scope anywhere in the manifest', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.length).toBeGreaterThanOrEqual(23);

    const RETIRED = /global|include_global|user-wide/i;
    let propertiesChecked = 0;
    for (const tool of tools) {
      expect(tool.description ?? '', `${tool.name} description`).not.toMatch(RETIRED);
      const schema = tool.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      for (const [property, spec] of Object.entries(schema.properties ?? {})) {
        propertiesChecked += 1;
        expect(property, `${tool.name} property name`).not.toMatch(RETIRED);
        expect(spec.description ?? '', `${tool.name}.${property} describe()`).not.toMatch(RETIRED);
      }
    }
    expect(propertiesChecked).toBeGreaterThan(20);
  });

  it('no refusal a path-less or a path-scoped connection can produce points at a scope', async () => {
    const dflt = defaultProject(services.db);
    const repos = createRepositories(services.db.db);
    const elsewhere = new ProjectsService(repos).create({ slug: 'refusal-enum-proj' });
    const pinned = new TokensService(repos, services.db.db).create({
      name: 'refusal-enum',
      project: elsewhere,
      access: 'read',
    });

    const refusals: { where: string; code: unknown; message: unknown; body: string }[] = [];
    const record = async (
      where: string,
      client: Client,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      expect(result.isError, `${where} was expected to refuse`).toBe(true);
      const payload = readJson(result) as { code?: unknown; message?: unknown };
      refusals.push({
        where,
        code: payload?.code,
        message: payload?.message,
        body: JSON.stringify(payload),
      });
    };

    const unresolvable = await connect({ projectSlug: 'no-such-project-here' });
    await record('unresolvable slug / save', unresolvable, 'memory.save', {
      type: 'reference',
      title: 'refusal enumeration',
      content: 'refusal enumeration content',
    });
    await record('unresolvable slug / search', unresolvable, 'memory.search', { query: 'x' });
    await record('unresolvable slug / context', unresolvable, 'memory.context', {});
    await unresolvable.close();

    const scoped = await connect({ projectSlug: dflt.slug });
    await record('path-scoped / switch away', scoped, 'project.use', { slug: 'somewhere-else' });
    await record('path-scoped / session_start elsewhere', scoped, 'memory.session_start', {
      project: 'somewhere-else',
    });
    await record('path-scoped / cross-project get', scoped, 'memory.get', {
      id: '01JJJJJJJJJJJJJJJJJJJJJJJJ',
    });
    await scoped.close();

    const denied = await connect({ token: pinned.plaintext });
    await record('path-less / token denied the default project', denied, 'memory.context', {});
    await denied.close();

    expect(refusals.length).toBe(7);

    const expected: Record<string, { code: string; message: string }> = {
      'unresolvable slug / save': {
        code: 'project_not_found',
        message:
          "project 'no-such-project-here' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})",
      },
      'unresolvable slug / search': {
        code: 'project_not_found',
        message:
          "project 'no-such-project-here' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})",
      },
      'unresolvable slug / context': {
        code: 'project_not_found',
        message:
          "project 'no-such-project-here' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})",
      },
      'path-scoped / switch away': {
        code: 'scope_locked',
        message: `connection is path-scoped to '${dflt.slug}'; cannot switch via tool`,
      },
      'path-scoped / session_start elsewhere': {
        code: 'scope_locked',
        message: `connection is path-scoped to '${dflt.slug}'; cannot start a session for project 'somewhere-else'`,
      },
      'path-scoped / cross-project get': {
        code: 'not_found',
        message: "memory '01JJJJJJJJJJJJJJJJJJJJJJJJ' not found",
      },
      'path-less / token denied the default project': {
        code: 'forbidden',
        message:
          `token scope 'read:project:${elsewhere.id}' does not authorize read on project '${dflt.id}'` +
          `; this token is pinned to project 'refusal-enum-proj' — ` +
          `call project.use({slug: 'refusal-enum-proj'}) or reconnect at '/mcp/refusal-enum-proj'`,
      },
    };
    expect(refusals.map((r) => r.where).sort()).toEqual(Object.keys(expected).sort());
    for (const { where, code, message } of refusals) {
      expect({ where, code, message }).toEqual({ where, ...expected[where] });
    }

    for (const { where, body } of refusals) {
      expect(body, `${where}: names a scope`).not.toMatch(/global|user-wide/i);
      expect(body, `${where}: offers a path-less entry`).not.toMatch(
        /path-less|second, path-less|add a .*\/mcp.* entry/i,
      );
      expect(body, `${where}: tells the agent to set a scope`).not.toMatch(/set scope|scope=/i);
    }
    expect(refusals.filter((r) => r.code === 'scope_locked').map((r) => r.where)).toEqual([
      'path-scoped / switch away',
      'path-scoped / session_start elsewhere',
    ]);
    expect(refusals.some((r) => /project\.use\(\{slug/.test(r.body))).toBe(true);
  });

  it('rejects an invalid token before reaching tool dispatch', async () => {
    await expect(connect({ token: 'definitely-not-valid' })).rejects.toThrow();
  });

  it('session lifecycle: start → save (stamps session_id) → summary → end → context returns it', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'wiring the lifecycle test' },
    })) as ToolResult;
    expect(started.isError).toBeFalsy();
    const startedPayload = readJson(started) as { sessionId: string };
    expect(startedPayload.sessionId).toMatch(/^[0-9A-Z]+$/);

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'lifecycle saved row',
        content: 'lifecycle-saved-row',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();
    const savedPayload = readJson(saved) as { id: string };

    const summarised = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: wire test. Accomplished: done.', title: 'Wire test' },
    })) as ToolResult;
    expect(summarised.isError).toBeFalsy();

    const ended = (await client.callTool({
      name: 'memory.session_end',
      arguments: {},
    })) as ToolResult;
    expect(ended.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 5, memories: 5 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null; status: string }[];
      recentMemories: { id: string }[];
    };
    const seenSession = ctxPayload.recentSessions.find((s) => s.id === startedPayload.sessionId);
    expect(seenSession?.status).toBe('ended');
    expect(seenSession?.summary).toMatch(/wire test/);
    expect(ctxPayload.recentMemories.some((m) => m.id === savedPayload.id)).toBe(true);

    await client.close();
  });

  it('memory.context excludes a session ended without memories or summary', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'empty session' },
    })) as ToolResult;
    const startedPayload = readJson(started) as { sessionId: string };

    const ended = (await client.callTool({
      name: 'memory.session_end',
      arguments: {},
    })) as ToolResult;
    expect(ended.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string }[];
    };
    expect(ctxPayload.recentSessions.some((s) => s.id === startedPayload.sessionId)).toBe(false);

    await client.close();
  });

  it('memory.context caps recentMemories at the default of 10 when no size arg is given', async () => {
    const client = await connect();
    for (let i = 0; i < 12; i++) {
      await client.callTool({
        name: 'memory.save',
        arguments: {
          type: 'project',
          title: `ctx default cap marker ${i}`,
          content: `ctx-default-cap-marker-${i}`,
        },
      });
    }
    const ctx = (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult;
    const payload = readJson(ctx) as { recentMemories: unknown[] };
    expect(payload.recentMemories.length).toBeLessThanOrEqual(10);
    await client.close();
  });

  it('memory.context backfills past empty sessions to return useful older ones', async () => {
    const client = await connect();

    const usefulStart = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'useful session' },
    })) as ToolResult;
    const usefulPayload = readJson(usefulStart) as { sessionId: string };
    await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'backfill useful row',
        content: 'backfill-useful-row',
      },
    });
    await client.callTool({ name: 'memory.session_end', arguments: {} });

    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'memory.session_start',
        arguments: { agent: 'rembric-test', description: `empty ${i}` },
      });
      await client.callTool({ name: 'memory.session_end', arguments: {} });
    }

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 1 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as { recentSessions: { id: string }[] };
    expect(ctxPayload.recentSessions).toHaveLength(1);
    expect(ctxPayload.recentSessions[0]?.id).toBe(usefulPayload.sessionId);

    await client.close();
  });

  it('memory.context truncates a long session summary to ≤350 chars while storage stays full', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'long summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const fullSummary = `Goal: ${'x'.repeat(600)}`; // 606 chars, under the write cap, over the 350 display bound
    const summarised = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: fullSummary, title: 'Long' },
    })) as ToolResult;
    expect(summarised.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary).not.toBeNull();
    expect(seen?.summary?.length).toBeLessThanOrEqual(350);
    expect(seen?.summary?.endsWith('…')).toBe(true);

    const stored = createRepositories(services.db.db).agentSessions.getById(sessionId);
    expect(stored?.summary).toBe(fullSummary);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context returns a short session summary verbatim (no ellipsis)', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'short summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const shortSummary = 'Goal: short session. Accomplished: nothing notable.';
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: shortSummary },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary).toBe(shortSummary);
    expect(seen?.summary?.endsWith('…')).toBe(false);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context emits null for a content-bearing session with no summary', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'no-summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'anchor row, no session summary',
        content: 'anchor row, no session summary',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen).toBeDefined();
    expect(seen?.summary).toBeNull();

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context surfaces a session title verbatim and untruncated', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'titled session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const title = 'T'.repeat(100);
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: titled session test.', title },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; title: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.title).toBe(title);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context suppresses an uncurated (placeholder) session title as null', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'untitled session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'anchor row, placeholder title',
        content: 'anchor row, placeholder title',
      },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; title: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen).toBeDefined();
    expect(seen?.title).toBeNull();

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context suppresses a raw (uncurated) session summary even when the session is content-bearing via another clause', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'raw-summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'anchor row, raw summary',
        content: 'anchor row, raw summary',
      },
    });

    services.db.db
      .update(agentSessions)
      .set({ summary: 'raw transcript dump, never curated', summaryFinal: false })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen).toBeDefined();
    expect(seen?.summary).toBeNull();

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get returns the FULL summary while memory.context returns a snippet', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'session_get full summary' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const fullSummary = `Goal: ${'y'.repeat(700)}`; // over the 350 snippet bound, under the 10000 cap
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: fullSummary },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary?.length).toBeLessThanOrEqual(350);

    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBeFalsy();
    const gotPayload = readJson(got) as { id: string; summary: string | null };
    expect(gotPayload.id).toBe(sessionId);
    expect(gotPayload.summary).toBe(fullSummary);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get succeeds with only sessionId and carries no `versions` key', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'session_get no limit' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: the argument is gone, not just unused.' },
    });

    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBeFalsy();
    const payload = readJson(got) as { summary: string | null };
    expect(payload.summary).toBe('Goal: the argument is gone, not just unused.');
    expect(payload).not.toHaveProperty('versions');

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get refuses a stale caller still sending `limit`, naming the tool and the property', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'stale limit argument' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const rejected = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId, limit: 2 },
    })) as ToolResult;
    const message = rejected.content.find((c) => c.type === 'text')?.text ?? '';
    expect(rejected.isError).toBe(true);
    expect(message).toContain('limit');
    expect(message).toContain('memory.session_get');

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get returns not_found for a cross-scope session', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    projects.create({ slug: 'getsession-proj' });

    const pinned = await connect({ projectSlug: 'getsession-proj' });
    const started = (await pinned.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'project-scoped session' },
    })) as ToolResult;
    const startedPayload = readJson(started) as { sessionId: string; scope: string };
    const { sessionId } = startedPayload;
    expect(startedPayload.scope).toBe('project');
    await pinned.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: lives in a project.' },
    });
    const inScope = (await pinned.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(inScope.isError).toBeFalsy();
    await pinned.callTool({ name: 'memory.session_end', arguments: {} });
    await pinned.close();

    const globalClient = await connect();
    const got = (await globalClient.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBe(true);
    expect((readJson(got) as { code?: string }).code).toBe('not_found');
    await globalClient.close();
  });

  it('memory.session_get returns not_found for a soft-deleted session', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'soon-deleted session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: about to be soft-deleted.' },
    });

    services.db.db
      .update(agentSessions)
      .set({ deletedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBe(true);
    expect((readJson(got) as { code?: string }).code).toBe('not_found');
    await client.close();
  });

  it('a resumed session reads back as active with no endedAt, and its memory timeline stays one thread', async () => {
    const projects = new ProjectsService(createRepositories(services.db.db));
    const project =
      projects.findBySlug('integration-resume-readback') ??
      projects.create({ slug: 'integration-resume-readback' });
    const client = await connect({ projectSlug: project.slug });

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const first = (await client.callTool({
      name: 'memory.save',
      arguments: { type: 'feedback', title: 'before the end', content: 'resume-thread-first' },
    })) as ToolResult;
    const firstSaved = readJson(first) as { id: string };

    await client.callTool({ name: 'memory.session_end', arguments: { sessionId } });

    const closed = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    const closedPayload = readJson(closed) as { status: string; endedAt: string | null };
    expect(closedPayload.status).toBe('ended');
    expect(closedPayload.endedAt).toEqual(expect.any(String));

    const orphan = (await client.callTool({
      name: 'memory.save',
      arguments: { type: 'feedback', title: 'between stints', content: 'resume-thread-orphan' },
    })) as ToolResult;
    const orphanSaved = readJson(orphan) as { id: string };
    const orphanTl = (await client.callTool({
      name: 'memory.timeline',
      arguments: { memoryId: orphanSaved.id, before: 5, after: 5 },
    })) as ToolResult;
    expect((readJson(orphanTl) as { fallback: string | null }).fallback).toBe('time_window');

    const resumed = (await client.callTool({
      name: 'memory.session_resume',
      arguments: { sessionId },
    })) as ToolResult;
    expect(resumed.isError).toBeFalsy();

    const reread = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    const rereadPayload = readJson(reread) as { status: string; endedAt: string | null };
    expect(rereadPayload.status).toBe('active');
    expect(rereadPayload.endedAt).toBeNull();

    const second = (await client.callTool({
      name: 'memory.save',
      arguments: { type: 'feedback', title: 'after the resume', content: 'resume-thread-second' },
    })) as ToolResult;
    const secondSaved = readJson(second) as { id: string };

    const tl = (await client.callTool({
      name: 'memory.timeline',
      arguments: { memoryId: firstSaved.id, before: 5, after: 5 },
    })) as ToolResult;
    expect(tl.isError).toBeFalsy();
    const tlPayload = readJson(tl) as {
      before: { id: string }[];
      after: { id: string; sessionId: string | null }[];
      fallback: string | null;
    };
    expect(tlPayload.fallback).toBeNull();
    expect(tlPayload.after.map((m) => m.id)).toEqual([secondSaved.id]);
    expect(tlPayload.after[0]?.sessionId).toBe(sessionId);
    expect(tlPayload.before).toEqual([]);

    await client.callTool({ name: 'memory.session_end', arguments: { sessionId } });
    await client.close();
  });

  it('memory.save with topic_key auto-supersedes the prior active row', async () => {
    const client = await connect();
    const first = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'project',
        title: 'auth model: JWT',
        content: 'auth model: JWT',
        topic_key: 'decision/auth-model',
      },
    })) as ToolResult;
    expect(first.isError).toBeFalsy();
    const firstPayload = readJson(first) as { id: string };

    const second = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'project',
        title: 'auth model: opaque tokens',
        content: 'auth model: opaque tokens',
        topic_key: 'decision/auth-model',
      },
    })) as ToolResult;
    expect(second.isError).toBeFalsy();
    const secondPayload = readJson(second) as { id: string };
    expect(secondPayload.id).not.toBe(firstPayload.id);

    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: firstPayload.id },
    })) as ToolResult;
    const gotPayload = readJson(got) as { memory: { status: string } };
    expect(gotPayload.memory.status).toBe('superseded');

    const searched = (await client.callTool({
      name: 'memory.search',
      arguments: {
        query: 'auth model JWT',
        status: 'superseded',
        include_relations: true,
      },
    })) as ToolResult;
    expect(searched.isError).toBeFalsy();
    const searchedPayload = readJson(searched) as {
      memories: { id: string }[];
      expanded?: { id: string; expandedFrom: string; relationKind: string }[];
    };
    expect(searchedPayload.memories.map((m) => m.id)).toContain(firstPayload.id);
    const head = searchedPayload.expanded?.find((e) => e.expandedFrom === firstPayload.id);
    expect(head?.id).toBe(secondPayload.id);
    expect(head?.relationKind).toBe('superseded_by');

    const searchedNoExpand = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'auth model JWT', status: 'superseded' },
    })) as ToolResult;
    const noExpandPayload = readJson(searchedNoExpand) as { expanded?: unknown };
    expect(noExpandPayload.expanded).toBeUndefined();

    await client.close();
  });

  it('memory.save surfaces candidates[] when similar content already exists', async () => {
    const client = await connect();
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'memory.save',
        arguments: {
          type: 'feedback',
          title: 'fruitcake bicycle aluminum',
          content: 'fruitcake bicycle aluminum windowpane horizon',
        },
      });
    }
    const second = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'fruitcake bicycle aluminum',
        content: 'fruitcake bicycle aluminum windowpane horizon',
      },
    })) as ToolResult;
    expect(second.isError).toBeFalsy();
    const payload = readJson(second) as {
      id: string;
      candidates: { judgmentId: string; targetId: string; source: 'fts' | 'vec' }[];
      judgmentRequired: boolean;
    };
    expect(payload.candidates.length).toBeGreaterThanOrEqual(1);
    expect(payload.judgmentRequired).toBe(true);
    expect(payload.candidates[0]!.source).toBe('vec');

    const judgmentId = payload.candidates[0]!.judgmentId;
    const judgement = (await client.callTool({
      name: 'memory.judge',
      arguments: {
        judgmentId,
        relation: 'related',
        confidence: 0.9,
        reason: 'overlapping content',
      },
    })) as ToolResult;
    expect(judgement.isError).toBeFalsy();
    const judgedPayload = readJson(judgement) as { status: string; relation: string };
    expect(judgedPayload.status).toBe('judged');
    expect(judgedPayload.relation).toBe('related');

    await client.close();
  });

  it('memory.compare records a verdict between two arbitrary memories', async () => {
    const client = await connect();
    const a = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'compare test aaa',
        content: 'compare-test-aaa',
      },
    })) as ToolResult;
    const b = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'compare test bbb',
        content: 'compare-test-bbb',
      },
    })) as ToolResult;
    const aId = (readJson(a) as { id: string }).id;
    const bId = (readJson(b) as { id: string }).id;

    const compared = (await client.callTool({
      name: 'memory.compare',
      arguments: {
        memoryIdA: aId,
        memoryIdB: bId,
        relation: 'related',
        confidence: 0.8,
        reason: 'both about compare-test',
      },
    })) as ToolResult;
    expect(compared.isError).toBeFalsy();
    const payload = readJson(compared) as { status: string; relation: string };
    expect(payload.status).toBe('judged');
    expect(payload.relation).toBe('related');

    await client.close();
  });

  it('memory.suggest_topic_key returns a deterministic family/slug', async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: 'memory.suggest_topic_key',
      arguments: { type: 'project', title: 'JWT auth middleware' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const payload = readJson(res) as { topic_key: string };
    expect(payload.topic_key).toMatch(/^decision\//);
    expect(payload.topic_key.length).toBeGreaterThan('decision/'.length);
    await client.close();
  });

  it('memory.doctor returns the expected JSON shape', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'memory.doctor',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const payload = readJson(result) as {
      db: { journalMode: string; integrity: string; sizeBytes: number };
      embeddings: { model: string; backlog: number };
      entities: { backlog: number };
      consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
      sessions: { active: number };
      review: { needsReview: number; pendingJudgments: number };
      warnings: string[];
    };
    expect(Object.keys(payload.db).sort()).toEqual(['integrity', 'journalMode', 'sizeBytes']);
    const { tools } = await client.listTools();
    const dbSchema = (
      tools.find((t) => t.name === 'memory.doctor')?.outputSchema as
        | { properties?: { db?: { properties?: Record<string, unknown>; required?: string[] } } }
        | undefined
    )?.properties?.db;
    expect(Object.keys(dbSchema?.properties ?? {}).sort()).toEqual([
      'integrity',
      'journalMode',
      'sizeBytes',
    ]);
    expect(dbSchema?.required ?? []).not.toContain('open');
    expect(payload.db.journalMode).toMatch(/wal/i);
    expect(payload.db.integrity).toMatch(/ok/i);
    expect(typeof payload.db.sizeBytes).toBe('number');
    expect('llm' in payload).toBe(false);
    expect(payload.embeddings.model).toContain('gte-multilingual-base');
    expect('enabled' in payload.embeddings).toBe(false);
    expect(typeof payload.review.needsReview).toBe('number');
    expect(typeof payload.review.pendingJudgments).toBe('number');
    expect(typeof payload.sessions.active).toBe('number');
    expect(typeof payload.entities.backlog).toBe('number');
    expect(Array.isArray(payload.warnings)).toBe(true);
    await client.close();
  });

  it('memory.doctor passes output validation after an archive has been journaled', async () => {
    const client = await connect();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'doctor after archive',
        content: 'doctor-after-archive-marker',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();

    const archived = (await client.callTool({
      name: 'memory.archive',
      arguments: { id: (readJson(saved) as { id: string }).id },
    })) as ToolResult;
    expect(archived.isError).toBeFalsy();

    const result = (await client.callTool({
      name: 'memory.doctor',
      arguments: {},
    })) as ToolResult;
    if (result.isError) {
      throw new Error(`memory.doctor failed after an archive: ${JSON.stringify(readJson(result))}`);
    }
    const payload = readJson(result) as {
      consolidation: { lastRunAt: string | null; lastRunOps: Record<string, unknown> };
    };
    expect(payload.consolidation.lastRunOps).toEqual({
      kind: 'agent_memory_archive',
      archived: 1,
    });
    expect(payload.consolidation.lastRunAt).toBeTruthy();
    await client.close();
  });

  it('memory.save without session_start succeeds and the row has session_id = null', async () => {
    const client = await connect();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'no session row marker',
        content: 'no-session-row-marker',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();
    const savedPayload = readJson(saved) as { id: string };

    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: savedPayload.id },
    })) as ToolResult;
    expect(got.isError).toBeFalsy();
    const tl = (await client.callTool({
      name: 'memory.timeline',
      arguments: { memoryId: savedPayload.id, before: 1, after: 1 },
    })) as ToolResult;
    if (tl.isError) {
      throw new Error(`timeline failed: ${JSON.stringify(readJson(tl))}`);
    }
    const tlPayload = readJson(tl) as { fallback: string | null };
    expect(tlPayload.fallback).toBe('time_window');

    await client.close();
  });

  it('returns a structured error when memory.get is called with an unknown id', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'memory.get',
      arguments: { id: 'definitely-not-an-id' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    const payload = readJson(result) as { code?: string };
    expect(payload.code).toBe('not_found');
    await client.close();
  });
  it('memory.context exposes aged pending judgments and memory.judge clears them', async () => {
    const client = await connect();

    const saveOne = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'pending source marker',
        content: 'pending-source-marker',
      },
    })) as ToolResult;
    const saveTwo = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'pending target marker',
        content: 'pending-target-marker',
      },
    })) as ToolResult;
    const sourceId = (readJson(saveOne) as { id: string }).id;
    const targetId = (readJson(saveTwo) as { id: string }).id;

    const insert = services.db.raw.prepare(
      `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    insert.run(
      '01TESTRELAGED000000000000A',
      'jdg-aged-itest',
      sourceId,
      targetId,
      Date.now() - 2 * 86_400_000,
    );
    insert.run('01TESTRELFRESH00000000000B', 'jdg-fresh-itest', targetId, sourceId, Date.now());

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    const payload = readJson(ctx) as {
      pendingJudgments: {
        judgmentId: string;
        sourceSnippet: string;
        targetSnippet: string;
        ageMs: number;
      }[];
      pendingJudgmentsTotal: number;
    };
    expect(payload.pendingJudgments).toHaveLength(1);
    expect(payload.pendingJudgments[0]?.judgmentId).toBe('jdg-aged-itest');
    expect(payload.pendingJudgments[0]?.sourceSnippet).toContain('pending-source-marker');
    expect(payload.pendingJudgments[0]?.targetSnippet).toContain('pending-target-marker');
    expect(payload.pendingJudgments[0]?.ageMs).toBeGreaterThan(86_400_000);
    expect(payload.pendingJudgmentsTotal).toBeGreaterThanOrEqual(2);

    const inventory = (await client.callTool({
      name: 'memory.context',
      arguments: { judgments: 50 },
    })) as ToolResult;
    const inventoryPayload = readJson(inventory) as {
      pendingJudgments: { judgmentId: string }[];
    };
    const inventoryIds = inventoryPayload.pendingJudgments.map((r) => r.judgmentId);
    expect(inventoryIds).toContain('jdg-aged-itest');
    expect(inventoryIds).toContain('jdg-fresh-itest');

    const judged = (await client.callTool({
      name: 'memory.judge',
      arguments: {
        judgmentId: 'jdg-aged-itest',
        relation: 'not_conflict',
        reason: 'integration cleanup',
      },
    })) as ToolResult;
    expect(judged.isError).toBeFalsy();

    const ctxAfter = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    const after = readJson(ctxAfter) as { pendingJudgments: unknown[] };
    expect(after.pendingJudgments).toHaveLength(0);

    await client.close();
  });

  it('memory.context surfaces needsReview, search/get expose reviewState, confirm clears it', async () => {
    const client = await connect();

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'project',
        title: 'needs review marker goal',
        content: 'needsreviewmarkeraaa goal',
      },
    })) as ToolResult;
    const id = (readJson(saved) as { id: string }).id;

    services.db.raw
      .prepare(`UPDATE memory SET created_at = ? WHERE id = ?`)
      .run(Date.now() - 100 * 86_400_000, id);

    const ctx = (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult;
    const payload = readJson(ctx) as {
      needsReview: {
        id: string;
        type: string;
        snippet: string;
        reviewAfter: string;
        ageMs: number;
      }[];
      pendingJudgments: { judgmentId: string }[];
      needsReviewTotal: number;
    };
    expect(payload.needsReview).toHaveLength(1);
    expect(payload.needsReview[0]?.id).toBe(id);
    expect(payload.needsReview[0]?.snippet).toContain('needsreviewmarkeraaa');
    expect(payload.needsReview[0]?.ageMs).toBeGreaterThan(0);
    expect(typeof payload.needsReview[0]?.reviewAfter).toBe('string');
    expect(payload.pendingJudgments).toHaveLength(0);
    expect(payload.needsReviewTotal).toBe(1);

    const searched = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'needsreviewmarkeraaa' },
    })) as ToolResult;
    const sPayload = readJson(searched) as { memories: { id: string; reviewState?: string }[] };
    expect(sPayload.memories.find((m) => m.id === id)?.reviewState).toBe('needs_review');

    const got = (await client.callTool({ name: 'memory.get', arguments: { id } })) as ToolResult;
    expect((readJson(got) as { reviewState?: string }).reviewState).toBe('needs_review');

    const confirmed = (await client.callTool({
      name: 'memory.confirm',
      arguments: { id },
    })) as ToolResult;
    expect(confirmed.isError).toBeFalsy();

    const ctxAfter = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    expect(
      (readJson(ctxAfter) as { needsReview: unknown[]; needsReviewTotal: number }).needsReviewTotal,
    ).toBe(0);
    expect((readJson(ctxAfter) as { needsReview: unknown[] }).needsReview).toHaveLength(0);

    await client.close();
  });

  it('memory.stats totals (needsReviewTotal, pendingJudgmentsTotal) are scope-isolated (task 5.3)', async () => {
    const projA = await connect({ projectSlug: 'stats-totals-proj-a' });
    const projB = await connect({ projectSlug: 'stats-totals-proj-b' });
    await projA.callTool({
      name: 'project.use',
      arguments: { slug: 'stats-totals-proj-a', autocreate: true },
    });
    await projB.callTool({
      name: 'project.use',
      arguments: { slug: 'stats-totals-proj-b', autocreate: true },
    });

    const saveOne = (await projA.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'stats totals source marker',
        content: 'stats-totals-source-marker',
      },
    })) as ToolResult;
    const saveTwo = (await projA.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'stats totals target marker',
        content: 'stats-totals-target-marker',
      },
    })) as ToolResult;
    const sourceId = (readJson(saveOne) as { id: string }).id;
    const targetId = (readJson(saveTwo) as { id: string }).id;

    services.db.raw
      .prepare(
        `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run('01TESTRELSTATS0000000000A', 'jdg-stats-itest', sourceId, targetId, Date.now());

    const statsA = (await projA.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult;
    const statsAPayload = readJson(statsA) as {
      needsReviewTotal: number;
      pendingJudgmentsTotal: number;
    };
    expect(statsAPayload.pendingJudgmentsTotal).toBe(1);
    expect(statsAPayload.needsReviewTotal).toBe(0);

    const statsB = (await projB.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult;
    const statsBPayload = readJson(statsB) as {
      needsReviewTotal: number;
      pendingJudgmentsTotal: number;
    };
    expect(statsBPayload.pendingJudgmentsTotal).toBe(0);
    expect(statsBPayload.needsReviewTotal).toBe(0);

    await projA.close();
    await projB.close();
  });

  it("project.list's activeMemoryCount drops when a memory is archived, and is per-project", async () => {
    const P = 'active-count-proj-p';
    const Q = 'active-count-proj-q';
    const pClient = await connect({ projectSlug: P });
    const qClient = await connect({ projectSlug: Q });
    for (const [client, slug] of [
      [pClient, P],
      [qClient, Q],
    ] as const) {
      const used = (await client.callTool({
        name: 'project.use',
        arguments: { slug, autocreate: true },
      })) as ToolResult;
      expect(used.isError, `project.use ${slug}`).toBeFalsy();
    }

    interface ListEntry {
      slug: string;
      activeMemoryCount: number;
    }
    const listProjects = async (): Promise<ListEntry[]> => {
      const r = (await pClient.callTool({ name: 'project.list', arguments: {} })) as ToolResult;
      expect(r.isError, 'project.list').toBeFalsy();
      return (readJson(r) as { projects: ListEntry[] }).projects;
    };
    const entryFor = (projects: ListEntry[], slug: string): ListEntry => {
      const entry = projects.find((e) => e.slug === slug);
      expect(entry, `project.list has no entry for ${slug}`).toBeDefined();
      return entry as ListEntry;
    };
    const save = async (client: Client, title: string): Promise<string> => {
      const r = (await client.callTool({
        name: 'memory.save',
        arguments: { type: 'feedback', title, content: `${title} body` },
      })) as ToolResult;
      expect(r.isError, `memory.save ${title}`).toBeFalsy();
      return (readJson(r) as { id: string }).id;
    };

    const pMemoryId = await save(pClient, 'active count p only row');
    await save(qClient, 'active count q first row');
    await save(qClient, 'active count q second row');

    const before = await listProjects();
    expect(entryFor(before, P).activeMemoryCount).toBe(1);
    expect(entryFor(before, Q).activeMemoryCount).toBe(2);
    for (const entry of before) expect('memoryCount' in entry).toBe(false);

    const archived = (await pClient.callTool({
      name: 'memory.archive',
      arguments: { id: pMemoryId },
    })) as ToolResult;
    expect(archived.isError, 'memory.archive').toBeFalsy();

    const after = await listProjects();
    expect(entryFor(after, P).activeMemoryCount).toBe(0);
    expect(entryFor(after, Q).activeMemoryCount).toBe(2);

    const defaultClient = await connect();
    const defaultSave = (await defaultClient.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'active count default project row',
        content: 'active-count-default-project-row',
      },
    })) as ToolResult;
    expect(defaultSave.isError, 'path-less memory.save').toBeFalsy();
    const withDefault = await listProjects();
    expect(entryFor(withDefault, P).activeMemoryCount).toBe(0);
    expect(entryFor(withDefault, Q).activeMemoryCount).toBe(2);
    await defaultClient.close();

    await save(pClient, 'active count p replacement row');
    const stats = (await pClient.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult;
    expect(stats.isError, 'memory.stats').toBeFalsy();
    const byStatus = (readJson(stats) as { memoriesByStatus: Record<string, number> })
      .memoriesByStatus;
    const totalRows = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const pCount = entryFor(await listProjects(), P).activeMemoryCount;
    expect(pCount).toBe(byStatus.active ?? 0);
    expect(pCount).toBeLessThan(totalRows);

    await pClient.close();
    await qClient.close();
  });

  it('memory.context as the FIRST call on an unscoped connection with a discoverable root returns project scope', async () => {
    const repos = createRepositories(services.db.db);
    const projectsSvc = new ProjectsService(repos);
    const project = projectsSvc.create({ slug: 'integration-roots-ctx-proj' });
    repos.memory.insert({
      id: '01TESTROOTSCTXMARKER00000A',
      scope: 'project',
      projectId: project.id,
      type: 'project',
      title: 'roots-discovered context marker',
      content: 'roots-discovered context marker',
      tags: [],
      status: 'active',
      replaces: [],
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });

    const client = await connect({ rootUri: `file:///tmp/${project.slug}` });
    const ctx = (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult;
    expect(ctx.isError).toBeFalsy();
    const payload = readJson(ctx) as { scope: string; recentMemories: { snippet: string }[] };
    expect(payload.scope).toBe(`project:${project.id}`);
    expect(
      payload.recentMemories.some((m) => m.snippet.includes('roots-discovered context marker')),
    ).toBe(true);

    await client.close();
  });

  it('memory.capture_passive writes to the default project when roots surface an unminted slug', async () => {
    const dflt = defaultProject(services.db);
    const client = await connect({ rootUri: 'file:///tmp/integration-unminted-slug' });
    const result = (await client.callTool({
      name: 'memory.capture_passive',
      arguments: { text: '## Key Learnings:\n- captured against the default project\n' },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const saved = readJson(result) as { saved: number; ids: string[] };
    expect(saved.saved).toBeGreaterThan(0);

    const current = readJson(
      (await client.callTool({ name: 'project.current', arguments: {} })) as ToolResult,
    ) as { projectId: string | null; suggestedSlugs: string[] };
    expect(current.projectId).toBe(dflt.id);
    expect(current.suggestedSlugs).toEqual(['integration-unminted-slug']);

    await client.close();
  });
});
