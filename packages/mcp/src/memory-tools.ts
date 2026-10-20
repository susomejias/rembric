import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { extractEntities, type ExtractedEntity, projectEntities } from '@rembric/core';
import { iterateEntityMatches } from '@rembric/core';
import { RANK_WINDOW_CEILING, type SearchVerdict } from '@rembric/core';
import {
  DEFAULT_SEARCH_LIMIT,
  type MemoryService,
  type SaveMemoryInput,
  type SearchMemoriesInput,
} from '@rembric/core';
import {
  ANNOTATION_REASON_CHARS,
  MULTI_ROW_ANNOTATION_DEFAULT,
  RELATION_ANNOTATION_MAX,
  RELATION_ANNOTATION_RESPONSE_BUDGET,
  SEARCH_LIMIT_MAX,
  type RelationsService,
} from '@rembric/core';
import { findSaveTimeCandidates, type CandidateOptions } from '@rembric/core';
import { getRequestContext, tryGetRequestContext } from '@rembric/core';
import type { PromptsService } from '@rembric/core';
import type { AgentSessionsService } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { CountedTool, UsageCounters } from '@rembric/core';
import type { SessionRouter } from '@rembric/core';
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Memory,
  type Repositories,
  type Scope,
  type SearchScope,
} from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  boundAnnotationReasons,
  clamp,
  type EffectiveScope,
  requireScope,
  resolveEffectiveScope,
  resolveSearchScope,
  routerKey,
  searchedProjectSlugs,
  serializeMemory,
  snippet,
} from './_shared.js';
import { errToMcp, isDomainError, itemError, mcpError, type ErrorReportingDeps } from './errors.js';
import { batchResult, ok } from './result.js';

/** An entry carries two snippets and two titles, ~2x a recentMemories row, so 50 costs about what `memories: 100` does. */
const PENDING_JUDGMENTS_MAX = 50;
/** A queue-depth warning, not a page of an inventory — the caller asks for inventory by passing a size. */
const PENDING_JUDGMENTS_DEFAULT = 5;

export const CONTEXT_SESSIONS_MAX = 25;
export const CONTEXT_PROMPTS_MAX = 50;
export const CONTEXT_MEMORIES_MAX = 100;
export const TIMELINE_WINDOW_MAX = 50;

/** Per-surface `relations` defaults; the maximum and the multi-row default are shared. */
const RELATION_ANNOTATION_DEFAULT = MULTI_ROW_ANNOTATION_DEFAULT;

/** The text must keep naming `min(relationsTotal, MAX)`: a bare `relationsTotal` is the ask this schema rejects. */
function relationsLimitParam(defaults: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(RELATION_ANNOTATION_MAX)
    .optional()
    .describe(
      `How many relation annotations to return per memory (${defaults}). Each row's ` +
        '`relationsTotal` reports how many exist, so when it exceeds the returned length ' +
        `ask again with relations_limit: min(relationsTotal, ${RELATION_ANNOTATION_MAX}). ` +
        `A value above ${RELATION_ANNOTATION_MAX} is REJECTED, not clamped. Annotations come ` +
        'contradiction- and lifecycle-first, so a lower bound never hides one of those — but ' +
        'it does bound what `include_relations` can expand from, since expansion draws on the ' +
        'annotations returned here. Rows and this bound are limited TOGETHER: their product may ' +
        `not exceed ${RELATION_ANNOTATION_RESPONSE_BUDGET} annotations per response, so trade one ` +
        `against the other (e.g. ${Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / RELATION_ANNOTATION_MAX)} ` +
        `rows at ${RELATION_ANNOTATION_MAX}, or the row maximum at the default). ` +
        'Over-budget is REJECTED too. On the multi-row surfaces a judged `reason` is truncated; ' +
        'single-item `memory.get_batch({ids:[id],relations_limit:50})` returns complete reasons.',
    );
}

export const memorySaveSchema = {
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(100),
  content: z.string().min(1),
  tags: z
    .array(z.string())
    .min(1)
    .max(64)
    .describe(
      'Required: 1–64 useful reusable lowercase Unicode kebab-case labels, normally 1–5; e.g. dashboard, sqlite, bug-fix.',
    ),
  topic_key: z.string().min(1).max(128).optional(),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Pass this if you know your current session id (your host may surface it) to guarantee correct attachment when multiple sessions could be active. Never invent one — omit if unknown.',
    ),
};

