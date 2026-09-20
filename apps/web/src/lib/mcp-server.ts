import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpRequestContext,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  EMBEDDING_MODEL_ID,
  PromptsService,
  RelationsService,
  SessionRouter,
  entityIndexResetWarning,
  reviewTtlEntries,
  vectorIndexResetWarning,
} from '@rembric/core';
import { createDiagnostics } from '@rembric/db';
import { createMcpServer, parseRunSummary, type DoctorReport } from '@rembric/mcp';

import { getServices, type Services } from './services';
import { REMBRIC_VERSION } from './version';

/**
 * The MCP HTTP surface: `apps/server/src/server/{http.ts::handleMcpRequest,
 * bootstrap.ts}'s McpServer factory and mcp/transport.ts's session manager,
 * re-expressed on MCP SDK v2 (`@modelcontextprotocol/server@2.0.0`) instead of
 * the v1 `StreamableHTTPServerTransport` over raw `IncomingMessage` /
 * `ServerResponse`.
 *
 * ## What is v2's and what is ours
 *
 * `createMcpHandler` is the v2 entry and it mandates a per-request
 * `McpServerFactory`. It serves the modern (2026-07-28) protocol era natively
 * and offers exactly two postures for 2025-era traffic: `'stateless'` (a fresh
 * stateless transport per POST, with GET and DELETE answered `405`) or
 * `'reject'`. Neither is the shape this server has today, and going stateless
 * would silently break the connection-scoped half of the scope contract:
 * `SessionRouter` is keyed on `mcp-session-id` (`packages/mcp/src/_shared.ts`
 * `routerKey`), so with no session id `project.use` would return
 * `switched:false` while pinning nothing, and roots discovery would never run.
 *
 * So 2025-era traffic keeps a sessionful streamable-HTTP leg of our own, which
 * is the composition v2's own documentation prescribes for exactly this
 * situation ("to keep an existing legacy deployment — for example a sessionful
 * streamable HTTP wiring — serving 2025 traffic next to this entry, route in
 * user land with `isLegacyRequest` in front of a `legacy: 'reject'` handler").
 * Both legs share ONE factory, so the 20 tools cannot drift between eras.
 *
 * ## The v1 server through the v2 transport
 *
 * `packages/mcp`'s `createMcpServer` builds an SDK 1.x `McpServer`, while v2's
 * factory type asks for a v2 `McpServer`/`Server`. The two classes are
 * *nominally* incompatible (each declares private fields, so TypeScript refuses
 * structural assignability) but *wire-compatible*: both speak the same JSON-RPC
 * frames, and v2's transports drive any object exposing
 * `connect`/`close`/`server`. That identity is asserted by the single cast in
 * `modernFactory` below, and was measured end to end — `initialize`,
 * `tools/list` and `tools/call` answered through v2's
 * `WebStandardStreamableHTTPServerTransport` and through `createMcpHandler`'s
 * legacy leg.
 *
 * Rebuilding the server on v2's `McpServer` was the alternative and was
 * rejected: it would move the 20-tool registration table out of `packages/mcp`
 * (the single registration funnel its layout invariant protects) and rewrite
 * `runWithToolCallId(extra.requestId)` and every `getServer()` server→client
 * call site onto v2's `ServerContext`. Until `packages/mcp` itself moves to v2,
 * that is a second migration, not a transport port.
 */

export interface McpSurfaceRequest {
  authInfo: AuthInfo;
  /** Slug from the URL path (`/mcp/<slug>`), or null for the unscoped `/mcp`. */
  requestedSlug: string | null;
}

export interface McpHttpSurface {
  fetch(request: Request, input: McpSurfaceRequest): Promise<Response>;
  close(): Promise<void>;
}

