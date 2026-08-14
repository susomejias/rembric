import { createServer as createHttpServer, type Server } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { McpTransportManager } from '../mcp/transport.js';
import { AgentSessionsService, TRANSPORT_STALENESS_MS } from '../services/agent-sessions.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';
import { findFreePort } from '../test/net.js';

import { SessionRouter } from './session-router.js';
import { runTransportStateReaperPass } from './transport-state-reaper.js';

/** Comfortably clears the window without needing the module under test to say so. */
const WELL_PAST_WINDOW = TRANSPORT_STALENESS_MS * 2;

async function rpc(
  baseUrl: string,
  method: string,
  sessionId?: string,
  params: Record<string, unknown> = {},
): Promise<string | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  await res.text();
  return res.headers.get('mcp-session-id');
}

async function deleteSession(baseUrl: string, sessionId: string): Promise<void> {
  await fetch(baseUrl, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
}

interface Harness {
  db: TestDb;
  tokenId: string;
  projectId: string;
  projects: ProjectsService;
  router: SessionRouter;
  mcpTransport: McpTransportManager;
  agentSessions: AgentSessionsService;
  nowBox: { current: Date };
  baseUrl: string;
  server: Server;
  connect: () => Promise<string>;
  bump: (sessionId: string) => Promise<void>;
  close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const db = createTestDb();
  const repos = createRepositories(db.handle.db);
  const nowBox = { current: new Date() };
  const agentSessions = new AgentSessionsService(repos, db.handle.db, () => nowBox.current);
  const tokens = new TokensService(repos, db.handle.db);
  const projects = new ProjectsService(repos);
  const router = new SessionRouter();
  const mcpTransport = new McpTransportManager(
    () => new McpServer({ name: 'reaper-test', version: '0.0.0' }),
  );

  const { token } = tokens.create({ name: 'reaper-test-token', scope: '*' });
  const projectId = projects.create({
    slug: `reaper-test-${Math.random().toString(36).slice(2)}`,
  }).id;

  const server = createHttpServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = await mcpTransport.getOrCreate(sessionId, { requestedSlug: null });
      await transport.handleRequest(req, res, body);
    })();
  });
  const port = await findFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    db,
    tokenId: token.id,
    projectId,
    projects,
    router,
    mcpTransport,
    agentSessions,
    nowBox,
    baseUrl,
    server,
    connect: async () => {
      const sessionId = await rpc(baseUrl, 'initialize', undefined, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'reaper-test-client', version: '0' },
      });
      if (!sessionId) throw new Error('initialize did not return a session id');
      await rpc(baseUrl, 'notifications/initialized', sessionId);
      return sessionId;
    },
    bump: async (sessionId: string) => {
      await rpc(baseUrl, 'tools/list', sessionId);
    },
    close: async () => {
      mcpTransport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.cleanup();
    },
  };
}

function futureNow(): () => Date {
  return () => new Date(Date.now() + WELL_PAST_WINDOW);
}