export const memorySearchSchema = {
  query: z.string().optional(),
  entity: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Exact-address lookup. Use INSTEAD of `query` whenever you have the literal identifier — a text query for one is noisy (`migrate.ts` also hits `migrate.ts.bak`, `#36` degrades to any "36"). Accepts a path, git SHA, URL, error code, ticket, CVE, IPv4, `.local`-style hostname, systemd unit, MAC, env var name, or UUID. Returns every linked memory in scope, chronological and unranked — no relevance cutoff, and with no `limit` the whole linked set (bounded at 400) rather than the 8-row ranked default. Narrows further with `status`, `type`, `tag` and `topic_key`; with `query` it narrows, never fuses. Unknown value returns empty rather than a degraded text search, so retry with `query` if it does — unless the response also carries `entityIndexDraining`, which means the index has not finished scanning this scope and the same lookup is worth repeating shortly.',
    ),
  type: z.enum(MEMORY_TYPES).optional(),
  tag: z.string().optional(),
  topic_key: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Return only memories carrying this exact topic_key. On its own it returns the topic's whole history — the active row plus every row it superseded — because that is what tells you whether the topic already converged before you save a synonym key; pass `status` too to narrow to one. Pair with memory.suggest_topic_key.",
    ),
  status: z.enum(MEMORY_STATUSES).optional(),
  across_projects: z
    .boolean()
    .optional()
    .describe(
      'Also read the other projects this token is allowed to read — never one it is not. Leave it off for ordinary recall: pass it only when the user explicitly asks about other projects, or when this project answered nothing. `searchedProjects[]` in the response names the projects actually read, and `widened:true` appears only when that was more than one; a token that reaches a single project gets its ordinary result. Reads only — it does not change where memory.save writes, and memory.get_batch still refuses an id from another project.',
    ),
  include_relations: z
    .boolean()
    .optional()
    .describe(
      "Also fetch each result's one-hop supersedes/superseded_by/conflicts_with counterpart (if not already in the results) as a separate `expanded` array, capped at 5, never counted against `limit`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .optional()
    .describe(
      `Max results (default 8). Raise it (up to ${SEARCH_LIMIT_MAX}) when 8 are all relevant and you need more.`,
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Skip this many results for paging. Exact for the no-query listing; on a text query it is best-effort within a bounded relevance window, so a deep offset may return an empty page.',
    ),
  snippet: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Truncate each result's `content` to this many characters (ellipsis appended) so a broad triage scan stays cheap; omit for full content, then drill in with memory.get_batch.",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Restrict each result to these fields; identity fields (id, type, title) are always included. Omit for the full row.',
    ),
  relations_limit: relationsLimitParam(`default ${RELATION_ANNOTATION_DEFAULT}`),
};

export const memoryGetSchema = {
  ids: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Memory IDs in requested order; duplicates removed before paging. Use IDs OR from/to, never both. A one-item array reads one memory; missing/foreign IDs have errors.',
    ),
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO timestamp with offset: inclusive creation-time start. Select all in-scope statuses by createdAt, not lastSeenAt. Current records/history, not historical snapshots; mutually exclusive with ids.',
    ),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO timestamp with offset: exclusive creation-time end; defaults to server now. Requires from < to.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Outcomes per page, including errors; default/max20. Full records, no byte-based truncation.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Default0. Continue with nextOffset until null using the same selection. Period pages are live views; only successfully served records count as access.',
    ),
  relations_limit: relationsLimitParam(`default ${RELATION_ANNOTATION_DEFAULT}`),
};

export const memoryConfirmSchema = {
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
      '1–20 memory IDs, deduplicated; one shared verdict. Atomic: any failed target rolls back every confirmation. Use a one-element array for one memory.',
    ),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Pass this if you know your current session id (your host may surface it) to guarantee correct attachment when multiple sessions could be active. Never invent one — omit if unknown.',
    ),
  verdict: z
    .enum(['affirm', 'refute'])
    .optional()
    .describe(
      "Default 'affirm' (still true, re-verified). Set 'refute' ONLY when a memory you just surfaced turned out wrong or stale AND you have concretely verified that — never as routine cleanup, never for a memory you have not actually acted on. Refuting does not archive or edit anything; it marks the memory needs_review immediately (bypassing its normal shelf life) so a human or a later pass re-verifies it. Requires `reason`.",
    ),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe('Required when verdict is "refute": concretely what proved it wrong or stale.'),
};

export const memoryArchiveSchema = {
  id: z
    .string()
    .min(1)
    .describe('The id of the active memory to retire. Must be in the connection’s scope.'),
};

export const contextSchema = {
  sessions: z.number().int().min(0).max(CONTEXT_SESSIONS_MAX).optional(),
  prompts: z.number().int().min(0).max(CONTEXT_PROMPTS_MAX).optional(),
  memories: z.number().int().min(0).max(CONTEXT_MEMORIES_MAX).optional(),
  judgments: z
    .number()
    .int()
    .min(0)
    .max(PENDING_JUDGMENTS_MAX)
    .optional()
    .describe(
      'How many pendingJudgments[] to return. Passing it also LIFTS the age filter, so the un-aged pairs become reachable; omit it for the aged queue-depth warning. Compare against pendingJudgmentsTotal to tell a page from the queue.',
    ),
  includeArchived: z.boolean().optional(),
  focus: z
    .string()
    .optional()
    .describe(
      'What the agent is about to work on, to rank relevantMemories[] by. When omitted, the server derives a seed from the active session and recent prompts.',
    ),
};

export const timelineSchema = {
  memoryId: z.string().min(1),
  before: z.number().int().min(0).max(TIMELINE_WINDOW_MAX).optional(),
  after: z.number().int().min(0).max(TIMELINE_WINDOW_MAX).optional(),
};

const relationView = z.object({
  kind: z.string(),
  targetId: z.string(),
  judgmentId: z.string().optional(),
  status: z.string(),
  reason: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
});

export const candidate = z.object({
  judgmentId: z.string(),
  targetId: z.string(),
  title: z.string(),
  snippet: z.string(),
  similarity: z.number(),
  source: z.string(),
  topicKey: z.string().nullable(),
  /** Set only when `source: 'entity'` — the value both memories share. */
  entityValue: z.string().optional(),
});

const entityRef = z.object({ kind: z.string(), value: z.string() });

