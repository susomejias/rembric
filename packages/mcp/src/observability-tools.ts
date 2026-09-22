import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deriveTitle, type MemoryService } from '@rembric/core';
import { getRequestContext } from '@rembric/core';
import type { AgentSessionsService } from '@rembric/core';
import type { DoctorReport } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { RelationsService } from '@rembric/core';
import type { CandidateOptions } from '@rembric/core';
import type { SessionRouter } from '@rembric/core';
import { type Repositories, type Scope } from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
} from './_shared.js';
import { errToMcp, type ErrorReportingDeps } from './errors.js';
import { candidate, saveMemoryWithCandidates, type SaveTimeCandidateView } from './memory-tools.js';
import { ok } from './result.js';

export { parseRunSummary } from '@rembric/core';
export type { DoctorReport, DoctorRunSummary as ConsolidationRunSummary } from '@rembric/core';

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

const runSummary = z.object({ kind: z.string().optional() }).catchall(z.number());

export const doctorOutput = {
  db: z.object({
    journalMode: z.string(),
    integrity: z.string(),
    sizeBytes: z.number(),
  }),
  embeddings: z.object({ model: z.string(), backlog: z.number() }),
  entities: z.object({ backlog: z.number() }),
  consolidation: z.object({
    lastRunAt: z.string().nullable(),
    lastRunOps: runSummary,
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
  /** Summed over the saves this capture performed; 0 when it extracted nothing. */
  candidatesDetected: z.number(),
};

export interface ObservabilityToolDeps extends ErrorReportingDeps {
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
    projectId: string,
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
  let scope: Scope;
  try {
    scope = (await resolveEffectiveScope(deps)).scope;
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const items = parseKeyLearnings(args.text);
  if (items.length === 0) {
    return ok({
      saved: 0,
      ids: [] as string[],
      reason: `No "${KEY_LEARNINGS_HEADING_HINT}" (or "###") section found; nothing was extracted.`,
      candidatesDetected: 0,
    });
  }
  const captureProjectId = scope.projectId;
  let explicitSession: string | null;
  try {
    if (args.sessionId)
      assertExplicitSessionOwned(deps.agentSessions, args.sessionId, captureProjectId);
    explicitSession = resolveSessionId(deps, args.sessionId, captureProjectId);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const ids: string[] = [];
  const candidates: SaveTimeCandidateView[] = [];
  let candidatesDetected = 0;
  for (const content of items) {
    const saved = await saveMemoryWithCandidates(
      deps,
      {
        type: 'reference',
        title: deriveTitle(content),
        content,
        source: { tokenName: ctx.token.name, agent: 'passive' },
        sessionId: explicitSession,
      },
      scope,
    );
    ids.push(saved.memory.id);
    candidates.push(...saved.candidates);
    candidatesDetected += saved.candidatesDetected;
  }
  return ok({
    saved: ids.length,
    ids,
    ...(candidates.length > 0 ? { candidates } : {}),
    candidatesDetected,
  });
}

async function handleDoctor(deps: ObservabilityToolDeps) {
  try {
    await requireScope(deps, 'read');
    return ok(deps.doctor());
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}

async function handleStats(deps: ObservabilityToolDeps) {
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const { byStatus, byType } = deps.repos.memory.countByStatusAndTypeInScope(scope.projectId);

  const sessionsByStatus = deps.agentSessions.countByStatus(scope);
  const needsReviewTotal = deps.memory.countNeedsReview(scope);
  const pendingJudgmentsTotal = deps.relations ? deps.relations.countPendingInScope(scope) : 0;

  return ok({
    scope: `project:${scope.projectId}`,
    memoriesByStatus: byStatus,
    memoriesByType: byType,
    sessionsByStatus,
    needsReviewTotal,
    pendingJudgmentsTotal,
  });
}
