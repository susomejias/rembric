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

export interface McpSurfaceRequest {
  authInfo: AuthInfo;
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

  // SAFETY: the single v1↔v2 SDK boundary — v2 transports drive the SDK 1.x `McpServer` through `connect`/`close`/`server` only.
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
      if (!(await isInitializePost(request))) {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
          { status: 404 },
        );
      }
    }

    const server = buildServer(requestedSlug);
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id): void => {
          legacySessions.set(id, { server, transport });
        },
      });
    transport.onerror = report;
    transport.onclose = () => {
      if (transport.sessionId !== undefined) legacySessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(request, { authInfo });
  }

  return {
    async fetch(request, { authInfo, requestedSlug }) {
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

async function isInitializePost(request: Request): Promise<boolean> {
  if (request.method.toUpperCase() !== 'POST') return false;
  try {
    const body: unknown = await request.clone().json();
    return (body as { method?: unknown } | null)?.method === 'initialize';
  } catch {
    return false;
  }
}

function requestedSlugOf(request: Request | undefined): string | null {
  if (request === undefined) return null;
  try {
    const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
    return segments[0] === 'mcp' ? (segments[1] ?? null) : null;
  } catch {
    return null;
  }
}

function logInternalError(err: unknown, context: string): string {
  const errorId = randomUUID();
  console.error(`[mcp] ${context}`, {
    errorId,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return errorId;
}

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

    const vectorResetOwed = vectorIndexResetWarningOf(dataDir, services);
    if (vectorResetOwed) warnings.push(vectorResetOwed);
    const entityResetOwed = entityIndexResetWarningOf(dataDir, services);
    if (entityResetOwed) warnings.push(entityResetOwed);

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

function vectorIndexResetWarningOf(dataDir: string, services: Services): string | null {
  return vectorIndexResetWarning(dataDir, () => services.repos.vectors.count());
}

function entityIndexResetWarningOf(dataDir: string, services: Services): string | null {
  return entityIndexResetWarning(dataDir, () => services.repos.entities.adminCountEntities({}));
}

function envInt(name: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, bounds.min), bounds.max);
}