const memoryRow = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  scope: z.string().optional(),
  projectId: z.string().nullable().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  replaces: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  lastSeenAt: z.string().nullable().optional(),
  topicKey: z.string().nullable().optional(),
  relations: z.array(relationView).optional(),
  relationsTotal: z.number().optional(),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
  reviewEscalated: z.boolean().optional(),
  entities: z.array(entityRef).optional(),
  /** Pre-bound count, exact (the reads carry no LIMIT). Truncation is `entitiesTotal > entities.length`. */
  entitiesTotal: z.number().optional(),
});

const memoryNeighbor = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  status: z.string(),
  createdAt: z.string(),
  sessionId: z.string().nullable(),
});

export const memorySaveOutput = {
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
  candidates: z.array(candidate),
  judgmentRequired: z.boolean(),
  /** Pre-cap detection count. Truncation is `candidatesDetected > candidates.length`. */
  candidatesDetected: z.number(),
};

const expandedMemoryRow = memoryRow.extend({
  expandedFrom: z.string(),
  relationKind: z.string(),
});

const searchVerdict = {
  abstained: z.boolean(),
  abstainReason: z.string().optional(),
  gateShortened: z.literal(true).optional(),
};

export const memorySearchOutput = {
  count: z.number(),
  memories: z.array(memoryRow),
  expanded: z.array(expandedMemoryRow).optional(),
  ...searchVerdict,
  searchedProjects: z.array(z.string()).optional(),
  /** Reports the result, not the request: absent when only one project was read. */
  widened: z.boolean().optional(),
  /** True when `entity` drove retrieval (exact-address, not ranked). */
  viaEntity: z.boolean().optional(),
  entityIndexDraining: z.boolean().optional(),
};

export const memoryGetOutput = {
  memories: z.array(
    memoryRow
      .required({
        scope: true,
        projectId: true,
        content: true,
        tags: true,
        status: true,
        replaces: true,
        createdAt: true,
        lastSeenAt: true,
        topicKey: true,
        relations: true,
        relationsTotal: true,
        entities: true,
        entitiesTotal: true,
      })
      .extend({
        head: z.object({
          id: z.string(),
          title: z.string(),
          content: z.string(),
          status: z.string(),
        }),
        predecessors: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            createdAt: z.string(),
          }),
        ),
        predecessorCount: z.number(),
        truncated: z.boolean(),
        headTruncated: z.boolean(),
        confirmationCount: z.number(),
      }),
  ),
  errors: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      message: z.string(),
      errorId: z.string().optional(),
    }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
};

export const memoryConfirmOutput = {
  ok: z.literal(true),
  confirmed: z.number(),
  /** True when resolving the supersedes-chain head stopped at its hop cap. */
  headTruncated: z.boolean().optional(),
};

export const memoryArchiveOutput = {
  ok: z.literal(true),
  id: z.string(),
  status: z.literal('archived'),
};

export const contextOutput = {
  scope: z.string(),
  recentSessions: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      status: z.string(),
      title: z.string().nullable(),
      summary: z.string().nullable(),
    }),
  ),
  recentPrompts: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      agent: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  recentMemories: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      snippet: z.string(),
      status: z.string(),
      createdAt: z.string(),
      topicKey: z.string().nullable(),
    }),
  ),
  relevantMemories: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      snippet: z.string(),
      status: z.string(),
      createdAt: z.string(),
      topicKey: z.string().nullable(),
      /** How this row was found — exact entity match, or ranked hybrid search. */
      via: z.enum(['entity', 'ranked']),
    }),
  ),
  rankedPass: z.object(searchVerdict).optional(),
  pendingJudgments: z.array(
    z.object({
      judgmentId: z.string(),
      sourceId: z.string(),
      targetId: z.string(),
      sourceTitle: z.string(),
      targetTitle: z.string(),
      sourceSnippet: z.string(),
      targetSnippet: z.string(),
      ageMs: z.number(),
    }),
  ),
  pendingJudgmentsTotal: z.number(),
  needsReview: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      snippet: z.string(),
      reviewAfter: z.string(),
      ageMs: z.number(),
    }),
  ),
  needsReviewTotal: z.number(),
};

export const timelineOutput = {
  target: z.object({ id: z.string(), createdAt: z.string() }),
  before: z.array(memoryNeighbor),
  after: z.array(memoryNeighbor),
  fallback: z.string().nullable(),
};

export interface MemoryToolDeps extends ErrorReportingDeps {
  memory: MemoryService;
  /** Optional — when present, save surfaces candidates + writes pending relations. */
  relations?: RelationsService;
  /** Optional — when present, controls candidate detection thresholds. */
  candidates?: CandidateOptions;
  /** Optional — repositories needed for save-time candidates + context/timeline reads. */
  repos?: Pick<Repositories, 'memory' | 'relations' | 'vectors' | 'entities'>;
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    projectId: string,
  ) => Promise<boolean>;
  /** Optional — required to evaluate the project-suggestion gate on save, and scope resolution for context/timeline. */
  router?: SessionRouter;
  /** Every connection resolves to a project, so scope resolution cannot proceed without this. */
  projects: ProjectsService;
  agentSessions?: AgentSessionsService;
  /** Optional — required by `memory.context` to surface recent prompts. */
  prompts?: PromptsService;
  /** Optional — pending relations older than this surface in `memory.context`. */
  orphanAfterMs?: number;
  getServer?: () => McpServer;
  usageCounters?: UsageCounters;
}

