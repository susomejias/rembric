import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { deriveTitle, type MemoryService } from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { Scope } from '../services/scope.js';

import {
  assertAuthorized,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
} from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ok } from './result.js';

/**
 * Observability + read-back MCP tools: doctor / stats / capture_passive.
 */

export const capturePassiveSchema = {
  text: z.string().min(1).max(50_000),
  sessionId: z.string().min(1).optional(),
};

const counts = z.record(z.string(), z.number());

export interface DoctorReport {
  db: { open: boolean; journalMode: string; integrity: string; sizeBytes: number };
  embeddings: { model: string; backlog: number };
  consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
  sessions: { active: number };
  warnings: string[];
}

export const doctorOutput = {
  db: z.object({
    open: z.boolean(),
    journalMode: z.string(),
    integrity: z.string(),
    sizeBytes: z.number(),
  }),
  embeddings: z.object({ model: z.string(), backlog: z.number() }),
  consolidation: z.object({
    lastRunAt: z.string().nullable(),
    lastRunOps: counts,
  }),
  sessions: z.object({ active: z.number() }),
  warnings: z.array(z.string()),
};

export const statsOutput = {
  scope: z.string(),
  memoriesByStatus: counts,
  memoriesByType: counts,
  sessionsByStatus: counts,
};

export const capturePassiveOutput = {
  saved: z.number(),
  ids: z.array(z.string()),
};

export interface ObservabilityToolDeps {
  memory: MemoryService;
  agentSessions: AgentSessionsService;
  repos: Pick<Repositories, 'memory'>;
  router: SessionRouter;
  projects: ProjectsService;
  doctor: () => DoctorReport;
  /** Set by `createMcpServer` after construction to enable roots discovery. */
  getServer?: () => McpServer;
}

export function buildObservabilityHandlers(deps: ObservabilityToolDeps) {
  return {
    doctor: handleDoctor.bind(null, deps),
    stats: handleStats.bind(null, deps),
    capturePassive: handleCapturePassive.bind(null, deps),
  };
}

const KEY_LEARNINGS_RE = /^## Key Learnings:\s*$/m;
const LIST_ITEM_RE = /^(?:\s*(?:-|\*|\d+\.)\s+)(.+?)\s*$/gm;

export function parseKeyLearnings(text: string): string[] {
  const match = KEY_LEARNINGS_RE.exec(text);
  if (!match || match.index === undefined) return [];
  const after = text.slice(match.index + match[0].length);
  // Stop at the next H2 header or end of input.
  const nextH2 = after.search(/^## (?!Key Learnings:)/m);
  const section = nextH2 === -1 ? after : after.slice(0, nextH2);
  LIST_ITEM_RE.lastIndex = 0;
  const items: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LIST_ITEM_RE.exec(section)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v.length > 0) items.push(v);
  }
  return items;
}

async function handleCapturePassive(
  deps: ObservabilityToolDeps,
  args: { text: string; sessionId?: string },
) {
  const ctx = getRequestContext();
  const { scope, project } = await resolveEffectiveScope(deps);
  // Same gate as memory.save: an unscoped connection with pending
  // roots-derived suggestions must not silently write to global.
  if (!project) {
    const pending = pendingSuggestionGate(ctx, { router: deps.router, projects: deps.projects });
    if (pending) {
      return mcpError('project_suggestion_pending', suggestionPendingMessage(), {
        suggestedSlugs: pending,
      });
    }
  }
  try {
    assertAuthorized('write', scope);
  } catch (err) {
    return errToMcp(err);
  }
  const items = parseKeyLearnings(args.text);
  if (items.length === 0) {
    return ok({ saved: 0, ids: [] as string[] });
  }
  const explicitSession = resolveSessionId(
    deps,
    args.sessionId,
    scope.kind === 'project' ? scope.projectId : null,
  );
  const ids: string[] = [];
  for (const content of items) {
    const m = deps.memory.save(
      {
        type: 'reference',
        title: deriveTitle(content),
        content,
        source: { tokenName: ctx.token.name, agent: 'passive' },
        sessionId: explicitSession,
      },
      scope,
    );
    ids.push(m.id);
  }
  return ok({ saved: ids.length, ids });
}

async function handleDoctor(deps: ObservabilityToolDeps) {
  try {
    await requireScope(deps, 'read');
    return ok(deps.doctor());
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleStats(deps: ObservabilityToolDeps) {
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  const { byStatus, byType } = deps.repos.memory.countByStatusAndTypeInScope(
    scope.kind === 'project' ? 'project' : 'global',
    scope.kind === 'project' ? scope.projectId : null,
  );

  const sessionsByStatus = deps.agentSessions.countByStatus();

  return ok({
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    memoriesByStatus: byStatus,
    memoriesByType: byType,
    sessionsByStatus,
  });
}