interface LegacySession {
  server: RembricMcpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

type RembricMcpServer = ReturnType<typeof createMcpServer>;

/**
 * Cached on `globalThis` for the same reason `lib/db.ts` caches the database
 * handle: Next re-evaluates modules on every HMR edit, and a re-evaluated
 * module would drop the session map while live clients still hold their
 * `mcp-session-id`s. The map is in-process only — exactly as it is in
 * `apps/server` today — so a session id issued before a real restart is refused
 * with the transport's own `404 Session not found`.
 */
const globalForMcp = globalThis as typeof globalThis & {
  __rembricMcpSurface?: McpHttpSurface;
  __rembricSessionRouter?: SessionRouter;
};

export function getMcpSurface(): McpHttpSurface {
  return (globalForMcp.__rembricMcpSurface ??= buildSurface(getServices()));
}

function buildSurface(services: Services): McpHttpSurface {
  const prompts = new PromptsService(services.repos, services.db.db);
  const relations = new RelationsService(services.repos, services.db.db);
  const router = (globalForMcp.__rembricSessionRouter ??= new SessionRouter());
  const diagnostics = createDiagnostics(services.db);
  const doctor = buildDoctorReport(services, diagnostics);

  // `memory.save` embeds the row it just inserted so save-time candidate
  // detection has a self-vector to kNN from. `services.embeddingWorker()` is the
  // same memoized worker the drain uses, so the save path never costs a second
  // model load; it is only awaited on the save path itself, never at import
  // time (`next build` imports this module).
  const getWorker = (): ReturnType<Services['embeddingWorker']> => services.embeddingWorker();

  const buildServer = (requestedSlug: string | null): RembricMcpServer =>
    createMcpServer({
      memory: services.memory,
      projects: services.projects,
      agentSessions: services.agentSessions,
      prompts,
      relations,
      candidates: { perSaveMax: envInt('CANDIDATES_PER_SAVE_MAX', 5, { min: 0, max: 25 }) },
      embedNow: (memoryId, title, content, projectId) =>
        getWorker().then((worker) => worker.embedNow(memoryId, title, content, projectId)),
      router,
      repos: services.repos,
      doctor,
      sweep: services.sweep,
      usageCounters: services.usageCounters,
      orphanAfterMs: envInt('JUDGMENT_ORPHAN_AFTER_MS', 86_400_000, {
        min: 60_000,
        max: 30 * 86_400_000,
      }),
      requestedSlug,
      version: REMBRIC_VERSION,
      logInternalError,
    });

  const report = (error: Error): void => {
    console.error('[mcp] transport error', { message: error.message, stack: error.stack });
  };

  // SAFETY: the single v1↔v2 boundary in this module. The product is the SDK
  // 1.x `McpServer` the wire protocol is identical for, and v2's transports
  // drive it through `connect`/`close`/`server` only — both halves of that
  // claim were measured end to end (see the module docs). Neither SDK's
  // `McpServer` class is structurally assignable to the other because each
  // declares private fields, so the assertion has no unchecked alternative;
  // if it were wrong, `createMcpHandler`'s legacy leg would fail loudly with a
  // 500 rather than serve anything subtly wrong.
  const modernFactory = ((ctx: McpRequestContext) =>
    buildServer(requestedSlugOf(ctx.requestInfo))) as unknown as McpServerFactory;

  const modern = createMcpHandler(modernFactory, { legacy: 'reject', onerror: report });

  const legacySessions = new Map<string, LegacySession>();

  async function serveLegacy(
    request: Request,
    authInfo: AuthInfo,
    requestedSlug: string | null,
  ): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId !== null) {
      const held = legacySessions.get(sessionId);
      if (held !== undefined) return held.transport.handleRequest(request, { authInfo });
      // The streamable-HTTP contract (and `apps/server` today) answers a
      // session id this process does not hold with `404` so a client knows to
      // re-`initialize`. The transport alone cannot: handed a fresh instance it
      // reports `400 Server not initialized` instead, because that instance
      // never initialized. `initialize` is exempt — it establishes a session
      // regardless of what stale id it carries.
      if (!(await isInitializePost(request))) {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
          { status: 404 },
        );
      }
    }

    // One server per connection, as today: the factory's `requestedSlug` is
    // fixed for the session that created it, so a later request cannot move an
    // established connection's instructions to another project.
    const server = buildServer(requestedSlug);
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        // A session id per connection is what keeps `SessionRouter`
        // (`project.use` pins, roots discovery) and session resumption working.
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id): void => {
          legacySessions.set(id, { server, transport });
        },
      });
    // Assigned before `connect`, which chains onto whatever it finds here.
    transport.onerror = report;
    transport.onclose = () => {
      if (transport.sessionId !== undefined) legacySessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(request, { authInfo });
  }

  return {
    async fetch(request, { authInfo, requestedSlug }) {
      // v2 classifies the same way its own entry would (this is that
      // classification step, exported): 2025-era traffic — every client today —
      // takes the sessionful leg, a 2026-07-28 request takes the v2 entry.
      if (await isLegacyRequest(request)) return serveLegacy(request, authInfo, requestedSlug);
      return modern.fetch(request, { authInfo });
    },
    async close() {
      const closing = [...legacySessions.values()].flatMap(({ server, transport }) => [
        transport.close(),
        server.close(),
      ]);
      legacySessions.clear();
      await Promise.all([modern.close(), ...closing]);
    },
  };
}

/**
 * Whether this request is the `initialize` handshake, read from a clone so the
 * original body stays unconsumed for the transport that serves it. Anything
 * unreadable or unparseable is not an initialize request, which is what
 * `apps/server`'s body read also concludes.
 */
async function isInitializePost(request: Request): Promise<boolean> {
  if (request.method.toUpperCase() !== 'POST') return false;
  try {
    const body: unknown = await request.clone().json();
    return (body as { method?: unknown } | null)?.method === 'initialize';
  } catch {
    return false;
  }
}

