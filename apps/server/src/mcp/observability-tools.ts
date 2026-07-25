import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import type { MemoryScope } from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { deriveTitle, type MemoryService } from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { RelationsService } from '../services/relations.js';
import type { CandidateOptions } from '../services/save-time-candidates.js';
import type { Scope } from '../services/scope.js';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
} from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { candidate, saveMemoryWithCandidates, type SaveTimeCandidateView } from './memory-tools.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ok } from './result.js';

/**
 * Observability + read-back MCP tools: doctor / stats / capture_passive.
 */

export const capturePassiveSchema = {
  text: z.string().min(1).max(50_000),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Pass this if you know your current session id (your host may surface it) to guarantee correct attachment when multiple sessions could be active. Never invent one — omit if unknown.',
    ),
};

const counts = z.record(z.string(), z.number());

export interface DoctorReport {
  db: { open: boolean; journalMode: string; integrity: string; sizeBytes: number };
  embeddings: { model: string; backlog: number };
  /** Memories not yet scanned for entities — a derived-index drift signal, same shape as `embeddings.backlog`. */
  entities: { backlog: number };
  consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
  sessions: { active: number };
  /** Server-wide (unscoped) queue-depth signals — same precedent as `sessions.active`; `memory.stats` carries the scoped equivalents. */
  review: { needsReview: number; pendingJudgments: number };
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
  entities: z.object({ backlog: z.number() }),
  consolidation: z.object({
    lastRunAt: z.string().nullable(),
    lastRunOps: counts,
  }),
  sessions: z.object({ active: z.number() }),
  review: z.object({ needsReview: z.number(), pendingJudgments: z.number() }),
  warnings: z.array(z.string()),
};

export const statsOutput = {
  scope: z.string(),
  memoriesByStatus: counts,
  memoriesByType: counts,
  sessionsByStatus: counts,
  /** Queue-depth signals, both scoped to this call's context. */
  needsReviewTotal: z.number(),
  pendingJudgmentsTotal: z.number(),
};

export const capturePassiveOutput = {
  saved: z.number(),
  ids: z.array(z.string()),
  candidates: z.array(candidate).optional(),
  /** Present (and `saved` will be 0) when no learnings section was found. */
  reason: z.string().optional(),
};

export interface ObservabilityToolDeps {
  memory: MemoryService;
  agentSessions: AgentSessionsService;
  repos: Pick<Repositories, 'memory' | 'relations' | 'vectors' | 'entities'>;
  router: SessionRouter;
  projects: ProjectsService;
  doctor: () => DoctorReport;
  /** Save-time curation deps — same pipeline `memory.save` uses. */
  relations?: RelationsService;
  candidates?: CandidateOptions;
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    scope: MemoryScope,
    projectId: string | null,
  ) => Promise<boolean>;
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

// Case-insensitive H2 or H3, colon optional, so ordinary formatting
// variation ("### key learnings", "## Key Learnings") is not silently
// discarded — see openspec/changes/fix-audited-defects.
export const KEY_LEARNINGS_HEADING_HINT = '## Key Learnings' as const;
const KEY_LEARNINGS_RE = /^(#{2,3})[ \t]*key learnings:?[ \t]*$/im;
const NEXT_HEADING_RE = /^#{2,3}[ \t]/m;
const LIST_ITEM_RE = /^(?:\s*(?:-|\*|\d+\.)\s+)(.+?)\s*$/gm;

export function parseKeyLearnings(text: string): string[] {
  const match = KEY_LEARNINGS_RE.exec(text);
  if (!match || match.index === undefined) return [];
  const after = text.slice(match.index + match[0].length);
  // Stop at the next H2/H3 header or end of input.
  const nextHeading = after.search(NEXT_HEADING_RE);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
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
    return ok({
      saved: 0,
      ids: [] as string[],
      reason: `No "${KEY_LEARNINGS_HEADING_HINT}" (or "###") section found; nothing was extracted.`,
    });
  }
  const captureProjectId = scope.kind === 'project' ? scope.projectId : null;
  let explicitSession: string | null;
  try {
    if (args.sessionId)
      assertExplicitSessionOwned(deps.agentSessions, args.sessionId, captureProjectId);
    explicitSession = resolveSessionId(deps, args.sessionId, captureProjectId);
  } catch (err) {
    return errToMcp(err);
  }
  const ids: string[] = [];
  const candidates: SaveTimeCandidateView[] = [];
  for (const content of items) {
    // Same curation pipeline as memory.save: convergent-topic handling,
    // inline embedding before candidate detection, and save-time candidate
    // detection — so bulk-captured rows are never unlinked/unembedded.
    const { memory: m, candidates: detected } = await saveMemoryWithCandidates(
      deps,
      {
        type: 'reference',
        title: deriveTitle(content),
        content,
        source: { tokenName: ctx.token.name, agent: 'passive' },
        sessionId: explicitSession,
      },
      scope,
      ctx.token.name,
    );
    ids.push(m.id);
    candidates.push(...detected);
  }
  return ok({ saved: ids.length, ids, ...(candidates.length > 0 ? { candidates } : {}) });
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

  // Scoped — NOT adminCountByStatus. See openspec/changes/fix-audited-defects
  // ("memory.stats.sessionsByStatus bypasses scope enforcement").
  const sessionsByStatus = deps.agentSessions.countByStatus(scope);
  const needsReviewTotal = deps.memory.countNeedsReview(scope);
  const pendingJudgmentsTotal = deps.relations ? deps.relations.countPendingInScope(scope) : 0;

  return ok({
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    memoriesByStatus: byStatus,
    memoriesByType: byType,
    sessionsByStatus,
    needsReviewTotal,
    pendingJudgmentsTotal,
  });
}
