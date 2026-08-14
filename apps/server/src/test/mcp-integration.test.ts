import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import {
  CONTEXT_MEMORIES_MAX,
  CONTEXT_PROMPTS_MAX,
  CONTEXT_SESSIONS_MAX,
  TIMELINE_WINDOW_MAX,
} from '../mcp/memory-tools.js';
import { DESCRIPTION_MAX_LENGTH } from '../mcp/server.js';
import { SESSION_GET_VERSIONS_MAX } from '../mcp/session-tools.js';
import { SUMMARY_SECTIONS } from '../mcp/summary-rubric.js';
import { type BootstrappedServer, createServer } from '../server/index.js';
import { SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';
import { ABSTENTION_FLOOR, EMPTY_POOL_REASON } from '../services/hybrid-search.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RELATION_ANNOTATION_MAX } from '../services/relations.js';
import { TokensService } from '../services/tokens.js';

import { createTestDb } from './db.js';
import { defaultProject } from './default-project.js';
import { FakeEmbedder } from './embedder.js';

import { findFreePort } from './index.js';

/**
 * 8.10 / 13.14 — MCP protocol conformance tests.
 *
 * Drive an in-process rembric server with the official MCP TypeScript SDK
 * Client. Covers:
 *
 *   - handshake on `/mcp` with a bearer token
 *   - tool listing (the four memory.* tools exposed in src/mcp/server.ts)
 *   - tool invocation: save → search → get → confirm round-trip
 *   - error shape on bad input (missing required fields)
 *   - path-scoped vs unscoped semantics — globals vs project memories
 *
 * The test mints its own admin token, starts the bootstrapper against a
 * fresh on-disk SQLite, then closes everything in afterAll.
 */

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
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-zzz';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup(); // we only want the unique dataDir; remove the pre-created DB.

    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder() },
    );

    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function connect(
    opts: { token?: string; projectSlug?: string; rootUri?: string } = {},
  ): Promise<Client> {
    const token = opts.token ?? ADMIN_TOKEN;
    const url = new URL(`${baseUrl}/mcp${opts.projectSlug ? `/${opts.projectSlug}` : ''}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
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
    // Unscoped /mcp connection — instructions point at project.use.
    const globalClient = await connect();
    const globalInstructions = globalClient.getInstructions();
    expect(globalInstructions).toMatch(/project\.use/);
    expect(globalInstructions).not.toContain('X-Rembric-Project');
    expect(globalInstructions).toContain(SUMMARY_SECTIONS);
    expect((globalInstructions ?? '').length).toBeLessThanOrEqual(1000);
    await globalClient.close();

    // Path-scoped /mcp/<slug> connection — instructions name the slug.
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
    // The four legacy memory tools must remain present; new tools are
    // verified separately by name.
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

    // Recall trigger (existing protocol-teaching contract).
    expect(desc).toMatch(/recall|remember|recuerda/i);
    // Hybrid semantic + keyword ranking is advertised (not the stale "FTS5 keyword search").
    expect(desc).toMatch(/hybrid/i);
    expect(desc).toMatch(/semantic/i);
    // Widen affordance: small default page, raise limit or page with offset.
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

    // The anti-confabulation clause the mcp-api scenario is written against,
    // verbatim.
    expect(desc).toContain('not as a signal to invent or assume context');
    expect(desc).toContain('nothing relevant found');
    // `ABSTENTION_FLOOR` ships `null`, so the description must not attribute
    // abstention to it. This is the assertion whose absence let the shipped
    // description name a mechanism that cannot fire.
    expect(ABSTENTION_FLOOR).toBeNull();
    expect(desc).not.toMatch(/relevance floor/i);

    // The shortening flag, and what a short page and a full page each do not mean.
    expect(desc).toContain('gateShortened');
    expect(desc).toContain('a short page is not corpus exhaustion');
    expect(desc).toContain('a full page is not proof of relevance');

    // Measured at the boundary the client reads, not off the constant.
    expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(desc.length, 'the reword drifted from the recorded description budget').toBe(1856);
  });

  it('memory.archive description steers against autonomous retirement', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const archive = tools.find((t) => t.name === 'memory.archive');
    const desc = archive?.description ?? '';

    // Gated on explicit user request to retire/remove/forget.
    expect(desc).toMatch(/explicit/i);
    expect(desc).toMatch(/retire|remove|forget/i);
    // Prefer supersede when a replacement exists (no-successor path).
    expect(desc).toMatch(/supersede/i);
    expect(desc).toMatch(/topic_key/i);
    // No autonomous cleanup during recall/save.
    expect(desc).toMatch(/autonomous|cleanup|housekeeping/i);
    // Reversible from the dashboard.
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
    // A size argument that silently changes WHICH rows qualify is not guessable
    // from the argument name, so the description has to say so.
    expect(desc).toMatch(/lifts the age filter/i);

    await client.close();
  });

  it('memory.doctor description discloses the server-wide population and names memory.stats', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const doctor = tools.find((t) => t.name === 'memory.doctor');
    // Control: a missing tool leaves `desc` empty, and every negative assertion
    // below then passes while proving nothing.
    expect(doctor, 'memory.doctor missing from tools/list').toBeDefined();
    const desc = doctor?.description ?? '';
    expect(desc.length).toBeGreaterThan(0);

    // The report has no `llm` block, so advertising one invites a client to read
    // its absence as a fault.
    expect(desc).not.toMatch(/llm/i);

    expect(desc).toMatch(/server-wide/i);
    expect(desc).toMatch(/all projects/i);
    expect(desc).toContain('memory.stats');
    expect(desc).toMatch(/differ/i);

    expect(desc).toContain('entities');
    expect(desc).toContain('sessions');
    expect(desc).toContain('review');

    // Client truncation is a tail cut, so the disclosure sits in the first
    // sentence rather than after the usage hint.
    expect(desc.split('. ')[0]).toMatch(/server-wide/i);

    // Asserting the string alone cannot catch the description drifting from the
    // payload again, which is how the `llm` claim survived its own removal.
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

    // memory.doctor's description sends the model here for the scoped
    // equivalents, so a pointer that lands on silence is the failure mode.
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

    // The field name alone does not say which statuses count, so the
    // description the model reads has to.
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
      // The whole mitigation: an ask of `relationsTotal` alone is what this
      // schema rejects, so the recipe has to be the bounded one.
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
      // No clamped payload rides along with the rejection.
      expect(text, call.name).not.toContain('relationsTotal');
    }

    // The maximum itself is accepted, so the recipe the description teaches works.
    const atMax = (await client.callTool({
      name: 'memory.get',
      arguments: { id, relations_limit: RELATION_ANNOTATION_MAX },
    })) as ToolResult;
    expect(atMax.isError).toBeFalsy();
    expect(readJson(atMax)).toMatchObject({ relations: [], relationsTotal: 0 });

    await client.close();
  });

  it("memory.get's batch form reports the same review metadata and replaces as the single-id form", async () => {
    // Its own project: a refuted row is `needs_review`, which would otherwise
    // show up in the global scope's needsReview channel other tests assert on.
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
    const project =
      projects.findBySlug('integration-batch-parity') ??
      projects.create({ slug: 'integration-batch-parity' });
    const client = await connect({ projectSlug: project.slug });
    // listTools primes the SDK's output-schema validator, so every callTool
    // below also asserts the payload against the published outputSchema.
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

    // A refutation forces `needs_review` immediately, whatever the type's TTL.
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

    // The single-id call is the control: without it a batch carrying nothing
    // is indistinguishable from a scope where no row needs review.
    expect(singleBody.reviewState).toBe('needs_review');
    expect(singleBody.reviewAfter).toEqual(expect.any(String));
    expect(singleBody.reviewEscalated).toBe(false);
    expect(head!.reviewState).toBe(singleBody.reviewState);
    expect(head!.reviewAfter).toBe(singleBody.reviewAfter);
    expect(head!.reviewEscalated).toBe(singleBody.reviewEscalated);
    expect(head!.replaces).toEqual([predecessorId]);
    expect(head!.replaces).toEqual(singleBody.memory.replaces);

    // Status-driven, not form-driven: the superseded row in the same page
    // carries none of the three.
    expect(predecessor!.status).toBe('superseded');
    for (const field of ['reviewState', 'reviewAfter', 'reviewEscalated']) {
      expect(field in predecessor!, `${field} on a superseded batch entry`).toBe(false);
    }

    // The two deliberate asymmetries.
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
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
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

    // One row carrying every query term, four carrying one common term: the
    // relative filter cuts the four, leaving a page short of `limit`.
    const shortClient = await connect({ projectSlug: shortened.slug });
    // Arms the CLIENT-side output-schema validator, which the SDK compiles only
    // in `cacheToolMetadata` — reachable from `listTools` alone (client/index.js
    // :540-563). The server validates its own output regardless; this puts the
    // consumer's ajv pass in the loop too, so `structuredContent` is checked by
    // both ends rather than only by the assertions below.
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

    // Same gated pool, paged past the single survivor but still inside the
    // five-row pool: the ungated page there holds rows, so the gate is why this
    // one ran out. Empty here is not abstention — the pool was never empty.
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

    // Same gated pool again, now paged AT and PAST the pool's end. The ungated
    // page is empty here too, so the gate is not the cause and the flag would
    // promise a recovery paging cannot deliver.
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

    // Control: three equally-relevant rows, so the filter removes nothing. The
    // page past the end is empty because the caller paged past the pool, and
    // that is not the gate's doing.
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
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
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

    // No-query listing: the ranked pass never runs, so there is no verdict to
    // forward — but `abstained` is REQUIRED by the published output schema, so
    // the branch must still assert its own `false` rather than omit the field.
    const listing = (await client.callTool({
      name: 'memory.search',
      arguments: { limit: 5 },
    })) as ToolResult;
    const listed = readJson(listing) as Record<string, unknown>;
    expect(listed.count).toBeGreaterThan(0);
    expect(listed).toHaveProperty('abstained', false);
    expect(listing.structuredContent).toHaveProperty('abstained', false);
    expect(listed).not.toHaveProperty('abstainReason');

    // A `type` filter matching no row empties the fused pool, which is the only
    // abstention reachable with an embedder wired: sqlite-vec returns neighbours
    // whatever their distance, so a populated scope never abstains on distance.
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

    // Derived from the whole response, so a newly registered tool inherits the
    // guard; the floor stops an empty listing passing vacuously.
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

    // Pins the GUARD's unit, not the string's: `memory.save`'s description holds
    // `∈`, `·` and `≤`, so measuring bytes would report a different number, and
    // an earlier exploration did exactly that while labelling it characters.
    const save = tools.find((t) => t.name === 'memory.save')?.description ?? '';
    const savesMeasured = measured.find((m) => m.name === 'memory.save')?.length;
    expect(savesMeasured).toBe(save.length);
    expect(savesMeasured).not.toBe(Buffer.byteLength(save, 'utf8'));

    // The one behavioural lever `candidatesDetected` gives an agent. A future
    // edit that trims the description for length must not quietly drop it and
    // leave a bare number the agent can only read.
    expect(save).toContain('candidatesDetected');
    expect(save).toContain('memory.suggest_topic_key');
    expect(save).toContain('CANDIDATES_PER_SAVE_MAX');
    // No request argument raises the surfaced count, so the description must
    // not send the agent at one — the defect this repo already shipped once.
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

    // Measured from the live `tools/list` string, never from the source
    // constant — the boundary an external client truncates at.
    it.each([
      ['memory.context', 1432],
      ['memory.search_prompts', 428],
      ['memory.session_start', 818],
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

    // A first message states a goal almost by definition, so a trigger keyed on
    // that fires once per session by construction — which is how this tool came
    // to be called on nearly every opening turn.
    it('memory.save_prompt restrains WHEN it is called, not only what to pass', () => {
      const desc = descriptions.get('memory.save_prompt') ?? '';
      // Anchored: an unanchored /reusable/i is also satisfied by "reusable
      // artifact" further down, which left the opening claim uncovered.
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
      // The description's literal is a fourth copy of the handler's bound; a
      // bound change that misses the prose fails here.
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
      // Scope alone is not the whole story, so it must not read as the only cause.
      expect(desc).not.toMatch(/and they will differ\.\s/);
      // `:856` — truncation is a tail cut, so the disclosure precedes the hint.
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
    });

    it('memory.session_resume names every field its outputSchema requires', () => {
      const desc = descriptions.get('memory.session_resume') ?? '';
      const required = requiredBySchema.get('memory.session_resume') ?? [];
      // Read from the live schema rather than restated here, so a field added
      // to it is covered on the day it lands. Two are named explicitly because
      // they are the only report of a value the row does not retain, and the
      // pins below would pass over an empty required list without them.
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
    // Its own project, so no other test's active session can be adopted here.
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
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

    // The control: adoption, not a coincidence of ids — only one row exists.
    const rows = server.dbHandle.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.projectId, project.id))
      .all();
    expect(rows.map((r) => r.id)).toEqual([a.sessionId]);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it("memory.doctor's pending count diverges from the scoped totals inside one project", async () => {
    // One project for every call, so the population cannot explain the gap.
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
    const project =
      projects.findBySlug('integration-doctor-divergence') ??
      projects.create({ slug: 'integration-doctor-divergence' });
    const client = await connect({ projectSlug: project.slug });

    // Deliberately unalike, so save-time candidate detection adds no second
    // pending pair and the counts below are the one this test seeds.
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
    server.dbHandle.raw
      .prepare(
        `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run('01TESTRELDIVERGENCE000001', 'jdg-divergence-itest', sourceId, targetId, Date.now());

    // doctor's counter is server-wide, so only its DELTA is meaningful here.
    const doctorWithPair = await doctorPending();
    expect(doctorWithPair).toBeGreaterThanOrEqual(1);
    expect(await statsPending()).toBe(1);
    expect(await contextPending()).toBe(1);

    const archived = (await client.callTool({
      name: 'memory.archive',
      arguments: { id: targetId },
    })) as ToolResult;
    expect(archived.isError).toBeFalsy();

    // Same project, same connection: the scoped totals drop because the pair is
    // no longer adjudicable, doctor's unfiltered inventory count does not move.
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

    // One test per argument, so a bound weakened by one constant reddens only
    // the test that names it. The probe values are LITERAL: deriving max+1 from
    // the constant under test would move with it and detect nothing.
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
      // No payload rides along with the rejection.
      expect(text, arg).not.toContain('pendingJudgmentsTotal');
      expect(rejected.structuredContent, arg).toBeUndefined();
      await client.close();
    });

    it('accepts all four memory.context maxima and returns no clamp receipt', async () => {
      const client = await connect();
      // The control: without it a rejection above the maximum cannot be told
      // from a broken probe.
      const atMax = await callWith(client, 'memory.context', {
        sessions: 25,
        prompts: 50,
        memories: 100,
        judgments: 50,
      });
      expect(atMax.isError).toBeFalsy();
      expect(atMax.structuredContent).not.toHaveProperty('clamped');
      // The nine remaining keys; `rankedPass` is the one conditional addition.
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

    // Two-sided, and split so weakening `.max` and weakening `.min` redden
    // different tests.
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
      // The remedy the description names too, so the two stay in step.
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
    // Read tools never mutate. Every Rembric tool is non-destructive (rows are
    // never deleted; supersede is a reversible status flip) and closed-world
    // (single local store) — so destructiveHint/openWorldHint are false for ALL
    // tools. The name sets below are exhaustive against the registered tools;
    // a newly-registered tool with no entry fails the partition assertion.
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

    // Every registered tool is partitioned into exactly one of the two sets —
    // catches an un-annotated new tool.
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
    // The SDK validates structuredContent against the registered outputSchema
    // on every call, so a non-throwing call with structuredContent present IS
    // the schema conformance test. The save→search→get→confirm/context/session/
    // timeline/judge/compare/doctor/suggest_topic_key paths are covered by other
    // tests in this file; this fills the gap for the rest.
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
    const dflt = defaultProject(server.dbHandle);

    // Write through a path-scoped connection, so the row lands in the default
    // project exactly where the migration leaves the previously-global corpus.
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

    // Control — must hold on both sides of the resolver change.
    const scopedCtx = readJson(
      (await scoped.callTool({ name: 'memory.context', arguments: {} })) as ToolResult,
    ) as { scope: string; recentMemories: { id: string }[] };
    expect(scopedCtx.scope).toBe(`project:${dflt.id}`);
    expect(scopedCtx.recentMemories.map((m) => m.id)).toContain(saved.id);
    await scoped.close();

    // Subject: the same corpus, read from `/mcp` with no slug.
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
    const dflt = defaultProject(server.dbHandle);
    // Own sibling, so the "listed alongside others" control does not depend on
    // which other tests in this file happened to run first. Minted on its own
    // connection: a pinned router entry would make the `project.use` below a
    // switch, which is a different gate from the one under test.
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
    // Non-vacuity: it is listed alongside others, not the only entry.
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
    const dflt = defaultProject(server.dbHandle);
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
    // Step one, then the confirmed switch: `project.use` moves the single closed
    // scope, so the reads below must see project B alone at the end of it.
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

    // The flow `instructions.ts` documents verbatim: pin (and create) after the
    // session is open. A default-project resolution is not an activation, so it
    // must not make this look like a project switch.
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

    // Control — the gates are not globally weakened: moving off a DELIBERATE
    // pin still demands confirmation.
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

    // Control — and with a session open, a confirmed switch away from a
    // deliberate pin is still refused.
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
    const projectsSvc = new ProjectsService(createRepositories(server.dbHandle.db));
    const own = projectsSvc.create({ slug: 'pinned-remedy-proj' });
    const tokensSvc = new TokensService(createRepositories(server.dbHandle.db), server.dbHandle.db);
    const pinned = tokensSvc.create({ name: 'pinned-remedy', project: own, access: 'write' });

    const pathless = await connect({ token: pinned.plaintext });
    const refused = (await pathless.callTool({
      name: 'memory.search',
      arguments: { query: 'anything' },
    })) as ToolResult;
    expect(refused.isError).toBe(true);
    const body = readJson(refused) as { code: string; message: string };
    expect(body.code).toBe('forbidden');
    expect(body.message).toContain(`project '${defaultProject(server.dbHandle).id}'`);
    expect(body.message).toContain("project.use({slug: 'pinned-remedy-proj'})");
    expect(body.message).toContain("reconnect at '/mcp/pinned-remedy-proj'");
    await pathless.close();

    // Control — the remedy names a reachable path: the same token on its own
    // slug is authorized.
    const scoped = await connect({ token: pinned.plaintext, projectSlug: own.slug });
    const allowed = (await scoped.callTool({
      name: 'memory.search',
      arguments: { query: 'anything' },
    })) as ToolResult;
    expect(allowed.isError).toBeFalsy();
    await scoped.close();
  });

  it('memory.save publishes no scope argument, and one sent anyway is rejected', async () => {
    const projectsSvc = new ProjectsService(createRepositories(server.dbHandle.db));
    const own = projectsSvc.create({ slug: 'no-scope-arg-proj' });
    const client = await connect({ projectSlug: own.slug });

    const { tools } = await client.listTools();
    const save = tools.find((t) => t.name === 'memory.save');
    expect(save, 'memory.save missing from tools/list').toBeDefined();
    const properties = (save?.inputSchema.properties ?? {}) as Record<string, unknown>;
    // Non-vacuity: the schema IS published, so the absence below is a removed
    // property rather than an empty manifest.
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

    // Control: the same call without the retired argument succeeds, so the
    // rejection above is the unknown key and not a broken save path.
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
    const row = new MemoryService(
      createRepositories(server.dbHandle.db),
      server.dbHandle.db,
    ).unsafeGetById(saved.id);
    expect(row?.projectId).toBe(own.id);
    expect(row?.scope).toBe('project');
    await client.close();
  });

  it('memory.search publishes no include_global, and one sent anyway is rejected', async () => {
    const dflt = defaultProject(server.dbHandle);
    const projectsSvc = new ProjectsService(createRepositories(server.dbHandle.db));
    const own = projectsSvc.create({ slug: 'no-widen-arg-proj' });
    const memorySvc = new MemoryService(createRepositories(server.dbHandle.db), server.dbHandle.db);
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

    // Control: the same query without the retired argument is accepted, sees
    // the in-scope row and not the other project's — so the rejection above is
    // the unknown key, and the scope closure it used to prove still holds.
    const accepted = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'widenprobeaaa', limit: 20 },
    })) as ToolResult;
    expect(accepted.isError).toBeFalsy();
    const ids = (readJson(accepted) as { memories: { id: string }[] }).memories.map((m) => m.id);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
    await client.close();

    // The excluded row is findable by the same query on the connection that
    // owns it, so the exclusion is the scope, not the index.
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
    // Without this the loop below would pass over an empty manifest.
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
    const projectsSvc = new ProjectsService(createRepositories(server.dbHandle.db));
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
    const dflt = defaultProject(server.dbHandle);
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
    const row = new MemoryService(
      createRepositories(server.dbHandle.db),
      server.dbHandle.db,
    ).unsafeGetById(saved.id);
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
    // Reclaimed to pay for the widening clause, and false once a search can
    // read more than one project. The successor sentence is what replaced it.
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

    const scoped = await connect({ projectSlug: defaultProject(server.dbHandle).slug });
    const scopedInstructions = scoped.getInstructions() ?? '';
    expect(scopedInstructions.length).toBeGreaterThan(0);
    expect(scopedInstructions).not.toMatch(/global|include_global|user-wide/i);
    await scoped.close();
  });

  it('no registered tool names a retired scope anywhere in the manifest', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    // Without this the negative assertions below all pass over an empty
    // manifest, which is the only way this test can lie.
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
        // `describe()` lands here, the only place a per-argument string reaches
        // the model.
        expect(spec.description ?? '', `${tool.name}.${property} describe()`).not.toMatch(RETIRED);
      }
    }
    // Second non-vacuity control: the property loop ran over real properties.
    expect(propertiesChecked).toBeGreaterThan(20);
  });

  it('no refusal a path-less or a path-scoped connection can produce points at a scope', async () => {
    const dflt = defaultProject(server.dbHandle);
    const repos = createRepositories(server.dbHandle.db);
    const elsewhere = new ProjectsService(repos).create({ slug: 'refusal-enum-proj' });
    const pinned = new TokensService(repos, server.dbHandle.db).create({
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

    // Verbatim pins, not a deny-list of prohibited words. Measured: a deny-list
    // stays green on `Open a second connection with no project in the URL to
    // store this for every project at once.`, which is the prohibited
    // instruction paraphrased. Pinning the whole message means any edit to a
    // refusal reds this test and a human re-approves it, which is what
    // `mcp-api`'s no-false-remedy requirement actually needs.
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

    // Cheap second layer over the whole payload, which the pins above cover
    // only for `code` and `message`.
    for (const { where, body } of refusals) {
      expect(body, `${where}: names a scope`).not.toMatch(/global|user-wide/i);
      expect(body, `${where}: offers a path-less entry`).not.toMatch(
        /path-less|second, path-less|add a .*\/mcp.* entry/i,
      );
      expect(body, `${where}: tells the agent to set a scope`).not.toMatch(/set scope|scope=/i);
    }
    // `scope_locked` survives on the two switch paths and is deliberately kept:
    // it locks switching, not a scope.
    expect(refusals.filter((r) => r.code === 'scope_locked').map((r) => r.where)).toEqual([
      'path-scoped / switch away',
      'path-scoped / session_start elsewhere',
    ]);
    // Control: the remedy that IS reachable is still offered where it applies,
    // so the loop above is not passing over messages stripped of everything.
    expect(refusals.some((r) => /project\.use\(\{slug/.test(r.body))).toBe(true);
  });

  it('rejects an invalid token before reaching tool dispatch', async () => {
    await expect(connect({ token: 'definitely-not-valid' })).rejects.toThrow();
  });

  it('session lifecycle: start → save (stamps session_id) → summary → end → context returns it', async () => {
    const client = await connect();

    // 1. Start a session.
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'wiring the lifecycle test' },
    })) as ToolResult;
    expect(started.isError).toBeFalsy();
    const startedPayload = readJson(started) as { sessionId: string };
    expect(startedPayload.sessionId).toMatch(/^[0-9A-Z]+$/);

    // 2. Save a memory; server should auto-stamp session_id.
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

    // 3. Summarise the session (writes summary but does NOT end the session
    //    under the new contract — session stays `active`).
    const summarised = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: wire test. Accomplished: done.', title: 'Wire test' },
    })) as ToolResult;
    expect(summarised.isError).toBeFalsy();

    // 4. Explicitly end the session — sole transition path.
    const ended = (await client.callTool({
      name: 'memory.session_end',
      arguments: {},
    })) as ToolResult;
    expect(ended.isError).toBeFalsy();

    // 5. memory.context should include the session as recent and `ended`.
    //    The session was anchored to a saved memory AND received a summary,
    //    so it satisfies the `sessionHasContent` predicate and survives the
    //    content filter applied by recentForContext.
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

    // First: a session WITH content (will be the oldest).
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

    // Then: three empty sessions in newer-than-useful order.
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

  // Snippet tests run in global scope and END their session before closing.
  // session_start resumes the transport's active session, and a lingering
  // active session would pollute the global auto-stamp used by later tests —
  // so each test cleans up. end() does not auto-curate a summary, so the
  // null-summary case stays null after ending.
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

    // Storage is unaffected: the row still holds the full, untruncated summary.
    const stored = createRepositories(server.dbHandle.db).agentSessions.getById(sessionId);
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

    // Anchor a memory so the session is content-bearing without a summary.
    // memory.save auto-stamps the active session_id, so no summary is written.
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

    const title = 'T'.repeat(100); // max title length — proves it is emitted whole, never snippet-truncated
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

    // Content-bearing via an anchored memory; never summarized with a title → titleFinal stays
    // false, so the placeholder title must not leak into agent-facing context.
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

    // Content-bearing via an anchored memory, not via a curated summary.
    await client.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'anchor row, raw summary',
        content: 'anchor row, raw summary',
      },
    });

    // A per-turn raw sync (summary_final=0), never curated.
    server.dbHandle.db
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

    // memory.context truncates to the snippet bound...
    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary?.length).toBeLessThanOrEqual(350);

    // ...while memory.session_get returns the full, untruncated summary.
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

  it('memory.session_get omitted or zero `limit` is byte-identical to a call with no `limit` at all', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'limit byte-identical' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: first', title: 'T1' },
    });
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: second', title: 'T2' },
    });

    const withoutLimit = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    const withZero = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId, limit: 0 },
    })) as ToolResult;

    expect(withoutLimit.isError).toBeFalsy();
    expect(readJson(withoutLimit)).toEqual(readJson(withZero));
    expect(readJson(withoutLimit)).not.toHaveProperty('versions');

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get with a positive `limit` returns recent versions newest-first, full content and their own title', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'limit returns versions' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const long = (n: number) => `Goal: ${'z'.repeat(400)} (${n})`;
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: long(1), title: 'T1' },
    });
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: long(2), title: 'T2' },
    });
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: long(3), title: 'T3' },
    });

    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId, limit: 2 },
    })) as ToolResult;
    expect(got.isError).toBeFalsy();
    const payload = readJson(got) as {
      versions: { version: number; title: string | null; content: string }[];
    };
    expect(payload.versions).toHaveLength(2);
    expect(payload.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(payload.versions[0]?.title).toBe('T3');
    expect(payload.versions[0]?.content).toBe(long(3));
    expect(payload.versions[0]?.content.length).toBeGreaterThan(350);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it("memory.session_get's `limit` is rejected above its maximum, not clamped", async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'limit over max' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId, limit: SESSION_GET_VERSIONS_MAX + 1 },
    })) as ToolResult;
    expect(got.isError).toBe(true);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it("memory.session_get's `limit` respects scope: a cross-scope session still returns not_found", async () => {
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
    projects.create({ slug: 'getsession-limit-proj' });

    const pinned = await connect({ projectSlug: 'getsession-limit-proj' });
    const started = (await pinned.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'limit scope' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };
    await pinned.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: lives in a project.' },
    });
    await pinned.callTool({ name: 'memory.session_end', arguments: {} });
    await pinned.close();

    const globalClient = await connect();
    const got = (await globalClient.callTool({
      name: 'memory.session_get',
      arguments: { sessionId, limit: 1 },
    })) as ToolResult;
    expect(got.isError).toBe(true);
    expect((readJson(got) as { code?: string }).code).toBe('not_found');
    await globalClient.close();
  });

  it('memory.session_get returns not_found for a cross-scope session', async () => {
    // Create the project directly on the shared DB (single better-sqlite3
    // connection) so the path-scoped connection resolves ctx.project to it.
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
    projects.create({ slug: 'getsession-proj' });

    // Start a session INSIDE the project (path-scoped → project scope).
    const pinned = await connect({ projectSlug: 'getsession-proj' });
    const started = (await pinned.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'project-scoped session' },
    })) as ToolResult;
    const startedPayload = readJson(started) as { sessionId: string; scope: string };
    const { sessionId } = startedPayload;
    // Guard: confirm the session really is project-scoped (not global).
    expect(startedPayload.scope).toBe('project');
    await pinned.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: lives in a project.' },
    });
    // In-scope session_get finds it.
    const inScope = (await pinned.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(inScope.isError).toBeFalsy();
    await pinned.callTool({ name: 'memory.session_end', arguments: {} });
    await pinned.close();

    // Fetch from global scope → the project session is out of scope.
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

    // Soft-delete the row directly (operator action; no agent-facing tool).
    server.dbHandle.db
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

  // `status` and `ended_at` are one fact read from two columns: a reader may
  // rely on `ended_at IS NOT NULL` iff `status <> 'active'`, before and after a
  // resume alike. `memory.timeline` reports neither, so what it must not break
  // is the session thread the pair belongs to.
  it('a resumed session reads back as active with no endedAt, and its memory timeline stays one thread', async () => {
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
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

    // Control: the pair moves together, so it must read `ended` + a timestamp
    // here for the post-resume read to be evidence of anything.
    const closed = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    const closedPayload = readJson(closed) as { status: string; endedAt: string | null };
    expect(closedPayload.status).toBe('ended');
    expect(closedPayload.endedAt).toEqual(expect.any(String));

    // Saved while nothing is bound: `memory.session_end` cleared the transport
    // binding, so this one belongs to no session — the control that the thread
    // below is keyed on the session and not on recency. `fallback` is how the
    // wire reports that, since no read surface publishes a memory's session id.
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

    // The neighbours of a session-attached pivot are queried by that session's
    // id, so the post-resume save appearing here — carrying `<S>` — is the two
    // stints reading as one thread, with the orphan excluded.
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

    // The prior row should now be superseded; memory.get on it reflects that.
    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: firstPayload.id },
    })) as ToolResult;
    const gotPayload = readJson(got) as { memory: { status: string } };
    expect(gotPayload.memory.status).toBe('superseded');

    // include_relations co-surfaces the successor as an `expanded` entry.
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

    // Without include_relations, the response carries no `expanded` field.
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
    // Plant two rows with overlapping content so the third save has
    // strong FTS5 BM25 scores.
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
    // Save a near-duplicate.
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
    // The harness embedder is always warm, so the identical-content match
    // arrives through the vec pass (embedNow gives the new row its vector
    // before detection; vec wins ties over fts).
    expect(payload.candidates[0]!.source).toBe('vec');

    // Close the pending judgment via memory.judge.
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
    // `open` had one reachable value: the report cannot be produced without a
    // database read, so its `false` was never observable.
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
    // The llm block was removed by `remove-llm-consolidation`.
    expect('llm' in payload).toBe(false);
    expect(payload.embeddings.model).toContain('gte-multilingual-base');
    expect('enabled' in payload.embeddings).toBe(false);
    expect(typeof payload.review.needsReview).toBe('number');
    expect(typeof payload.review.pendingJudgments).toBe('number');
    // Neither had a runtime assertion. A rename consistent across the
    // interface, the zod schema and the producing closure yields a payload
    // that passes output validation, so the SDK does not catch it either —
    // only a read of the field does.
    expect(typeof payload.sessions.active).toBe('number');
    expect(typeof payload.entities.backlog).toBe('number');
    expect(Array.isArray(payload.warnings)).toBe(true);
    await client.close();
  });

  // memory.archive journals a `maintenance` run whose summary carries a `kind`
  // string next to the counters, so a doctor output contract that admits only
  // numbers makes the tool fail from the first archive onwards.
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
    // Server side: the row is present and the timeline tool falls back to
    // the time-window mode since session_id is null.
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
    // Memory not found surfaces as a non-OK MCP tool error with a known code.
    expect(result.isError).toBe(true);
    const payload = readJson(result) as { code?: string };
    expect(payload.code).toBe('not_found');
    await client.close();
  });
  // NOTE: runs after the candidates[] test — the FTS similarity proxy
  // (1/(1+|bm25|)) is corpus-size sensitive, so saves made here would
  // shift BM25 IDF for earlier saves. Recalibrated in change B.
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

    // Aged pending (2 days > JUDGMENT_ORPHAN_AFTER_MS default 24h) and a
    // fresh one; only the aged row may surface.
    const insert = server.dbHandle.raw.prepare(
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
    // The fresh row is hidden from the list but counted — that gap is the whole
    // point of the total. Bounded loosely because earlier saves in this shared
    // server may have left their own pendings behind.
    expect(payload.pendingJudgmentsTotal).toBeGreaterThanOrEqual(2);

    // Asking for a size lifts the age filter, so the fresh row becomes
    // judgeable instead of waiting out JUDGMENT_ORPHAN_AFTER_MS.
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

    // Age it past the `project` shelf life (3 months) via created_at.
    server.dbHandle.raw
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
    // Unary needsReview is disjoint from pairwise pendingJudgments.
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
    // Two fresh, never-before-used project slugs: the shared global scope
    // accumulates state across every `it()` in this file, so isolation can
    // only be asserted against scopes nothing else has touched.
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

    server.dbHandle.raw
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

    // A different, untouched project scope sees neither the pending relation
    // nor any review debt.
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
    // Two never-before-used slugs: the shared server accumulates rows across
    // every `it()` in this file, so an exact count is only assertable in a
    // scope nothing else has written to.
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
      // A missing entry makes every count assertion below vacuous.
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
    // Non-zero before the archive: without this the post-archive `0` below
    // would also pass on an empty corpus.
    expect(entryFor(before, P).activeMemoryCount).toBe(1);
    expect(entryFor(before, Q).activeMemoryCount).toBe(2);
    // The old key must be gone from every entry, not merely absent on P.
    for (const entry of before) expect('memoryCount' in entry).toBe(false);

    const archived = (await pClient.callTool({
      name: 'memory.archive',
      arguments: { id: pMemoryId },
    })) as ToolResult;
    expect(archived.isError, 'memory.archive').toBeFalsy();

    const after = await listProjects();
    expect(entryFor(after, P).activeMemoryCount).toBe(0);
    // Control: the archive in P moves no number in Q.
    expect(entryFor(after, Q).activeMemoryCount).toBe(2);

    // A row written on a path-less connection lands in the default project, so
    // it must move neither P's nor Q's number.
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

    // P now holds one active and one archived row, so the status filter is
    // observable: the count must equal what the same scope reports as active
    // and must be strictly below P's total row count.
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

  // Regression coverage for enforce-mcp-authorization: every scope-sensitive
  // tool (not just save/search/get/confirm) now shares the async,
  // roots-discovery-aware resolver, so the FIRST call on a fresh transport
  // sees the same project scope a later call would.
  //
  // This is the WARM arm: ~90 prior connections to this server precede it, and
  // it runs with retries disabled (mcp-api spec — a retried test asserts only
  // that one attempt of several passed).
  it('memory.context as the FIRST call on an unscoped connection with a discoverable root returns project scope', async () => {
    const repos = createRepositories(server.dbHandle.db);
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

  // Premise changed: an unminted roots suggestion no longer blocks the write —
  // the connection has a project (the default one), so the gate that refused a
  // scopeless write has no state left to fire in. `project.current` still
  // surfaces the suggestion, so the agent can move the row with `project.use`.
  it('memory.capture_passive writes to the default project when roots surface an unminted slug', async () => {
    const dflt = defaultProject(server.dbHandle);
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

// Real-server coverage for the auth-surface hardening (change
// `harden-auth-surface`): 413 body bound, opt-in DNS-rebinding Origin
// rejection, Secure cookie on HTTPS, and the uniform login response.
//
// Kept in THIS file (not a standalone one) on purpose: it bootstraps a second
// real server, and two heavy server files running in parallel starve the MCP
// roots-discovery SSE round-trip above. Separate describes in one file run
// sequentially, so this server never coexists with the one above.
describe('HTTP hardening (real server)', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'hardening-admin-token-with-enough-entropy-yy';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
        // HTTPS issuer → Secure cookies + OAuth enabled.
        REMBRIC_PUBLIC_URL: 'https://rembric.example.com',
        // Smallest allowed body cap (64 KiB) so an oversized POST is cheap.
        MAX_BODY_BYTES: String(64 * 1024),
        // Opt-in DNS-rebinding: allow the loopback host + one origin.
        REMBRIC_MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        REMBRIC_MCP_ALLOWED_ORIGINS: 'https://good.example',
      },
      { embedder: new FakeEmbedder() },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.shutdown();
  });

  function rawPost(path: string, headers: Record<string, string>): Promise<number> {
    const u = new URL(baseUrl + path);
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname,
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('rejects an oversized /mcp body with 413 (after auth, before buffering it all)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: 'x'.repeat(70_000),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('payload_too_large');
  });

  it('rejects a disallowed Origin on /mcp (DNS-rebinding protection)', async () => {
    // `fetch` forbids setting Origin/Host, so use a raw HTTP request.
    const status = await rawPost('/mcp', {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://evil.example',
    });
    expect(status).toBe(403);
  });

  it('sets Secure on the session cookie for an HTTPS deployment', async () => {
    const res = await fetch(`${baseUrl}/dashboard/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rembric_session=');
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('returns an identical 401 for a valid-non-admin vs an invalid login token', async () => {
    // Mint a real, valid, non-admin token on the server's own connection.
    const tokensSvc = new TokensService(createRepositories(server.dbHandle.db), server.dbHandle.db);
    const nonAdmin = tokensSvc.create({ name: 'ro-login', scope: 'read:*' });

    async function login(token: string): Promise<{ status: number; text: string }> {
      const res = await fetch(`${baseUrl}/dashboard/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
        redirect: 'manual',
      });
      return { status: res.status, text: await res.text() };
    }

    const validNonAdmin = await login(nonAdmin.plaintext);
    const invalid = await login('definitely-not-a-real-token-value');
    expect(validNonAdmin.status).toBe(401);
    expect(invalid.status).toBe(401);
    // No validity oracle: the two responses are byte-identical.
    expect(validNonAdmin.text).toBe(invalid.text);
  });

  it('refuses an unknown mcp-session-id with 404/-32001 before constructing anything', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'no-such-session-id',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });

  it('control: a live mcp-session-id from a real initialize is unaffected', async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const list = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(list.status).toBe(200);
  });
});