export function buildMemoryHandlers(deps: MemoryToolDeps) {
  return {
    save: counted(deps, 'memory.save', handleSave.bind(null, deps)),
    search: counted(deps, 'memory.search', handleSearch.bind(null, deps)),
    get: handleGet.bind(null, deps),
    confirm: handleConfirm.bind(null, deps),
    archive: handleArchive.bind(null, deps),
    context: counted(deps, 'memory.context', handleContext.bind(null, deps)),
    timeline: handleTimeline.bind(null, deps),
  };
}

function counted<Args extends unknown[], Res>(
  deps: MemoryToolDeps,
  tool: CountedTool,
  fn: (...args: Args) => Promise<Res>,
): (...args: Args) => Promise<Res> {
  const counters = deps.usageCounters;
  if (!counters) return fn;
  return async (...args: Args) => {
    const result = await fn(...args);
    try {
      const ctx = tryGetRequestContext();
      const failed =
        typeof result === 'object' &&
        result !== null &&
        (result as { isError?: boolean }).isError === true;
      if (ctx && !failed) counters.record(ctx.token.id, tool);
    } catch {
      // Observability only — a broken counter must never fail a tool call.
    }
    return result;
  };
}

function resolveActiveSessionId(
  deps: MemoryToolDeps,
  projectId: string | null,
  explicit?: string,
): string | null {
  if (explicit) {
    if (deps.agentSessions) {
      assertExplicitSessionOwned(deps.agentSessions, explicit, projectId);
      deps.agentSessions.touchActivity(explicit);
    }
    return explicit;
  }
  const ctx = getRequestContext();
  if (ctx.mcpSessionId && deps.router) {
    const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
    if (entry?.rembricSessionId) {
      deps.agentSessions?.touchActivity(entry.rembricSessionId);
      return entry.rembricSessionId;
    }
  }
  if (deps.agentSessions) {
    const row = deps.agentSessions.findActiveForTransport({
      tokenId: ctx.token.id,
      projectId,
    });
    if (row) {
      deps.agentSessions.touchActivity(row.id);
      return row.id;
    }
  }
  return null;
}

export interface SaveTimeCandidateView {
  judgmentId: string;
  targetId: string;
  title: string;
  snippet: string;
  similarity: number;
  source: 'vec' | 'fts' | 'entity';
  topicKey: string | null;
  /** Set only for `source: 'entity'` — the value both memories share. */
  entityValue?: string;
}

export interface SaveWithCandidatesDeps {
  memory: MemoryService;
  relations?: RelationsService;
  candidates?: CandidateOptions;
  repos?: Pick<Repositories, 'memory' | 'relations' | 'vectors' | 'entities'>;
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    projectId: string,
  ) => Promise<boolean>;
}

export async function saveMemoryWithCandidates(
  deps: SaveWithCandidatesDeps,
  input: SaveMemoryInput,
  scope: Scope,
): Promise<{
  memory: Awaited<ReturnType<MemoryService['save']>>;
  supersededByTopicKey: Awaited<ReturnType<MemoryService['save']>> | null;
  candidates: SaveTimeCandidateView[];
  candidatesDetected: number;
}> {
  const { memory: m, supersededByTopicKey } = deps.memory.saveWithTopicKey(input, scope);

  const extractedEntities: ExtractedEntity[] = extractEntities(m.title, m.content);

  let candidates: SaveTimeCandidateView[] = [];
  let candidatesDetected = 0;
  if (deps.repos && deps.relations && deps.candidates && deps.candidates.perSaveMax > 0) {
    try {
      if (deps.embedNow) await deps.embedNow(m.id, m.title, m.content, scope.projectId);
      const found = findSaveTimeCandidates(deps.repos, m, deps.candidates, extractedEntities);
      candidatesDetected = found.detected;
      for (const c of found.candidates) {
        const row = deps.relations.createPending({
          sourceId: m.id,
          targetId: c.targetId,
        });
        candidates.push({
          judgmentId: row.judgmentId,
          targetId: c.targetId,
          title: c.title,
          snippet: c.snippet,
          similarity: c.similarity,
          source: c.source,
          topicKey: c.topicKey,
          ...(c.entityValue ? { entityValue: c.entityValue } : {}),
        });
      }
    } catch {
      candidates = [];
      candidatesDetected = 0;
    }
  }

  if (deps.repos) {
    try {
      deps.repos.entities.linkMemory(m.id, scope.projectId, extractedEntities, m.createdAt);
    } catch {
      // Extraction/linking failure must never fail the save.
    }
  }

  return { memory: m, supersededByTopicKey, candidates, candidatesDetected };
}

