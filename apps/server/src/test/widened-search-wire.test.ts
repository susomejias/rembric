import { createServer as createNetServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import { type BootstrappedServer, createServer } from '../server/index.js';
import { extractEntities } from '../services/entities.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { projectScope } from '../services/scope.js';
import { TokensService } from '../services/tokens.js';

import { createTestDb } from './db.js';
import { defaultProject } from './default-project.js';
import { FakeEmbedder } from './embedder.js';

/**
 * `memory.search`'s cross-project argument, exercised through the MCP SDK
 * transport and never against a handler directly: a direct call bypasses the
 * tool's zod schema, so "the tool accepts X" measured that way is not a fact
 * about the tool.
 *
 * Every exclusion is paired with a control that must pass on the same
 * instrument — a corpus with rows in only one project would satisfy these
 * assertions with the widening deleted, the authorization filter deleted, and
 * the predicate inverted alike.
 */

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createNetServer();
    sock.unref();
    sock.on('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      if (!addr || typeof addr === 'string') {
        sock.close();
        reject(new Error('expected an AddressInfo'));
        return;
      }
      const { port } = addr;
      sock.close(() => resolve(port));
    });
  });
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface SearchPage {
  count: number;
  memories: Array<{ id: string; projectId: string | null; title: string }>;
  searchedProjects?: string[];
  widened?: boolean;
}

const ADMIN_TOKEN = 'widened-search-admin-token-with-entropy-zz';
/** One rare token every project's fixture row carries, so one query matches everywhere. */
const SHARED = 'chrysoprasewiden';