describe('transport-state reaper pass', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('evicts a transport stale on both clocks, and leaves a concurrently live one', async () => {
    // Distinct projects: condition (a) is keyed on (tokenId, projectId), not on the
    // transport itself, so the survivor's live row must sit on a DIFFERENT project
    // than the evicted one's — sharing a project would protect both.
    const otherProjectId = h.projects.create({
      slug: `reaper-other-${Math.random().toString(36).slice(2)}`,
    }).id;
    const staleId = await h.connect();
    h.router.setActiveProject(h.tokenId, staleId, otherProjectId, 'roots');

    const liveId = await h.connect();
    h.router.setActiveProject(h.tokenId, liveId, h.projectId, 'tool-explicit');
    h.agentSessions.ensure({
      id: 'live-session-one',
      tokenId: h.tokenId,
      projectId: h.projectId,
      agent: 'a',
    });

    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
      now: futureNow(),
    });

    expect(result.transportsEvicted).toBe(1);
    expect(h.mcpTransport.has(staleId)).toBe(false);
    expect(h.router.get(h.tokenId, staleId)).toBeUndefined();

    expect(h.mcpTransport.has(liveId)).toBe(true);
    expect(h.router.get(h.tokenId, liveId)?.projectId).toBe(h.projectId);
  });

  it('does not evict a quiet transport backed by a live session row (freshness driven through ensure())', async () => {
    const sessionId = await h.connect();
    h.router.setActiveProject(h.tokenId, sessionId, h.projectId, 'roots');
    // The real path a hook POST drives: ensure() inserts, a second call bumps
    // last_activity_at exactly as `POST /api/<slug>/sessions` does.
    h.agentSessions.ensure({
      id: 'live-session-two',
      tokenId: h.tokenId,
      projectId: h.projectId,
      agent: 'a',
    });
    h.agentSessions.ensure({
      id: 'live-session-two',
      tokenId: h.tokenId,
      projectId: h.projectId,
      agent: 'a',
    });

    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
      now: futureNow(),
    });

    expect(result.transportsEvicted).toBe(0);
    expect(result.routerEvicted).toBe(0);
    expect(h.mcpTransport.has(sessionId)).toBe(true);
    expect(h.router.get(h.tokenId, sessionId)).toBeDefined();
  });

  it('does not evict a busy transport with no session row at all', async () => {
    const sessionId = await h.connect();
    await h.bump(sessionId);

    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
    });

    expect(result.transportsEvicted).toBe(0);
    expect(h.mcpTransport.has(sessionId)).toBe(true);
  });

  it('evicts a router entry orphaned by a clean close, even well under the window', async () => {
    const sessionId = await h.connect();
    h.router.setActiveProject(h.tokenId, sessionId, h.projectId, 'roots');

    await deleteSession(h.baseUrl, sessionId);
    expect(h.mcpTransport.has(sessionId)).toBe(false);
    expect(h.router.get(h.tokenId, sessionId)).toBeDefined();

    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
    });

    expect(result.routerEvicted).toBe(1);
    expect(h.router.get(h.tokenId, sessionId)).toBeUndefined();
  });

  it('a pinned project survives every pass while its transport and session stay live', async () => {
    const sessionId = await h.connect();
    h.router.setActiveProject(h.tokenId, sessionId, h.projectId, 'tool-explicit');
    h.agentSessions.ensure({
      id: 'live-pin',
      tokenId: h.tokenId,
      projectId: h.projectId,
      agent: 'a',
    });

    for (let i = 0; i < 3; i++) {
      const result = runTransportStateReaperPass({
        router: h.router,
        mcpTransport: h.mcpTransport,
        agentSessions: h.agentSessions,
        now: futureNow(),
      });
      expect(result.transportsEvicted).toBe(0);
      expect(result.routerEvicted).toBe(0);
      const entry = h.router.get(h.tokenId, sessionId);
      expect(entry?.projectId).toBe(h.projectId);
      expect(entry?.projectResolutionSource).toBe('tool-explicit');
      expect(h.mcpTransport.has(sessionId)).toBe(true);
    }
  });

  it('a purged empty session leaves condition (a) false, so a busy transport in that state survives on condition (b) alone', async () => {
    const sessionId = await h.connect();
    h.router.setActiveProject(h.tokenId, sessionId, h.projectId, 'roots');
    h.agentSessions.ensure({
      id: 'purge-me',
      tokenId: h.tokenId,
      projectId: h.projectId,
      agent: 'a',
    });
    h.agentSessions.end('purge-me', { tokenId: h.tokenId });

    h.nowBox.current = new Date(h.nowBox.current.getTime() + WELL_PAST_WINDOW * 100);
    const purged = h.agentSessions.purgeEmpty({ adminBypass: true });
    expect(purged.deletedIds).toContain('purge-me');

    await h.bump(sessionId);
    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
    });

    expect(result.transportsEvicted).toBe(0);
    expect(h.mcpTransport.has(sessionId)).toBe(true);
  });

  it('reclaims stale state with no session start and no traffic — the tick called directly', async () => {
    const sessionId = await h.connect();

    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
      now: futureNow(),
    });

    expect(result.transportsEvicted).toBe(1);
    expect(h.mcpTransport.has(sessionId)).toBe(false);
  });

  it('leaves discoveryInFlight untouched, including for a transport the pass does evict', async () => {
    const sessionId = await h.connect();
    h.router.setActiveProject(h.tokenId, sessionId, h.projectId, 'roots');
    const promise = Promise.resolve('discovery-result');
    h.router.setDiscoveryPromise(h.tokenId, sessionId, promise);

    const result = runTransportStateReaperPass({
      router: h.router,
      mcpTransport: h.mcpTransport,
      agentSessions: h.agentSessions,
      now: futureNow(),
    });

    expect(result.transportsEvicted).toBe(1);
    expect(h.router.get(h.tokenId, sessionId)).toBeUndefined();
    expect(h.router.getDiscoveryPromise(h.tokenId, sessionId)).toBe(promise);

    h.router.clearDiscoveryPromise(h.tokenId, sessionId, promise);
    expect(h.router.getDiscoveryPromise(h.tokenId, sessionId)).toBeUndefined();
  });
});
