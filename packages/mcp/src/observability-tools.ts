import {
  captureKeyLearnings,
  RedactionTally,
  type CaptureKeyLearningsResult,
  type MemoryService,
} from '@rembric/core';
import { getRequestContext } from '@rembric/core';
import type { AgentSessionsService } from '@rembric/core';
import type { DoctorReport } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { RelationsService } from '@rembric/core';
import type { CandidateOptions } from '@rembric/core';
import { type Repositories, type Scope } from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
} from './_shared.js';
import { errToMcp, type ErrorReportingDeps } from './errors.js';
import { candidate, memorySaveSchema, relatedMemory } from './memory-tools.js';
import { redactionsField, redactionsOutput } from './redactions.js';
import { ok } from './result.js';

export { parseRunSummary } from '@rembric/core';
export type { DoctorReport, DoctorRunSummary as ConsolidationRunSummary } from '@rembric/core';

export const capturePassiveSchema = {
  text: z.string().min(1).max(50_000),
  tags: memorySaveSchema.tags,
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
  skipped: z.number(),
  ids: z.array(z.string()),
  candidates: z.array(candidate).optional(),
  related: z.array(relatedMemory).optional(),
  convergeWith: z.array(z.string()).optional(),
  /** Present when `saved` is 0: no learnings section, or every item already captured in this session. */
  reason: z.string().optional(),
  /** Summed over the saves this capture performed; 0 when it extracted nothing. */
  candidatesDetected: z.number(),
  redactions: redactionsOutput,
};

export interface ObservabilityToolDeps extends ErrorReportingDeps {
  memory: MemoryService;
  agentSessions: AgentSessionsService;
  repos: Pick<Repositories, 'memory' | 'relations' | 'vectors' | 'entities' | 'termStatistics'>;
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
}

export function buildObservabilityHandlers(deps: ObservabilityToolDeps) {
  return {
    doctor: handleDoctor.bind(null, deps),
    stats: handleStats.bind(null, deps),
    capturePassive: handleCapturePassive.bind(null, deps),
  };
}

async function handleCapturePassive(
  deps: ObservabilityToolDeps,
  args: { text: string; tags?: string[]; sessionId?: string },
) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = (await resolveEffectiveScope(deps)).scope;
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const redactions = new RedactionTally();
  let out: CaptureKeyLearningsResult;
  try {
    out = await captureKeyLearnings(
      deps,
      {
        text: args.text,
        tags: args.tags,
        resolveSessionId: () => resolveSessionId(deps, args.sessionId, scope.projectId),
        source: { tokenName: ctx.token.name, agent: 'passive' },
      },
      scope,
      redactions,
    );
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  return ok({
    saved: out.saved,
    skipped: out.skipped,
    ids: out.ids,
    ...(out.candidates.length > 0 ? { candidates: out.candidates } : {}),
    ...(out.related.length > 0 ? { related: out.related } : {}),
    ...(out.convergeWith.length > 0 ? { convergeWith: out.convergeWith } : {}),
    ...(out.reason !== undefined ? { reason: out.reason } : {}),
    candidatesDetected: out.candidatesDetected,
    ...redactionsField(redactions),
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
