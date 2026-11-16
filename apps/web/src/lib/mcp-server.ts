import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import {
  EMBEDDING_MODEL_ID,
  PromptsService,
  RelationsService,
  entityIndexResetWarning,
  reviewTtlEntries,
  tryGetRequestContext,
  vectorIndexResetWarning,
} from '@rembric/core';
import { createDiagnostics } from '@rembric/db';
import {
  createMcpServer,
  isUnboundContext,
  parseRunSummary,
  type DoctorReport,
} from '@rembric/mcp';

import { maxRequestBodyBytes } from './api';
import { getServices, type Services } from './services';
import { REMBRIC_VERSION } from './version';

export interface McpHttpSurface {
  fetch(request: Request, input: { authInfo: AuthInfo }): Promise<Response>;
  close(): Promise<void>;
}

const globalForMcp = globalThis as typeof globalThis & {
  __rembricMcpSurface?: McpHttpSurface;
};

export function getMcpSurface(): McpHttpSurface {
  return (globalForMcp.__rembricMcpSurface ??= buildSurface(getServices()));
}

function buildSurface(services: Services): McpHttpSurface {
  const prompts = new PromptsService(services.repos, services.db.db);
  const relations = new RelationsService(services.repos, services.db.db);
  const diagnostics = createDiagnostics(services.db);
  const doctor = buildDoctorReport(services, diagnostics);

  return createMcpHandler(
    () =>
      createMcpServer({
        memory: services.memory,
        projects: services.projects,
        agentSessions: services.agentSessions,
        prompts,
        relations,
        repositoryBindings: services.repositoryBindings,
        candidates: services.postSave.candidates,
        embedNow: services.postSave.embedNow,
        repos: services.repos,
        doctor,
        sweep: services.sweep,
        usageCounters: services.usageCounters,
        orphanAfterMs: envInt('JUDGMENT_ORPHAN_AFTER_MS', 86_400_000, {
          min: 60_000,
          max: 30 * 86_400_000,
        }),
        requestedSlug: tryGetRequestContext()?.requestedSlug ?? null,
        unbound: isUnboundContext(tryGetRequestContext()),
        version: REMBRIC_VERSION,
        logInternalError,
      }),
    {
      onerror: (error: Error): void => {
        console.error('[mcp] transport error', { message: error.message, stack: error.stack });
      },
      maxRequestBodySize: maxRequestBodyBytes(),
    },
  );
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