describe('memory.search across authorized projects, at the wire', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  let alpha: Project;
  let beta: Project;
  let gamma: Project;
  let dflt: { id: string; slug: string };
  let setToken: string;
  let pinnedToken: string;
  const rowIn = new Map<string, { id: string; title: string }>();

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
        REMBRIC_UPDATE_CHECK: 'off',
      },
      { embedder: new FakeEmbedder() },
    );
    baseUrl = `http://127.0.0.1:${port}`;

    const repos = createRepositories(server.dbHandle.db);
    const projects = new ProjectsService(repos);
    alpha = projects.create({ slug: 'alpha' });
    beta = projects.create({ slug: 'beta' });
    gamma = projects.create({ slug: 'gamma' });
    dflt = defaultProject(server.dbHandle);

    const memories = new MemoryService(repos, server.dbHandle.db);
    for (const p of [alpha, beta, gamma]) {
      const saved = memories.save(
        {
          type: 'project',
          title: `${p.slug} widening fixture`,
          content: `${SHARED} row belonging to ${p.slug}, addressed at src/${p.slug}.ts`,
        },
        projectScope(p.id),
      );
      // `MemoryService.save` does not link entities — the MCP handler does,
      // after candidate detection. Linking here rather than waiting on the
      // background scan keeps the entity branch deterministic.
      repos.entities.linkMemory(
        saved.id,
        p.id,
        extractEntities(saved.title, saved.content),
        saved.createdAt,
      );
      rowIn.set(p.slug, { id: saved.id, title: saved.title });
    }

    const tokens = new TokensService(repos, server.dbHandle.db);
    setToken = tokens.create({
      name: 'alpha+beta reader',
      projects: [alpha, beta],
      access: 'read',
    }).plaintext;
    pinnedToken = tokens.create({ name: 'alpha reader', project: alpha, access: 'read' }).plaintext;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function connect(opts: { token?: string; projectSlug?: string } = {}): Promise<Client> {
    const url = new URL(`${baseUrl}/mcp${opts.projectSlug ? `/${opts.projectSlug}` : ''}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${opts.token ?? ADMIN_TOKEN}` } },
    });
    const client = new Client({ name: 'widened-search-probe', version: '0.0.0' }, {});
    await client.connect(transport);
    return client;
  }

  function payload(result: ToolResult): Record<string, unknown> {
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(result.isError, `tool refused: ${text}`).toBeFalsy();
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** The refusal text, asserting the call WAS refused so a success cannot read as one. */
  function refusal(result: ToolResult): string {
    expect(result.isError, 'expected a refusal').toBe(true);
    return result.content.find((c) => c.type === 'text')?.text ?? '';
  }

  async function search(
    client: Client,
    args: Record<string, unknown>,
  ): Promise<SearchPage & { raw: ToolResult }> {
    const raw = (await client.callTool({
      name: 'memory.search',
      arguments: { query: SHARED, limit: 20, ...args },
    })) as ToolResult;
    return { ...(payload(raw) as unknown as SearchPage), raw };
  }

  const projectsOf = (page: SearchPage): string[] =>
    [...new Set(page.memories.map((m) => m.projectId ?? 'none'))].sort();

  it('a full-access token widens to every project it may read, and names them', async () => {
    const client = await connect({ projectSlug: alpha.slug });
    const narrow = await search(client, {});
    const wide = await search(client, { across_projects: true });
    await client.close();

    // Control: the narrow page is non-empty and closed, so the widened page
    // below is a widening rather than a search that suddenly started working.
    expect(narrow.count).toBeGreaterThan(0);
    expect(projectsOf(narrow)).toEqual([alpha.id]);
    expect(narrow).not.toHaveProperty('searchedProjects');
    expect(narrow).not.toHaveProperty('widened');

    expect(projectsOf(wide)).toEqual([alpha.id, beta.id, gamma.id].sort());
    expect(wide.searchedProjects).toEqual([dflt.slug, alpha.slug, beta.slug, gamma.slug]);
    expect(wide.widened).toBe(true);
    // The declared output schema admits both, so a conforming client sees them.
    expect(wide.raw.structuredContent).toMatchObject({ widened: true });
  });

  it('a set token widens to exactly its members, and the exclusion is authorization', async () => {
    const client = await connect({ token: setToken, projectSlug: alpha.slug });
    const wide = await search(client, { across_projects: true });
    await client.close();

    expect(wide.searchedProjects).toEqual([alpha.slug, beta.slug]);
    expect(wide.widened).toBe(true);
    expect(projectsOf(wide)).toEqual([alpha.id, beta.id].sort());

    // Control: gamma's row answers the same query for a token that may read it,
    // so its absence above is the authorization filter and not an empty project.
    const control = await connect({ projectSlug: gamma.slug });
    const fromGamma = await search(control, {});
    await control.close();
    expect(fromGamma.count).toBeGreaterThan(0);
    expect(projectsOf(fromGamma)).toEqual([gamma.id]);
  });

  it('a project-pinned token gets its narrow result and no widening claim', async () => {
    const client = await connect({ token: pinnedToken, projectSlug: alpha.slug });
    const narrow = await search(client, {});
    const wide = await search(client, { across_projects: true });
    await client.close();

    expect(narrow.count).toBeGreaterThan(0);
    expect(wide.memories.map((m) => m.id)).toEqual(narrow.memories.map((m) => m.id));
    expect(wide.searchedProjects).toEqual([alpha.slug]);
    expect(wide).not.toHaveProperty('widened');
  });

  it('a path-less connection widens from the project it resolved to', async () => {
    const client = await connect();
    const narrow = await search(client, {});
    const wide = await search(client, { across_projects: true });
    await client.close();

    // The default project holds no fixture row, so the narrow page is empty by
    // construction — asserted, because an empty page is also what a broken
    // search returns.
    expect(narrow.count).toBe(0);
    expect(wide.searchedProjects).toEqual([dflt.slug, alpha.slug, beta.slug, gamma.slug]);
    expect(projectsOf(wide)).toEqual([alpha.id, beta.id, gamma.id].sort());
  });

  it('the entity branch widens under the same argument', async () => {
    const client = await connect({ token: setToken, projectSlug: alpha.slug });
    const narrow = (await client.callTool({
      name: 'memory.search',
      arguments: { entity: `src/${beta.slug}.ts` },
    })) as ToolResult;
    const wide = (await client.callTool({
      name: 'memory.search',
      arguments: { entity: `src/${beta.slug}.ts`, across_projects: true },
    })) as ToolResult;
    await client.close();

    const narrowPage = payload(narrow) as unknown as SearchPage;
    const widePage = payload(wide) as unknown as SearchPage;
    expect(narrowPage.count).toBe(0);
    expect(widePage.memories.map((m) => m.id)).toEqual([rowIn.get(beta.slug)!.id]);
    expect(widePage.searchedProjects).toEqual([alpha.slug, beta.slug]);
  });

  it('the widened set agrees with project.list', async () => {
    const client = await connect({ token: setToken, projectSlug: alpha.slug });
    const listed = payload(
      (await client.callTool({ name: 'project.list', arguments: {} })) as ToolResult,
    ) as { projects: Array<{ slug: string; archived?: boolean }> };
    const wide = await search(client, { across_projects: true });
    await client.close();

    const visible = listed.projects.filter((p) => !p.archived).map((p) => p.slug);
    expect(visible.length).toBeGreaterThan(1);
    expect([...(wide.searchedProjects ?? [])].sort()).toEqual([...visible].sort());
  });

  it('an older spelling of the argument is refused, not ignored', async () => {
    const client = await connect({ projectSlug: alpha.slug });
    const rejected = (await client.callTool({
      name: 'memory.search',
      arguments: { query: SHARED, all_projects: true },
    })) as ToolResult;
    const message = refusal(rejected);
    // Control: the accepted spelling on the same connection and query, so the
    // refusal is the unknown key rather than a broken search.
    const accepted = await search(client, { across_projects: true });
    await client.close();

    expect(message).toContain('-32602');
    expect(message).toContain('memory.search');
    expect(message).toContain('all_projects');
    expect(message).toMatch(/unrecognized_keys/);
    expect(accepted.widened).toBe(true);
  });

  it('no other tool takes the argument', async () => {
    const client = await connect({ projectSlug: alpha.slug });
    const contextRefused = refusal(
      (await client.callTool({
        name: 'memory.context',
        arguments: { across_projects: true },
      })) as ToolResult,
    );
    const getRefused = refusal(
      (await client.callTool({
        name: 'memory.get',
        arguments: { id: rowIn.get(alpha.slug)!.id, across_projects: true },
      })) as ToolResult,
    );
    // Controls: both calls succeed once the argument is dropped.
    const context = payload(
      (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult,
    );
    const got = payload(
      (await client.callTool({
        name: 'memory.get',
        arguments: { id: rowIn.get(alpha.slug)!.id },
      })) as ToolResult,
    ) as { memory: { id: string } };
    await client.close();

    for (const message of [contextRefused, getRefused]) {
      expect(message).toContain('-32602');
      expect(message).toContain('across_projects');
      expect(message).toMatch(/unrecognized_keys/);
    }
    expect(context).toHaveProperty('recentMemories');
    expect(got.memory.id).toBe(rowIn.get(alpha.slug)!.id);
  });

  it('a widened search does not open memory.get on the rows it returned', async () => {
    const client = await connect({ projectSlug: alpha.slug });
    const wide = await search(client, { across_projects: true });
    const foreign = wide.memories.find((m) => m.projectId === beta.id);
    expect(foreign, 'the widened page carried no foreign row to probe with').toBeDefined();

    const refused = refusal(
      (await client.callTool({
        name: 'memory.get',
        arguments: { id: foreign!.id },
      })) as ToolResult,
    );
    // Control: a home row from the SAME page is retrievable, so the refusal is
    // the project boundary and not a broken id or a broken get.
    const home = wide.memories.find((m) => m.projectId === alpha.id);
    const got = payload(
      (await client.callTool({ name: 'memory.get', arguments: { id: home!.id } })) as ToolResult,
    ) as { memory: { id: string } };
    await client.close();

    expect(refused).toContain('not_found');
    expect(refused).not.toContain(rowIn.get(beta.slug)!.title);
    expect(got.memory.id).toBe(home!.id);
  });

  it('a widened search does not move where the next save lands', async () => {
    const client = await connect({ projectSlug: alpha.slug });
    const wide = await search(client, { across_projects: true });
    expect(wide.widened).toBe(true);
    const saved = payload(
      (await client.callTool({
        name: 'memory.save',
        arguments: {
          type: 'project',
          title: 'saved after a widened search',
          content: 'widenedsaveprobe landed here',
        },
      })) as ToolResult,
    ) as { id: string };
    await client.close();

    const row = new MemoryService(
      createRepositories(server.dbHandle.db),
      server.dbHandle.db,
    ).unsafeGetById(saved.id);
    expect(row?.projectId).toBe(alpha.id);
  });

  it('the restraint guard reaches a client that reads only the top-level description', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    const search = tools.find((t) => t.name === 'memory.search');
    expect(search, 'memory.search missing from tools/list').toBeDefined();
    const description = search?.description ?? '';
    const properties = (search?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;

    // The argument is published, and its own describe() is a SEPARATE string —
    // so the assertions below are about the text a client that surfaces no
    // per-argument description still delivers to the model.
    expect(Object.keys(properties)).toContain('across_projects');
    expect(properties.across_projects?.description ?? '').not.toBe('');
    expect(description).not.toContain(properties.across_projects?.description ?? ' ');

    expect(description).toContain('across_projects');
    expect(description).toMatch(/never a default/i);
    expect(description).toMatch(/explicit ask/i);
    expect(description).toContain('searchedProjects');
    // The four clauses `mcp-api` mandates, which no reclaim may have taken.
    expect(description).toMatch(/Call this whenever/);
    expect(description).toMatch(/hybrid semantic \+ keyword/);
    expect(description).toContain('`limit`');
    expect(description).toContain('`offset`');
    expect(description).toContain('gateShortened');
  });

  it('the argument does not rescue a call the resolved scope refuses', async () => {
    const client = await connect({ token: pinnedToken });
    const plain = refusal(
      (await client.callTool({
        name: 'memory.search',
        arguments: { query: SHARED },
      })) as ToolResult,
    );
    const widened = refusal(
      (await client.callTool({
        name: 'memory.search',
        arguments: { query: SHARED, across_projects: true },
      })) as ToolResult,
    );
    await client.close();

    // A path-less connection resolves to the default project, which this token
    // does not hold. Control: the same token DOES search alpha at alpha's slug,
    // so the refusal is the resolved scope and not a dead credential.
    for (const message of [plain, widened]) expect(message).toContain('forbidden');
    const atAlpha = await connect({ token: pinnedToken, projectSlug: alpha.slug });
    const page = await search(atAlpha, {});
    await atAlpha.close();
    expect(page.count).toBeGreaterThan(0);
  });

  it('a widening that cannot resolve still names the project it read', async () => {
    const repos = createRepositories(server.dbHandle.db);
    const projects = new ProjectsService(repos);
    const delta = projects.create({ slug: 'delta' });
    new MemoryService(repos, server.dbHandle.db).save(
      { type: 'project', title: 'delta widening fixture', content: `${SHARED} row in delta` },
      projectScope(delta.id),
    );

    const client = await connect();
    payload(
      (await client.callTool({ name: 'project.use', arguments: { slug: 'delta' } })) as ToolResult,
    );
    const live = await search(client, { across_projects: true });
    // Archiving after the pin: `project.use` is refused at an archived slug, but
    // a connection already pinned keeps resolving there, and the widened set
    // excludes archived projects — so the home drops out of its own reach.
    projects.archive(delta.id);
    const stranded = await search(client, { across_projects: true });
    await client.close();

    expect(live.widened).toBe(true);
    expect(live.searchedProjects).toContain(delta.slug);
    expect(stranded.searchedProjects).toEqual([delta.slug]);
    expect(stranded).not.toHaveProperty('widened');
    // Non-vacuity: the fallback served delta's own rows rather than nothing.
    expect(stranded.count).toBeGreaterThan(0);
    expect(projectsOf(stranded)).toEqual([delta.id]);
  });

  it('no tool publishes a property named scope', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.length).toBeGreaterThanOrEqual(23);
    let checked = 0;
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      for (const property of Object.keys(schema.properties ?? {})) {
        checked += 1;
        expect(property, `${tool.name} property name`).not.toBe('scope');
      }
    }
    // Non-vacuity: the loop ran over real properties rather than empty schemas.
    expect(checked).toBeGreaterThan(20);
  });
});