/**
 * The slug the modern leg's factory scopes itself to. `createMcpHandler`
 * constructs its instance per request from the request it received, which is
 * where the path is: the route has already validated the segment.
 */
function requestedSlugOf(request: Request | undefined): string | null {
  if (request === undefined) return null;
  try {
    const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
    return segments[0] === 'mcp' ? (segments[1] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Server-side logging for an unexpected tool failure. Same contract as
 * `apps/server/src/server/error-response.ts::logInternalError` — log a
 * correlatable id plus the real message, hand the caller only the id — which is
 * what `packages/mcp`'s handlers expect this callback to do.
 */
function logInternalError(err: unknown, context: string): string {
  const errorId = randomUUID();
  console.error(`[mcp] ${context}`, {
    errorId,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return errorId;
}

/**
 * `memory.doctor`'s one-shot operational report — the port of
 * `apps/server/src/server/bootstrap.ts::buildDoctorReportFactory`, reading the
 * same repositories. `dataDir` is taken from the open connection
 * (`better-sqlite3`'s `Database.name` is the file it actually opened) rather
 * than re-resolving `REMBRIC_DATA_DIR`, so the two index-reset warnings compare
 * the markers against the directory this process is genuinely writing to
 * (data-safety rule DS1: the resolution must not be duplicated).
 */
function buildDoctorReport(
  services: Services,
  diagnostics: ReturnType<typeof createDiagnostics>,
): () => DoctorReport {
  const dataDir = dirname(services.db.raw.name);
  return () => {
    const warnings: string[] = [];

    let journalMode = 'unknown';
    let integrity = 'unknown';
    let sizeBytes = 0;
    try {
      journalMode = diagnostics.readJournalMode();
      integrity = diagnostics.quickCheck();
      sizeBytes = diagnostics.readDbSize().totalBytes;
    } catch (err) {
      warnings.push(`db pragma read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (integrity !== 'ok') warnings.push(`db integrity: ${integrity}`);

    const lastConsolidation = services.repos.consolidation.adminLatestRun();
    const lastRunOps = lastConsolidation?.summary ? parseRunSummary(lastConsolidation.summary) : {};

    const backlog = services.repos.vectors.adminBacklogCount();
    if (backlog > 100) warnings.push(`embeddings backlog: ${backlog}`);

    const entitiesBacklog = services.repos.entities.adminBacklogCount();
    if (entitiesBacklog > 100) warnings.push(`entities backlog: ${entitiesBacklog}`);

    // Both backlogs read 0 in these states: every memory has a vector and a scan
    // row, just from the previous recipe. Nothing else distinguishes them.
    const vectorResetOwed = vectorIndexResetWarningOf(dataDir, services);
    if (vectorResetOwed) warnings.push(vectorResetOwed);
    const entityResetOwed = entityIndexResetWarningOf(dataDir, services);
    if (entityResetOwed) warnings.push(entityResetOwed);

    // Deliberate spec exception (mcp-api/spec.md): memory.doctor's session,
    // needsReview and pendingJudgments counts are all server-wide, unlike
    // memory.stats's scoped ones.
    const sessionsByStatus = services.agentSessions.adminCountByStatus();
    const needsReview = services.repos.memory.adminCountNeedsReview({
      nowMs: Date.now(),
      ttlByType: reviewTtlEntries(),
    });
    const pendingJudgments = services.repos.relations.adminCountByStatus('pending');

    return {
      db: { journalMode, integrity, sizeBytes },
      embeddings: { model: EMBEDDING_MODEL_ID, backlog },
      entities: { backlog: entitiesBacklog },
      consolidation: {
        lastRunAt: lastConsolidation?.startedAt ? lastConsolidation.startedAt.toISOString() : null,
        lastRunOps,
      },
      sessions: { active: sessionsByStatus.active },
      review: { needsReview, pendingJudgments },
      warnings,
    };
  };
}

/**
 * The two index-reset warnings take a row counter, so each needs its own
 * repository's count; wrapped here to keep `buildDoctorReport` reading like the
 * bootstrap it ports.
 */
function vectorIndexResetWarningOf(dataDir: string, services: Services): string | null {
  return vectorIndexResetWarning(dataDir, () => services.repos.vectors.count());
}

function entityIndexResetWarningOf(dataDir: string, services: Services): string | null {
  return entityIndexResetWarning(dataDir, () => services.repos.entities.adminCountEntities({}));
}

/**
 * Integer environment value with the same clamping `lib/services.ts` applies,
 * so a deployment cannot drift from `apps/server`'s zod-parsed config: unset or
 * unparseable → the default, out-of-range → the bound.
 */
function envInt(name: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, bounds.min), bounds.max);
}