async function handleSave(
  deps: MemoryToolDeps,
  args: {
    type: (typeof MEMORY_TYPES)[number];
    title: string;
    content: string;
    tags?: string[];
    topic_key?: string;
    sessionId?: string;
  },
) {
  const ctx = getRequestContext();

  let resolved: EffectiveScope;
  try {
    resolved = await resolveEffectiveScope(deps);
    assertAuthorized('write', resolved.scope, deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const { scope, project: activeProject } = resolved;

  let resolvedSessionId: string | null;
  try {
    resolvedSessionId = resolveActiveSessionId(deps, scope.projectId, args.sessionId);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const input: SaveMemoryInput = {
    type: args.type,
    title: args.title,
    content: args.content,
    tags: args.tags,
    source: {
      tokenName: ctx.token.name,
      ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
    },
    sessionId: resolvedSessionId,
    topicKey: args.topic_key ?? null,
  };

  try {
    if (activeProject) deps.projects.assertWritable(activeProject.id);

    const {
      memory: m,
      candidates,
      candidatesDetected,
    } = await saveMemoryWithCandidates(deps, input, scope);

    return ok({
      id: m.id,
      status: m.status,
      createdAt: m.createdAt,
      candidates,
      judgmentRequired: candidates.length > 0,
      candidatesDetected,
    });
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}

const RELATION_EXPANSION_KINDS = new Set(['supersedes', 'superseded_by', 'conflicts_with']);
const RELATION_EXPANSION_CAP = 5;
const ENTITIES_PROJECTION_CAP = 10;

function annotationBudgetError(
  rowParam: 'limit' | 'ids',
  rows: number,
  perRow: number,
): ReturnType<typeof mcpError> | null {
  if (rows * perRow <= RELATION_ANNOTATION_RESPONSE_BUDGET) return null;
  const affordable = Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / perRow);
  return mcpError(
    'invalid_input',
    `${rowParam} ${rows} x relations_limit ${perRow} projects ${rows * perRow} annotations, over ` +
      `the ${RELATION_ANNOTATION_RESPONSE_BUDGET} a single response may carry. Either lower ` +
      `${rowParam} to ${affordable} at relations_limit ${perRow}, or keep ${rowParam} ${rows} at ` +
      `relations_limit ${Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / rows)} or below. For one ` +
      "memory's annotations at the maximum, use memory.get_batch with `ids: [id]` — it is exempt by " +
      'construction and returns each `reason` verbatim.',
  );
}

async function handleSearch(
  deps: MemoryToolDeps,
  args: {
    query?: string;
    entity?: string;
    type?: (typeof MEMORY_TYPES)[number];
    tag?: string;
    topic_key?: string;
    status?: (typeof MEMORY_STATUSES)[number];
    across_projects?: boolean;
    include_relations?: boolean;
    limit?: number;
    offset?: number;
    snippet?: number;
    fields?: string[];
    relations_limit?: number;
  },
) {
  let scope: Scope;
  let searchScope: SearchScope;
  try {
    const resolved = await resolveEffectiveScope(deps);
    scope = resolved.scope;
    assertAuthorized('read', scope, deps);
    searchScope = resolveSearchScope(deps, resolved, args.across_projects);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const searchedProjects =
    args.across_projects === true ? searchedProjectSlugs(deps.projects, searchScope) : null;

  const input: SearchMemoriesInput = {
    query: args.query,
    entity: args.entity,
    type: args.type,
    tag: args.tag,
    topicKey: args.topic_key,
    status: args.status,
    limit: args.limit,
    offset: args.offset,
  };

  const effectiveRows =
    args.limit ?? (args.entity === undefined ? DEFAULT_SEARCH_LIMIT : RANK_WINDOW_CEILING);
  const searchBudget = annotationBudgetError(
    'limit',
    effectiveRows,
    args.relations_limit ?? RELATION_ANNOTATION_DEFAULT,
  );
  if (searchBudget) return searchBudget;

  try {
    const { memories, abstained, abstainReason, gateShortened, viaEntity, entityIndexDraining } =
      await deps.memory.searchWithAbstention(input, searchScope);
    const entitiesByMemory = deps.repos
      ? deps.repos.entities.findEntitiesForMemories(memories.map((m) => m.id))
      : new Map<string, { kind: string; value: string }[]>();
    // Single JOIN against memory_relations — no N+1.
    const relations = deps.relations
      ? deps.relations.listForMemories(
          memories.map((m) => m.id),
          args.relations_limit ?? RELATION_ANNOTATION_DEFAULT,
        )
      : null;
    const review = deps.memory.reviewStateForMemories(memories);
    const fieldSet =
      args.fields && args.fields.length > 0
        ? new Set<string>(['id', 'type', 'title', ...args.fields])
        : null;
    if (fieldSet?.has('relations')) fieldSet.add('relationsTotal');
    if (fieldSet?.has('entities')) fieldSet.add('entitiesTotal');
    const formatRow = (m: (typeof memories)[number]): Record<string, unknown> => ({
      id: m.id,
      scope: m.scope,
      projectId: m.projectId,
      type: m.type,
      title: m.title,
      content: typeof args.snippet === 'number' ? snippet(m.content, args.snippet) : m.content,
      tags: m.tags,
      status: m.status,
      createdAt: m.createdAt,
      lastSeenAt: m.lastSeenAt,
      topicKey: m.topicKey,
    });

    // One-hop expansion is a capped, un-ranked appendix — never blended into `memories` nor counted against `limit`.
    let expanded: Record<string, unknown>[] | undefined;
    if (args.include_relations && relations) {
      const primaryIds = new Set(memories.map((m) => m.id));
      const seenTargets = new Set<string>();
      const candidates: { targetId: string; originId: string; relationKind: string }[] = [];
      outer: for (const m of memories) {
        for (const rel of relations.get(m.id)?.views ?? []) {
          if (!RELATION_EXPANSION_KINDS.has(rel.kind)) continue;
          if (primaryIds.has(rel.targetId) || seenTargets.has(rel.targetId)) continue;
          seenTargets.add(rel.targetId);
          candidates.push({ targetId: rel.targetId, originId: m.id, relationKind: rel.kind });
          if (candidates.length >= RELATION_EXPANSION_CAP) break outer;
        }
      }
      if (candidates.length > 0) {
        const expandedRows = deps.memory.getMany(
          candidates.map((c) => c.targetId),
          scope,
        );
        const rowById = new Map(expandedRows.map((row) => [row.id, row]));
        expanded = candidates
          .map((c) => {
            const row = rowById.get(c.targetId);
            if (!row) return null;
            return { ...formatRow(row), expandedFrom: c.originId, relationKind: c.relationKind };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);
      }
    }

    return ok({
      count: memories.length,
      memories: memories.map((m) => {
        const r = review.get(m.id);
        const ents = entitiesByMemory.get(m.id) ?? [];
        const annotations = relations?.get(m.id);
        const full: Record<string, unknown> = {
          ...formatRow(m),
          relations: boundAnnotationReasons(annotations?.views ?? [], ANNOTATION_REASON_CHARS),
          relationsTotal: annotations?.total ?? 0,
          ...projectEntities(ents, ENTITIES_PROJECTION_CAP),
          ...(r && r.reviewState !== null
            ? { reviewState: r.reviewState, reviewAfter: r.reviewAfter ?? null }
            : {}),
        };
        if (!fieldSet) return full;
        return Object.fromEntries(Object.entries(full).filter(([k]) => fieldSet.has(k)));
      }),
      ...(expanded ? { expanded } : {}),
      ...(searchedProjects ? { searchedProjects } : {}),
      ...(searchedProjects && searchedProjects.length > 1 ? { widened: true } : {}),
      abstained,
      ...(abstainReason ? { abstainReason } : {}),
      ...(gateShortened ? { gateShortened } : {}),
      ...(viaEntity ? { viaEntity } : {}),
      ...(entityIndexDraining ? { entityIndexDraining } : {}),
    });
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}

async function handleGet(deps: MemoryToolDeps, args: z.infer<z.ZodObject<typeof memoryGetSchema>>) {
  if (
    args.ids !== undefined
      ? args.from !== undefined || args.to !== undefined
      : args.from === undefined
  ) {
    return mcpError('invalid_input', 'Provide either ids or from/to, never both.');
  }
  try {
    const { scope } = await resolveEffectiveScope(deps);
    assertAuthorized('read', scope, deps);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 20;
    const ids = args.ids ? [...new Set(args.ids)] : null;
    const selection = ids
      ? null
      : deps.memory.forPeriod(
          scope,
          new Date(args.from!),
          args.to ? new Date(args.to) : new Date(),
          limit,
          offset,
        );
    const total = ids?.length ?? selection!.total;
    const page = ids ? ids.slice(offset, offset + limit) : selection!.ids;
    const errors: z.infer<typeof memoryGetOutput.errors> = [];
    const histories = [];
    for (const id of page) {
      try {
        const history = deps.memory.getHistory(id, scope);
        if (history) histories.push(history);
        else errors.push({ id, code: 'not_found', message: 'Item not found.' });
      } catch (err) {
        errors.push({ id, ...itemError(err, deps.logInternalError) });
      }
    }
    const rows = histories.map((h) => h.memory);
    const relations = deps.relations?.listForMemories(
      rows.map((m) => m.id),
      args.relations_limit ?? RELATION_ANNOTATION_DEFAULT,
    );
    const entities = deps.repos?.entities.findEntitiesForMemories(rows.map((m) => m.id));
    const review = deps.memory.reviewStateForMemories(rows);
    const memories = [];
    for (const h of histories) {
      const m = h.memory;
      try {
        const annotations = relations?.get(m.id);
        const r = review.get(m.id);
        const entry = {
          id: m.id,
          scope: m.scope,
          projectId: m.projectId,
          type: m.type,
          title: m.title,
          content: m.content,
          tags: m.tags,
          status: m.status,
          replaces: m.replaces,
          createdAt: m.createdAt,
          lastSeenAt: m.lastSeenAt,
          topicKey: m.topicKey,
          head: {
            id: h.head.id,
            title: h.head.title,
            content: h.head.content,
            status: h.head.status,
          },
          predecessors: h.predecessors,
          predecessorCount: h.predecessorCount,
          truncated: h.truncated,
          headTruncated: h.headTruncated,
          confirmationCount: h.confirmationCount,
          relations:
            page.length === 1
              ? (annotations?.views ?? [])
              : boundAnnotationReasons(annotations?.views ?? [], ANNOTATION_REASON_CHARS),
          relationsTotal: annotations?.total ?? 0,
          ...projectEntities(entities?.get(m.id) ?? [], ENTITIES_PROJECTION_CAP),
          ...(r && r.reviewState !== null
            ? {
                reviewState: r.reviewState,
                reviewAfter: r.reviewAfter ?? null,
                reviewEscalated: r.reviewEscalated,
              }
            : {}),
        };
        deps.memory.recordAccess(h.head.id, scope);
        memories.push(entry);
      } catch (err) {
        errors.push({ id: m.id, ...itemError(err, deps.logInternalError) });
      }
    }
    errors.sort((a, b) => page.indexOf(a.id) - page.indexOf(b.id));
    const nextOffset = offset + page.length < total ? offset + page.length : null;
    return batchResult({ memories, errors, total, nextOffset }, memories.length, errors);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}

async function handleConfirm(
  deps: MemoryToolDeps,
  args: z.infer<z.ZodObject<typeof memoryConfirmSchema>>,
) {
  const ctx = getRequestContext();
  try {
    const { scope } = await resolveEffectiveScope(deps);
    assertAuthorized('write', scope, deps);
    const sessionId = resolveActiveSessionId(deps, scope.projectId, args.sessionId) ?? undefined;
    const { confirmed, headTruncated } = deps.memory.confirmMany(args.ids, scope, {
      source: { tokenName: ctx.token.name },
      sessionId,
      verdict: args.verdict,
      reason: args.reason,
    });
    return ok({ ok: true, confirmed, ...(headTruncated ? { headTruncated } : {}) });
  } catch (err) {
    if (isDomainError(err) && err.code === 'memory_not_found')
      return mcpError('not_found', 'memory not found');
    return errToMcp(err, deps.logInternalError);
  }
}

async function handleArchive(deps: MemoryToolDeps, args: { id: string }) {
  try {
    const { scope } = await resolveEffectiveScope(deps);
    assertAuthorized('write', scope, deps);
    deps.memory.archive(args.id, scope);
    return ok({ ok: true, id: args.id, status: 'archived' as const });
  } catch (err) {
    if (isDomainError(err) && err.code === 'memory_not_found') {
      return mcpError('not_found', 'memory not found');
    }
    return errToMcp(err, deps.logInternalError);
  }
}

const CONTEXT_SNIPPET_CHARS = 350;
const NEEDS_REVIEW_MAX = 3;

/** Small and separate from `memoriesLimit` so enabling relevance never halves the recency channel (design.md Open Questions). */
export const RELEVANCE_LIMIT = 5;

function deriveFocusSeed(
  deps: MemoryToolDeps,
  scope: Scope,
  recentPrompts: { content: string }[],
): string | undefined {
  const parts: string[] = [];
  const projectId = scope.projectId;
  const project = projectId ? deps.projects.getById(projectId) : undefined;
  if (project) parts.push(project.displayName ?? project.slug);

  if (deps.router && deps.agentSessions) {
    const key = routerKey();
    const routerHit = key ? deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId : null;
    const session = routerHit
      ? deps.agentSessions.getById(routerHit)
      : deps.agentSessions.findActiveForTransport({
          tokenId: getRequestContext().token.id,
          projectId,
        });
    if (session?.title) parts.push(session.title);
  }

  if (recentPrompts[0]) parts.push(recentPrompts[0].content);

  const seed = parts.join(' ').trim();
  return seed.length > 0 ? seed : undefined;
}

async function handleContext(
  deps: MemoryToolDeps,
  args: {
    sessions?: number;
    prompts?: number;
    memories?: number;
    judgments?: number;
    includeArchived?: boolean;
    focus?: string;
  },
) {
  if (!deps.repos || !deps.agentSessions || !deps.prompts || !deps.router) {
    return mcpError('internal_error', 'memory.context is not wired with its required dependencies');
  }
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const sessionsLimit = clamp(args.sessions ?? 3, 0, CONTEXT_SESSIONS_MAX);
  const memoriesLimit = clamp(args.memories ?? 10, 0, CONTEXT_MEMORIES_MAX);
  const includeArchived = args.includeArchived === true;

  const recentSessions = deps.agentSessions
    .recentForContext({
      projectId: scope.projectId,
      limit: sessionsLimit,
    })
    .map((s) => ({
      id: s.id,
      agent: s.agent,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      title: s.titleFinal ? s.title : null,
      summary: s.summary && s.summaryFinal ? snippet(s.summary, CONTEXT_SNIPPET_CHARS) : null,
    }));

  const recentMemories = deps.repos.memory
    .recentForContext({
      projectId: scope.projectId,
      includeArchived,
      limit: memoriesLimit,
    })
    .map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      snippet: snippet(m.content, CONTEXT_SNIPPET_CHARS),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      topicKey: m.topicKey,
    }));

  const promptsLimit = clamp(args.prompts ?? 5, 0, CONTEXT_PROMPTS_MAX);
  const recentPrompts = deps.prompts
    .recentForContext({
      projectId: scope.projectId,
      limit: promptsLimit,
    })
    .map((p) => ({
      id: p.id,
      content: snippet(p.content, CONTEXT_SNIPPET_CHARS),
      agent: p.agent,
      createdAt: p.createdAt,
    }));

  const focusText = args.focus?.trim() || deriveFocusSeed(deps, scope, recentPrompts);
  let relevantMemories: {
    id: string;
    type: string;
    title: string;
    snippet: string;
    status: string;
    createdAt: string;
    topicKey: string | null;
    via: 'entity' | 'ranked';
  }[] = [];
  let rankedPass: SearchVerdict | undefined;
  if (focusText) {
    const byId = new Map<string, { memory: Memory; via: 'entity' | 'ranked' }>();
    if (deps.repos) {
      for (const { memories } of iterateEntityMatches(deps.repos, {
        scope,
        seedText: focusText,
        limit: RELEVANCE_LIMIT,
        shouldContinue: () => byId.size < RELEVANCE_LIMIT,
      })) {
        for (const r of memories) {
          if (byId.size >= RELEVANCE_LIMIT) break;
          if (!byId.has(r.id)) byId.set(r.id, { memory: r, via: 'entity' });
        }
      }
    }
    if (byId.size < RELEVANCE_LIMIT) {
      const pass = await deps.memory.searchWithAbstention(
        { query: focusText, limit: RELEVANCE_LIMIT },
        scope,
      );
      rankedPass = {
        abstained: pass.abstained,
        abstainReason: pass.abstainReason,
        gateShortened: pass.gateShortened,
      };
      for (const r of pass.memories) {
        if (byId.size >= RELEVANCE_LIMIT) break;
        if (!byId.has(r.id)) byId.set(r.id, { memory: r, via: 'ranked' });
      }
    }
    relevantMemories = [...byId.values()].map(({ memory: m, via }) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      snippet: snippet(m.content, CONTEXT_SNIPPET_CHARS),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      topicKey: m.topicKey,
      via,
    }));
  }

  const now = Date.now();
  const wantsInventory = args.judgments !== undefined;
  const judgmentsLimit = clamp(
    args.judgments ?? PENDING_JUDGMENTS_DEFAULT,
    0,
    PENDING_JUDGMENTS_MAX,
  );
  const pendingCutoff = now - (deps.orphanAfterMs ?? 86_400_000);
  const relationsScope = { projectId: scope.projectId };
  const pendingJudgments = deps.repos.relations
    .listPendingInScope({
      ...relationsScope,
      cutoffMs: wantsInventory ? null : pendingCutoff,
      limit: judgmentsLimit,
    })
    .map((r) => ({
      judgmentId: r.judgmentId,
      sourceId: r.sourceId,
      targetId: r.targetId,
      sourceTitle: r.sourceTitle,
      targetTitle: r.targetTitle,
      sourceSnippet: snippet(r.sourceContent, CONTEXT_SNIPPET_CHARS),
      targetSnippet: snippet(r.targetContent, CONTEXT_SNIPPET_CHARS),
      ageMs: now - r.createdAt.getTime(),
    }));
  const pendingJudgmentsTotal = deps.repos.relations.countPendingInScope(relationsScope);

  const needsReview = deps.memory.needsReviewForContext(scope, NEEDS_REVIEW_MAX).map((it) => ({
    id: it.memory.id,
    type: it.memory.type,
    title: it.memory.title,
    snippet: snippet(it.memory.content, CONTEXT_SNIPPET_CHARS),
    reviewAfter: it.reviewAfter.toISOString(),
    ageMs: now - it.reviewBaseline.getTime(),
  }));
  const needsReviewTotal = deps.memory.countNeedsReview(scope);

  return ok({
    scope: `project:${scope.projectId}`,
    recentSessions,
    recentPrompts,
    recentMemories,
    relevantMemories,
    ...(rankedPass ? { rankedPass } : {}),
    pendingJudgments,
    pendingJudgmentsTotal,
    needsReview,
    needsReviewTotal,
  });
}

async function handleTimeline(
  deps: MemoryToolDeps,
  args: { memoryId: string; before?: number; after?: number },
) {
  if (!deps.repos || !deps.router) {
    return mcpError(
      'internal_error',
      'memory.timeline is not wired with its required dependencies',
    );
  }
  const before = clamp(args.before ?? 5, 0, TIMELINE_WINDOW_MAX);
  const after = clamp(args.after ?? 5, 0, TIMELINE_WINDOW_MAX);
  if (before + after > TIMELINE_WINDOW_MAX) {
    return mcpError(
      'invalid_input',
      `memory.timeline: before + after exceeds ${TIMELINE_WINDOW_MAX}; for larger windows use memory.search`,
    );
  }
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  const target = deps.memory.get(args.memoryId, scope);
  if (!target) {
    return mcpError('not_found', `memory '${args.memoryId}' not found in this scope`);
  }
  const t = target.memory;

  if (t.sessionId) {
    const neighborScope = { projectId: scope.projectId };
    const beforeRows = deps.repos.memory.sessionNeighbors({
      ...neighborScope,
      sessionId: t.sessionId,
      pivotCreatedAt: t.createdAt,
      pivotId: t.id,
      direction: 'before',
      limit: before,
    });
    const afterRows = deps.repos.memory.sessionNeighbors({
      ...neighborScope,
      sessionId: t.sessionId,
      pivotCreatedAt: t.createdAt,
      pivotId: t.id,
      direction: 'after',
      limit: after,
    });
    return ok({
      target: { id: t.id, createdAt: t.createdAt },
      before: beforeRows.map(serializeMemory),
      after: afterRows.map(serializeMemory),
      fallback: null,
    });
  }

  // Fallback: ±2h window around created_at, scoped to (scope, project_id).
  const windowMs = 2 * 3600 * 1000;
  const targetMs = t.createdAt.getTime();
  const window = {
    projectId: scope.projectId,
    pivotId: t.id,
    loMs: targetMs - windowMs,
    hiMs: targetMs + windowMs,
    pivotMs: targetMs,
  };
  const beforeRows = deps.repos.memory.windowNeighbors({
    ...window,
    direction: 'before',
    limit: before,
  });
  const afterRows = deps.repos.memory.windowNeighbors({
    ...window,
    direction: 'after',
    limit: after,
  });
  return ok({
    target: { id: t.id, createdAt: t.createdAt },
    before: beforeRows.map(serializeMemory),
    after: afterRows.map(serializeMemory),
    fallback: 'time_window',
  });
}
