import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
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
import { errToMcp } from './errors.js';
import { candidate, saveMemoryWithCandidates, type SaveTimeCandidateView } from './memory-tools.js';
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

/**
 * `consolidation_runs.summary` is free-form JSON with two writer families: the
 * sweep writes bare counters (`{archives,orphaned}`), maintenance-journal runs
 * add a `kind` discriminator (`{kind:'agent_memory_archive',archived:1}`).
 */
const runSummary = z.object({ kind: z.string().optional() }).catchall(z.number());

export interface ConsolidationRunSummary {
  kind?: string;
  [op: string]: string | number | undefined;
}

/**
 * Narrow a stored summary to what `doctorOutput` admits, so a shape no writer
 * is supposed to produce degrades this one field instead of failing the whole
 * report — `memory.doctor` is the tool an operator reaches for when the DB is
 * already suspect.
 */
export function parseRunSummary(raw: string): ConsolidationRunSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: ConsolidationRunSummary = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'kind') {
      if (typeof value === 'string') out.kind = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

export interface DoctorReport {
  db: { journalMode: string; integrity: string; sizeBytes: number };
  embeddings: { model: string; backlog: number };
  /** Memories not yet scanned for entities — a derived-index drift signal, same shape as `embeddings.backlog`. */
  entities: { backlog: number };
  consolidation: { lastRunAt: string | null; lastRunOps: ConsolidationRunSummary };
  sessions: { active: number };
  /** Server-wide (unscoped) queue-depth signals — same precedent as `sessions.active`; `memory.stats` carries the scoped equivalents. */
  review: { needsReview: number; pendingJudgments: number };
  warnings: string[];
}

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
  let scope: Scope;
  try {
    scope = (await resolveEffectiveScope(deps)).scope;
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err);
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
    return errToMcp(err);
  }
  const ids: string[] = [];
  const candidates: SaveTimeCandidateView[] = [];
  let candidatesDetected = 0;
  for (const content of items) {
    // Same curation pipeline as memory.save: convergent-topic handling,
    // inline embedding before candidate detection, and save-time candidate
    // detection — so bulk-captured rows are never unlinked/unembedded.
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
  const { byStatus, byType } = deps.repos.memory.countByStatusAndTypeInScope(scope.projectId);

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