/**
 * The cap lives twice — as the assertion above and as the mcp-api requirement
 * that publishes it — and nothing couples them. Either location counts, so this
 * holds before and after the delta is merged at archive time.
 */
describe('the enforced description cap is published in mcp-api', () => {
  it(`states ${DESCRIPTION_MAX_LENGTH} in the live spec or a pending delta`, () => {
    const openspecDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'openspec',
    );
    const changesDir = join(openspecDir, 'changes');
    const candidates = [join(openspecDir, 'specs', 'mcp-api', 'spec.md')];
    for (const entry of readdirSync(changesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'archive') {
        candidates.push(join(changesDir, entry.name, 'specs', 'mcp-api', 'spec.md'));
      }
    }

    // The constant NAME and the value on one line. A bare digit search was
    // satisfied by 22 numbers already in these files — including 2048 and 1000,
    // so bumping the cap to the ceiling passed green — and by a stray `1900` in
    // unrelated prose after the requirement was deleted. The separator is
    // optional because the sibling documents write `1,900`.
    const digits = String(DESCRIPTION_MAX_LENGTH);
    const withSeparator =
      digits.length > 3 ? `${digits.slice(0, -3)},?${digits.slice(-3)}` : digits;
    const pattern = new RegExp(`DESCRIPTION_MAX_LENGTH[^\\n]*?\\b${withSeparator}\\b`);
    const published = candidates
      .filter((p) => existsSync(p))
      .some((p) => pattern.test(readFileSync(p, 'utf8')));

    expect(
      published,
      `no mcp-api requirement names DESCRIPTION_MAX_LENGTH with the value ${DESCRIPTION_MAX_LENGTH}`,
    ).toBe(true);
  });
});

/**
 * Routing-level coverage for roots discovery, on its own server so the first
 * arm below is the first traffic that server has served.
 *
 * A test that asserts only the resolved scope passes whenever the underlying
 * arrival race is won, so it cannot guard the routing. The arms here assert the
 * routing property itself (mcp-api spec): discovery completes while the
 * client's optional standalone server→client stream is absent.
 *
 * Retries stay disabled here and on the warm arm above, per the same spec: a
 * retried test asserts only that one attempt of several passed.
 */
describe('roots discovery routing (real server)', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'roots-routing-admin-token-with-enough-entropy';
  /** Every HTTP request the server received, in arrival order. */
  const httpLog: string[] = [];

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder() },
    );
    server.http.server.on('request', (req) => httpLog.push(`${req.method} ${req.url}`));
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.shutdown();
  });

  function createProject(slug: string): { id: string; slug: string } {
    return new ProjectsService(createRepositories(server.dbHandle.db)).create({ slug });
  }

  interface RootsConnection {
    client: Client;
    clientMethods: string[];
    rootsCalls: () => number;
    /** Change what the client's `roots/list` handler answers; `null` = empty list. */
    setRoot: (uri: string | null) => void;
  }

  async function connectRoots(opts: {
    rootUri: string;
    advertiseRoots?: boolean;
    listChanged?: boolean;
    suppressStandaloneStream?: boolean;
    dropFirstRootsList?: boolean;
    /** Answer this many `roots/list` requests, then go silent forever. */
    answerLimit?: number;
  }): Promise<RootsConnection> {
    const clientMethods: string[] = [];
    const guardedFetch: FetchLike = (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      clientMethods.push(method);
      if (opts.suppressStandaloneStream === true && method === 'GET') {
        // 405 is the SDK's "this server offers no GET stream" path, taken
        // without raising: the server never sees the GET, so it never registers
        // the standalone server→client stream.
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      return fetch(url, init);
    };
    const advertiseRoots = opts.advertiseRoots !== false;
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      fetch: guardedFetch,
      requestInit: { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    });
    const roots = opts.listChanged === true ? { listChanged: true } : {};
    const client = new Client(
      { name: 'roots-routing-client', version: '0.0.0' },
      { capabilities: advertiseRoots ? { roots } : {} },
    );
    let calls = 0;
    let rootUri: string | null = opts.rootUri;
    if (advertiseRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        calls += 1;
        const silentFrom = opts.answerLimit;
        if (
          (opts.dropFirstRootsList === true && calls === 1) ||
          (silentFrom !== undefined && calls > silentFrom)
        ) {
          // No answer of ANY kind, so the server's own budget expires. A
          // rejection would instead be an answer, which legitimately consumes
          // the once-only discovery slot.
          await new Promise(() => {});
        }
        return rootUri === null ? { roots: [] } : { roots: [{ uri: rootUri, name: rootUri }] };
      });
    }
    await client.connect(transport);
    return {
      client,
      clientMethods,
      rootsCalls: () => calls,
      setRoot: (uri) => {
        rootUri = uri;
      },
    };
  }

  async function contextScope(client: Client): Promise<string> {
    const result = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return (readJson(result) as { scope: string }).scope;
  }

  interface CurrentProject {
    slug: string | null;
    projectId: string | null;
    source: string;
    suggestedSlugs: string[];
  }

  async function projectCurrent(client: Client): Promise<CurrentProject> {
    const result = (await client.callTool({
      name: 'project.current',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return readJson(result) as CurrentProject;
  }

  /** End-to-end tool-call latency at the SDK client — the only instrument used below. */
  async function timedScope(client: Client): Promise<{ scope: string; ms: number }> {
    const started = performance.now();
    const scope = await contextScope(client);
    return { scope, ms: performance.now() - started };
  }

  // Cold arm — the control. Must be the first test in this describe: it is the
  // first traffic this server has served. It passes on both sides of the
  // routing fix, so a harness that never reaches the discovery path at all is
  // distinguishable from a correct one.
  it('resolves the discovered project on the first connection a server serves', async () => {
    const project = createProject('routing-cold-arm');
    const { client } = await connectRoots({ rootUri: `file:///tmp/${project.slug}` });
    expect(await contextScope(client)).toBe(`project:${project.id}`);
    await client.close();
  });

  it('completes discovery while the client never opens the standalone stream', async () => {
    const project = createProject('routing-no-standalone');
    const from = httpLog.length;
    const { client, clientMethods } = await connectRoots({
      rootUri: `file:///tmp/${project.slug}`,
      suppressStandaloneStream: true,
    });
    const scope = await contextScope(client);
    const mine = httpLog.slice(from);

    expect(clientMethods, 'the client did attempt the standalone GET').toContain('GET');
    expect(mine.filter((line) => line.startsWith('GET /mcp'))).toEqual([]);
    // The instrument is live: this connection's POSTs did reach the server.
    expect(mine.some((line) => line.startsWith('POST /mcp'))).toBe(true);
    expect(scope).toBe(`project:${project.id}`);

    await client.close();
  });

  it('retries discovery on the next tool call when the first roots/list got no answer', async () => {
    const dflt = defaultProject(server.dbHandle);
    const project = createProject('routing-unanswered-first');
    const { client, rootsCalls } = await connectRoots({
      rootUri: `file:///tmp/${project.slug}`,
      dropFirstRootsList: true,
    });

    expect(await contextScope(client)).toBe(`project:${dflt.id}`);
    expect(rootsCalls()).toBe(1);

    expect(await contextScope(client)).toBe(`project:${project.id}`);
    expect(rootsCalls()).toBe(2);

    const current = readJson(
      (await client.callTool({ name: 'project.current', arguments: {} })) as ToolResult,
    ) as { projectId: string | null };
    expect(current.projectId).toBe(project.id);

    await client.close();
  });

  // Control: without it, "the discovered project" above could be the default
  // project under another name.
  it('resolves the default project when the client advertises no roots capability', async () => {
    const dflt = defaultProject(server.dbHandle);
    const project = createProject('routing-not-discovered');
    const { client, rootsCalls } = await connectRoots({
      rootUri: `file:///tmp/${project.slug}`,
      advertiseRoots: false,
    });
    expect(await contextScope(client)).toBe(`project:${dflt.id}`);
    expect(rootsCalls()).toBe(0);
    await client.close();
  });

  /**
   * `notifications/roots/list_changed`. The notification's POST is answered 202
   * only after the server transport has dispatched it, so no arm below needs to
   * wait for the flag to land.
   */
  describe('roots/list_changed lifecycle', () => {
    // Control for every arm below: it passes on both sides of the change, so a
    // harness that never reaches the discovery path is distinguishable from a
    // correct one.
    it('asks once and suggests nothing across three scope-resolving calls', async () => {
      const project = createProject('probe-control');
      const { client, rootsCalls } = await connectRoots({
        rootUri: `file:///tmp/${project.slug}`,
        listChanged: true,
      });
      for (let i = 0; i < 3; i += 1) {
        expect(await contextScope(client)).toBe(`project:${project.id}`);
      }
      expect(rootsCalls()).toBe(1);
      expect(await projectCurrent(client)).toMatchObject({
        projectId: project.id,
        source: 'roots',
        suggestedSlugs: [],
      });
      await client.close();
    });

    it('leaves an unrelated transport untouched when another one emits list_changed', async () => {
      const pa = createProject('probe-d2-a');
      const pb = createProject('probe-d2-b');
      const a = await connectRoots({ rootUri: `file:///tmp/${pa.slug}`, listChanged: true });
      const b = await connectRoots({ rootUri: `file:///tmp/${pb.slug}`, listChanged: true });
      expect(await contextScope(a.client)).toBe(`project:${pa.id}`);
      expect(await contextScope(b.client)).toBe(`project:${pb.id}`);
      const before = await projectCurrent(b.client);
      expect(before).toMatchObject({ projectId: pb.id, source: 'roots', suggestedSlugs: [] });
      expect(b.rootsCalls()).toBe(1);

      await a.client.sendRootsListChanged();

      expect(await contextScope(b.client)).toBe(`project:${pb.id}`);
      expect(b.rootsCalls(), 'B was re-asked because A changed folders').toBe(1);
      expect(await projectCurrent(b.client)).toEqual(before);

      await a.client.close();
      await b.client.close();
    });

    it('refreshes the emitting transport suggestions without switching its project', async () => {
      const oldProject = createProject('probe-d1-old');
      const newProject = createProject('probe-d1-new');
      const a = await connectRoots({
        rootUri: `file:///tmp/${oldProject.slug}`,
        listChanged: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${oldProject.id}`);
      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual([]);

      a.setRoot(`file:///tmp/${newProject.slug}`);
      await a.client.sendRootsListChanged();

      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: oldProject.id,
        source: 'roots',
        suggestedSlugs: [newProject.slug],
      });
      expect(a.rootsCalls()).toBe(2);
      await a.client.close();
    });

    it('spends one roots/list budget in total for a list_changed the client never answers', async () => {
      const project = createProject('probe-gone-quiet');
      const a = await connectRoots({
        rootUri: `file:///tmp/${project.slug}`,
        listChanged: true,
        answerLimit: 1,
      });
      expect(await contextScope(a.client)).toBe(`project:${project.id}`);
      const warm = await timedScope(a.client);
      expect(warm.scope).toBe(`project:${project.id}`);
      expect(warm.ms, 'warm baseline must not touch the budget').toBeLessThan(500);
      expect(a.rootsCalls()).toBe(1);

      await a.client.sendRootsListChanged();

      // The first call after the notification may spend one budget — the
      // accepted cost of one attempt per notification.
      const first = await timedScope(a.client);
      const second = await timedScope(a.client);
      expect(first.scope).toBe(`project:${project.id}`);
      expect(second.scope).toBe(`project:${project.id}`);
      expect(
        second.ms,
        `warm ${warm.ms.toFixed(0)}ms, first-after ${first.ms.toFixed(0)}ms, ` +
          `roots/list count ${a.rootsCalls()}`,
      ).toBeLessThan(500);
      expect(a.rootsCalls()).toBe(2);
      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: project.id,
        source: 'roots',
      });
      await a.client.close();
    }, 30_000);

    it('suggests an existing project on refresh without activating it', async () => {
      const dflt = defaultProject(server.dbHandle);
      const target = createProject('probe-refresh-target');
      const a = await connectRoots({
        rootUri: 'file:///tmp/probe-refresh-unknown',
        listChanged: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${dflt.id}`);
      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: dflt.id,
        source: 'default',
        suggestedSlugs: ['probe-refresh-unknown'],
      });

      a.setRoot(`file:///tmp/${target.slug}`);
      await a.client.sendRootsListChanged();

      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: dflt.id,
        source: 'default',
        suggestedSlugs: [target.slug],
      });
      expect(a.rootsCalls()).toBe(2);
      await a.client.close();
    });

    it('clears a stale suggestion when the refreshed roots are empty', async () => {
      const a = await connectRoots({ rootUri: 'file:///tmp/probe-stale-empty', listChanged: true });
      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual(['probe-stale-empty']);

      a.setRoot(null);
      await a.client.sendRootsListChanged();

      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual([]);
      await a.client.close();
    });

    it('clears a stale suggestion when no slug can be derived from the refreshed roots', async () => {
      const a = await connectRoots({ rootUri: 'file:///tmp/probe-stale-bad', listChanged: true });
      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual(['probe-stale-bad']);

      a.setRoot('file:///');
      await a.client.sendRootsListChanged();

      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual([]);
      await a.client.close();
    });

    it('runs ordinary discovery for a list_changed that precedes any answered discovery', async () => {
      const dflt = defaultProject(server.dbHandle);
      const project = createProject('probe-unanswered-then-changed');
      const a = await connectRoots({
        rootUri: `file:///tmp/${project.slug}`,
        listChanged: true,
        dropFirstRootsList: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${dflt.id}`);
      expect(a.rootsCalls()).toBe(1);

      await a.client.sendRootsListChanged();

      expect(await contextScope(a.client)).toBe(`project:${project.id}`);
      // One request for that tool call, not one for discovery and one for the refresh.
      expect(a.rootsCalls()).toBe(2);
      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: project.id,
        source: 'roots',
      });
      await a.client.close();
    }, 30_000);

    it('delivers the refreshing roots/list while the client never opens the standalone stream', async () => {
      const oldProject = createProject('probe-refresh-nostream-old');
      const newProject = createProject('probe-refresh-nostream-new');
      const from = httpLog.length;
      const a = await connectRoots({
        rootUri: `file:///tmp/${oldProject.slug}`,
        listChanged: true,
        suppressStandaloneStream: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${oldProject.id}`);

      a.setRoot(`file:///tmp/${newProject.slug}`);
      await a.client.sendRootsListChanged();
      const after = await projectCurrent(a.client);
      const mine = httpLog.slice(from);

      expect(a.clientMethods, 'the client did attempt the standalone GET').toContain('GET');
      expect(mine.filter((line) => line.startsWith('GET /mcp'))).toEqual([]);
      expect(mine.some((line) => line.startsWith('POST /mcp'))).toBe(true);
      expect(after).toMatchObject({
        projectId: oldProject.id,
        suggestedSlugs: [newProject.slug],
      });
      await a.client.close();
    });
  });
});
