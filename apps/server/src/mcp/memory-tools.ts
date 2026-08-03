import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Memory,
  type MemoryScope,
} from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { extractEntities, type ExtractedEntity, projectEntities } from '../services/entities.js';
import { DomainError } from '../services/errors.js';
import { RANK_WINDOW_CEILING, type SearchVerdict } from '../services/hybrid-search.js';
import {
  DEFAULT_SEARCH_LIMIT,
  type MemoryService,
  type SaveMemoryInput,
  type SearchMemoriesInput,
} from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { PromptsService } from '../services/prompts.js';
import {
  ANNOTATION_REASON_CHARS,
  MULTI_ROW_ANNOTATION_DEFAULT,
  RELATION_ANNOTATION_MAX,
  RELATION_ANNOTATION_RESPONSE_BUDGET,
  SEARCH_LIMIT_MAX,
  type RelationsService,
} from '../services/relations.js';
import { findSaveTimeCandidates, type CandidateOptions } from '../services/save-time-candidates.js';
import { SCOPE_GLOBAL, type Scope } from '../services/scope.js';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  boundAnnotationReasons,
  clamp,
  isAuthorizedFor,
  isPathScoped,
  requireScope,
  resolveEffectiveScope,
  routerKey,
  serializeMemory,
  snippet,
  unresolvableSlugError,
} from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ok } from './result.js';

/**
 * Tool handlers backing the core memory tools: save / search / get / confirm
 * plus the memory-reading research tools context / timeline.
 *
 * Scope resolution happens here once and is then threaded into every
 * service call. The service layer enforces the scope at the SQL level
 * (rows outside scope are invisible) so handlers cannot leak by mistake.
 *
 * Path-scoping contract (also asserted by tests):
 *
 *   /mcp/<slug>  → scope = project:<id>
 *     - memory.save scope='global'  →  mcpError 'scope_locked'
 *     - memory.save scope='project' →  saved to that project
 *     - memory.search                →  only that project's memories
 *     - memory.get / .confirm        →  cross-scope ids are 'not_found'
 *
 *   /mcp  (no slug)            → scope = global (unless `project.use` ran)
 *     - memory.save scope='project' →  mcpError 'project_required'
 *                                     (unless `project.use` activated one
 *                                      for this transport — see
 *                                      `resolveEffectiveScope` in `_shared`)
 *     - memory.save scope='global'  →  saved as user-wide
 *     - memory.search                →  globals only (or the active project
 *                                       set via `project.use`)
 *     - memory.get / .confirm        →  project ids are 'not_found' (idem)
 */

const MEMORY_SCOPES = ['global', 'project'] as const;

/** An entry carries two snippets and two titles, ~2x a recentMemories row, so 50 costs about what `memories: 100` does. */
const PENDING_JUDGMENTS_MAX = 50;
/** A queue-depth warning, not a page of an inventory — the caller asks for inventory by passing a size. */
const PENDING_JUDGMENTS_DEFAULT = 5;

/** Per-surface `relations` defaults; the maximum and the multi-row default are shared. */
const RELATION_ANNOTATION_DEFAULT = MULTI_ROW_ANNOTATION_DEFAULT;
/** Single-id `memory.get` is the deliberate deep read, so it defaults to the maximum. */
const RELATION_ANNOTATION_DEFAULT_SINGLE = RELATION_ANNOTATION_MAX;

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
        'single-id `memory.get` reads one memory at the maximum and returns it verbatim.',
    );
}

export const memorySaveSchema = {
  scope: z.enum(MEMORY_SCOPES).default('project'),
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(100),
  content: z.string().min(1),
  tags: z.array(z.string()).max(64).optional(),
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
      'Exact-address lookup. Use INSTEAD of `query` whenever you have the literal identifier — a text query for one is noisy (`migrate.ts` also hits `migrate.ts.bak`, `#36` degrades to any "36"). Accepts a path, git SHA, URL, error code, ticket, CVE, IPv4, `.local`-style hostname, systemd unit, MAC, env var name, or UUID. Returns every linked memory in scope, chronological and unranked — no relevance cutoff, and with no `limit` the whole linked set (bounded at 400) rather than the 8-row ranked default. Narrows further with `status`, `type`, `tag`, `topic_key` and `include_global` (which is gated — see its own description); with `query` it narrows, never fuses. Unknown value returns empty rather than a degraded text search, so retry with `query` if it does — unless the response also carries `entityIndexDraining`, which means the index has not finished scanning this scope and the same lookup is worth repeating shortly.',
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
  include_global: z
    .boolean()
    .optional()
    .describe(
      "When scoped to a project, also include global memories in the results (e.g. user-wide preferences/conventions), on the ranked and entity branches alike. Silently ignored, never an error, on a path-scoped connection ('/mcp/<slug>'), on a global-scoped connection, or when this token is not authorized to read global.",
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
      "Truncate each result's `content` to this many characters (ellipsis appended) so a broad triage scan stays cheap; omit for full content, then drill in with memory.get.",
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
  id: z
    .string()
    .min(1)
    .optional()
    .describe('A single memory id. Provide exactly one of `id` or `ids`.'),
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Batch: fetch several memories by id in one scoped call. Out-of-scope/unknown ids come back in `notFound`. Provide exactly one of `id` or `ids`.',
    ),
  relations_limit: relationsLimitParam(
    `default ${RELATION_ANNOTATION_DEFAULT_SINGLE} with \`id\`, ${RELATION_ANNOTATION_DEFAULT} with \`ids\``,
  ),
};

export const memoryConfirmSchema = {
  id: z
    .string()
    .min(1)
    .optional()
    .describe('A single memory id. Provide exactly one of `id` or `ids`.'),
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Batch: record the same verdict over several memories in one call (e.g. re-affirm all of memory.context.needsReview). Provide exactly one of `id` or `ids`.',
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
  sessions: z.number().int().min(0).max(25).optional(),
  prompts: z.number().int().min(0).max(50).optional(),
  memories: z.number().int().min(0).max(100).optional(),
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
  before: z.number().int().min(0).max(50).optional(),
  after: z.number().int().min(0).max(50).optional(),
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
  // Identity fields are always present; the rest MAY be omitted by the
  // `fields` projection, and `content` MAY be truncated by `snippet`.
  id: z.string(),
  type: z.string(),
  title: z.string(),
  scope: z.string().optional(),
  projectId: z.string().nullable().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  lastSeenAt: z.string().nullable().optional(),
  topicKey: z.string().nullable().optional(),
  relations: z.array(relationView).optional(),
  /**
   * Annotations that exist for this memory before `relations_limit` bounds the
   * array above — never the array's length restated, so a bounded list is
   * `relationsTotal > relations.length` and needs no companion flag.
   */
  relationsTotal: z.number().optional(),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
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

/**
 * `SearchVerdict` in zod — the one declaration both surfaces that publish it
 * are built from, so `memory.search`'s wire names and `memory.context`'s cannot
 * drift apart. `z.literal(true)` mirrors the TS type: never emitted as `false`.
 */
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
  /** True when `entity` drove retrieval (exact-address, not ranked). */
  viaEntity: z.boolean().optional(),
  /**
   * Present only on an EMPTY entity lookup whose scope still has unscanned
   * memories: "not in the index" and "not indexed yet" are otherwise the same
   * empty response, and after an extractor recipe change the second one lasts
   * as long as the drain does.
   */
  entityIndexDraining: z.boolean().optional(),
};

export const memoryGetOutput = {
  // Single-id response (when `id` is provided). Optional so the same tool can
  // also return the batch shape below (when `ids` is provided).
  memory: z
    .object({
      id: z.string(),
      scope: z.string(),
      projectId: z.string().nullable(),
      type: z.string(),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()),
      status: z.string(),
      replaces: z.array(z.string()),
      createdAt: z.string(),
      topicKey: z.string().nullable(),
    })
    .optional(),
  head: z
    .object({ id: z.string(), title: z.string(), content: z.string(), status: z.string() })
    .optional(),
  // Bounded to the nearest predecessors (see PREDECESSOR_CAP); content is
  // intentionally omitted — titles are immutable-by-construction labels for
  // the omitted content. `truncated` is true when the reachable `replaces`
  // graph holds more predecessors than were returned.
  predecessors: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        createdAt: z.string(),
      }),
    )
    .optional(),
  predecessorCount: z.number().optional(),
  truncated: z.boolean().optional(),
  /** True when head resolution stopped at its hop cap without reaching an active row. */
  headTruncated: z.boolean().optional(),
  confirmationCount: z.number().optional(),
  relations: z.array(relationView).optional(),
  relationsTotal: z.number().optional(),
  // Single-id response's entities[] projection (bounded; see memoryRow for
  // the batch response's equivalent field).
  entities: z.array(entityRef).optional(),
  entitiesTotal: z.number().optional(),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
  /** True once the memory has sat in `needs_review` past its escalation window. */
  reviewEscalated: z.boolean().optional(),
  // Batch response (when `ids` is provided).
  memories: z.array(memoryRow).optional(),
  notFound: z.array(z.string()).optional(),
};

export const memoryConfirmOutput = {
  ok: z.literal(true),
  confirmed: z.number().optional(),
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
  /**
   * The ranked pass's own verdict. ABSENT when that pass never ran (no derivable
   * seed, or the entity pre-pass already filled the channel) — reporting
   * `abstained: false` for a search that never happened would assert a verdict
   * the server never measured. `gateShortened` is measured against the limit
   * THAT pass requested, so the channel can be full while it is set.
   */
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
  /**
   * Total in-scope ADJUDICABLE pending-judgment count (both endpoints still
   * `active`) — `pendingJudgments` above is a page,
   * and by default an AGED one, so its length says nothing about the queue.
   * Drain with `judgments: min(pendingJudgmentsTotal, PENDING_JUDGMENTS_MAX)`,
   * repeating while the total stays above 0: a total over the max is rejected
   * by the input schema before the handler's clamp can round it down.
   */
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
  /**
   * Total in-scope needs-review count — `needsReview` above is capped at
   * a handful of the oldest. Lets the agent tell a healthy corpus from a
   * collapsing one and batch-confirm via `memory.confirm({ids})` when deep.
   */
  needsReviewTotal: z.number(),
  clamped: z.boolean(),
};

export const timelineOutput = {
  target: z.object({ id: z.string(), createdAt: z.string() }),
  before: z.array(memoryNeighbor),
  after: z.array(memoryNeighbor),
  fallback: z.string().nullable(),
};

export interface MemoryToolDeps {
  memory: MemoryService;
  /** Optional — when present, save surfaces candidates + writes pending relations. */
  relations?: RelationsService;
  /** Optional — when present, controls candidate detection thresholds. */
  candidates?: CandidateOptions;
  /** Optional — repositories needed for save-time candidates + context/timeline reads. */
  repos?: Pick<Repositories, 'memory' | 'relations' | 'vectors' | 'entities'>;
  /**
   * Optional — embeds the just-saved row inline so vec candidate
   * detection has a self-vector to kNN from.
   */
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    scope: MemoryScope,
    projectId: string | null,
  ) => Promise<boolean>;
  /** Optional — required to evaluate the project-suggestion gate on save, and scope resolution for context/timeline. */
  router?: SessionRouter;
  /** Optional — required to evaluate the project-suggestion gate on save. */
  projects?: ProjectsService;
  /**
   * Optional — when present, `memory.save` attaches the most-recently-
   * active session row for `(tokenId, projectId)` to the memory when the
   * SessionRouter has no entry. This is the bridge that makes
   * HTTP-driven sessions (the plugin's hooks POSTing `/api/<slug>/sessions`)
   * show up as `memory.session_id` on subsequent MCP-side saves. Also used
   * by `memory.context` to surface recent sessions.
   */
  agentSessions?: AgentSessionsService;
  /** Optional — required by `memory.context` to surface recent prompts. */
  prompts?: PromptsService;
  /** Optional — pending relations older than this surface in `memory.context`. */
  orphanAfterMs?: number;
  /**
   * Optional — provides access to the active `McpServer` so handlers can
   * await (or trigger) roots discovery when no project is resolved yet.
   * Set by `createMcpServer` after construction.
   */
  getServer?: () => McpServer;
}

export function buildMemoryHandlers(deps: MemoryToolDeps) {
  return {
    save: handleSave.bind(null, deps),
    search: handleSearch.bind(null, deps),
    get: handleGet.bind(null, deps),
    confirm: handleConfirm.bind(null, deps),
    archive: handleArchive.bind(null, deps),
    context: handleContext.bind(null, deps),
    timeline: handleTimeline.bind(null, deps),
  };
}

/**
 * Resolve the active Rembric session id for a memory write.
 *
 * Sources, in order of precedence:
 *   0. An explicit `sessionId` passed by the caller.
 *   1. The `SessionRouter` entry for `(tokenId, mcpSessionId)` — set by
 *      an explicit `memory.session_start` call over MCP.
 *   2. The UNAMBIGUOUS `status='active'` row for `(tokenId, projectId)` —
 *      captures sessions created out-of-band by the plugin's HTTP hooks
 *      (`POST /api/<slug>/sessions`); returns nothing (never guesses by
 *      recency) when more than one is live — see
 *      `AgentSessionsService.findActiveForTransport`.
 *
 * Returns null when no active session can be resolved (the memory is
 * saved with `session_id = NULL`, the back-compat path for clients that
 * neither run the plugin nor call `memory.session_start`). Whenever a
 * session id resolves, its activity clock is bumped.
 */
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
    scope: MemoryScope,
    projectId: string | null,
  ) => Promise<boolean>;
}

/**
 * The one save-time curation path: topic_key upsert bookkeeping, inline
 * embedding, and candidate detection + pending-relation creation. Shared by
 * `memory.save` and `memory.capture_passive` so bulk-captured rows go
 * through the identical pipeline instead of a bare insert — see
 * `openspec/changes/fix-audited-defects`.
 */
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

  // Deterministic entity extraction — pure, no I/O. Linking (below) is
  // deferred until AFTER candidate detection reads: the just-saved row must
  // not count toward its own entity's rarity stats, or a save can tip a
  // borderline-common entity over the gate one save sooner than it should.
  const extractedEntities: ExtractedEntity[] = extractEntities(m.title, m.content);

  // Save-time candidate detection: surface up to N similar active
  // memories so the agent can judge them while the context is fresh.
  let candidates: SaveTimeCandidateView[] = [];
  let candidatesDetected = 0;
  if (deps.repos && deps.relations && deps.candidates && deps.candidates.perSaveMax > 0) {
    try {
      // Give the new row its vector before detection runs, so the vec
      // pass has a self-vector to kNN from (model is warm by boot
      // contract; on failure detection degrades to FTS5 for this save).
      if (deps.embedNow) await deps.embedNow(m.id, m.title, m.content, m.scope, m.projectId);
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
      // Candidate detection is best-effort. A failure here (e.g. the
      // FTS5 query rejects an unusual token) must not prevent the
      // save from returning a usable response.
      candidates = [];
      candidatesDetected = 0;
    }
  }

  // Link the just-saved row into the entity index now that candidate
  // detection has already read the prior state. Independent of candidate
  // detection being enabled at all (the index itself must stay current) —
  // best-effort, never fails the save.
  if (deps.repos) {
    try {
      deps.repos.entities.linkMemory(m.id, m.scope, m.projectId, extractedEntities, m.createdAt);
    } catch {
      // Extraction/linking failure must never fail the save.
    }
  }

  return { memory: m, supersededByTopicKey, candidates, candidatesDetected };
}

async function handleSave(
  deps: MemoryToolDeps,
  args: {
    scope: 'global' | 'project';
    type: (typeof MEMORY_TYPES)[number];
    title: string;
    content: string;
    tags?: string[];
    topic_key?: string;
    sessionId?: string;
  },
) {
  const ctx = getRequestContext();

  // Path-scoped connections forbid global writes.
  if (isPathScoped() && args.scope === 'global') {
    return mcpError(
      'scope_locked',
      `This MCP connection is path-scoped to project '${ctx.requestedSlug}'. ` +
        'Global writes are not permitted and user-wide memory is not reachable ' +
        "here. Save this as a project memory instead (scope='project'), or ask " +
        "your operator to add a path-less '/mcp' entry for user-wide memory.",
    );
  }

  // Path-scoped to a slug that doesn't exist: writes need an existing project.
  if (ctx.requestedSlug !== null && !ctx.project && args.scope === 'project') {
    return errToMcp(unresolvableSlugError(ctx.requestedSlug, deps.projects));
  }

  // Pick up the project the agent already activated via `project.use` on
  // this transport (or that roots discovery activated), in addition to the
  // URL-derived `ctx.project`. Mirrors the precedence used by
  // `handleSessionStart` and `project.current`.
  const { scope, project: activeProject } = await resolveEffectiveScope(deps);

  // When roots-based discovery surfaced suggestions the agent has not yet
  // acted on, refuse the silent fallback to global. The agent must either
  // pass scope='global' explicitly, or call project.use({slug, autocreate}).
  if (!activeProject && args.scope === 'project' && deps.router && deps.projects) {
    const pending = pendingSuggestionGate(ctx, { router: deps.router, projects: deps.projects });
    if (pending) {
      return mcpError('project_suggestion_pending', suggestionPendingMessage(), {
        suggestedSlugs: pending,
      });
    }
  }

  // Unscoped connections cannot persist project memories without a target.
  if (!activeProject && args.scope === 'project') {
    return mcpError(
      'project_required',
      'This MCP connection has no active project. To save a project memory, either: ' +
        "(a) reconnect at '/mcp/<your-project-slug>' (recommended for per-project setups), " +
        '(b) call project.use({slug}) to set a project for this session, ' +
        "or (c) set scope='global' to save as a user-wide memory instead.",
    );
  }

  try {
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err);
  }

  let resolvedSessionId: string | null;
  try {
    resolvedSessionId = resolveActiveSessionId(
      deps,
      scope.kind === 'project' ? scope.projectId : null,
      args.sessionId,
    );
  } catch (err) {
    return errToMcp(err);
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
    // Archived projects reject new writes (projects spec, "Archiving a
    // project"). Enforced here rather than in resolveEffectiveScope so the
    // read paths (search/get) keep returning an archived project's memories.
    if (activeProject) deps.projects?.assertWritable(activeProject.id);

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
    return errToMcp(err);
  }
}

const RELATION_EXPANSION_KINDS = new Set(['supersedes', 'superseded_by', 'conflicts_with']);
const RELATION_EXPANSION_CAP = 5;
/**
 * 10 sits above the 99th percentile of production-shaped extraction (measured
 * p99 = 8, max 23), so it withholds something on 0.7% of rows. Raising it to 25
 * would cover the observed maximum and add nothing to the other 99.3%. Changing
 * it requires a fresh distribution — see the `memory` spec's constants rule.
 */
const ENTITIES_PROJECTION_CAP = 10;

/**
 * The aggregate annotation budget: `rows × per-row bound`, checked BEFORE any query.
 *
 * Rejected rather than clamped, matching the per-row bound's published rule — a
 * silently smaller answer is worse than a refused one, because a caller that asked
 * for 50 annotations and got 10 has no way to tell. The message has to name both
 * parameters and a legal trade, since the caller cannot see the budget otherwise.
 */
function annotationBudgetError(
  rowParam: 'limit' | 'ids',
  rows: number,
  perRow: number,
): ReturnType<typeof mcpError> | null {
  // `rows` is the EFFECTIVE count. On the entity branch with no `limit` that is
  // `RANK_WINDOW_CEILING`, so the message quotes a number the caller never typed —
  // which is the point: it is what the server would have served.
  if (rows * perRow <= RELATION_ANNOTATION_RESPONSE_BUDGET) return null;
  const affordable = Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / perRow);
  return mcpError(
    'invalid_input',
    `${rowParam} ${rows} x relations_limit ${perRow} projects ${rows * perRow} annotations, over ` +
      `the ${RELATION_ANNOTATION_RESPONSE_BUDGET} a single response may carry. Either lower ` +
      `${rowParam} to ${affordable} at relations_limit ${perRow}, or keep ${rowParam} ${rows} at ` +
      `relations_limit ${Math.floor(RELATION_ANNOTATION_RESPONSE_BUDGET / rows)} or below. For one ` +
      "memory's annotations at the maximum, use memory.get with a single `id` — it is exempt by " +
      'construction and returns each `reason` verbatim.',
  );
}

/** Denial narrows the result rather than rejecting: the caller is authorized for every row it receives. */
function resolveIncludeGlobal(requested: boolean | undefined): boolean {
  if (!requested) return false;
  return !isPathScoped() && isAuthorizedFor('read', SCOPE_GLOBAL);
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
    include_global?: boolean;
    include_relations?: boolean;
    limit?: number;
    offset?: number;
    snippet?: number;
    fields?: string[];
    relations_limit?: number;
  },
) {
  let scope: Scope;
  try {
    scope = (await resolveEffectiveScope(deps)).scope;
    assertAuthorized('read', scope, deps);
  } catch (err) {
    return errToMcp(err);
  }

  const input: SearchMemoriesInput = {
    query: args.query,
    entity: args.entity,
    type: args.type,
    tag: args.tag,
    topicKey: args.topic_key,
    status: args.status,
    limit: args.limit,
    offset: args.offset,
    includeGlobal: resolveIncludeGlobal(args.include_global),
  };

  // The EFFECTIVE row count, not the declared one. An omitted `limit` means 8 rows
  // on the ranked branch but `RANK_WINDOW_CEILING` on the entity branch, which is
  // specified as complete within scope — budgeting against the declared value let
  // `{ entity, relations_limit: 50 }` through and serve 20 000 annotations.
  const effectiveRows =
    args.limit ?? (args.entity !== undefined ? RANK_WINDOW_CEILING : DEFAULT_SEARCH_LIMIT);
  const searchBudget = annotationBudgetError(
    'limit',
    effectiveRows,
    args.relations_limit ?? RELATION_ANNOTATION_DEFAULT,
  );
  if (searchBudget) return searchBudget;

  try {
    const { memories, abstained, abstainReason, gateShortened, viaEntity, entityIndexDraining } =
      await deps.memory.searchWithAbstention(input, scope);
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
    // Derived review metadata (batched confirmation lookup) — informational
    // only; never affects ordering or which rows are returned.
    const review = deps.memory.reviewStateForMemories(memories);
    // Optional projection (selection/ordering/scope are already final and are
    // never affected): truncate content to `snippet` chars, then keep only the
    // requested `fields` plus the always-present identity fields.
    const fieldSet =
      args.fields && args.fields.length > 0
        ? new Set<string>(['id', 'type', 'title', ...args.fields])
        : null;
    // A projected bounded list keeps its total: the two are one field's worth of
    // meaning, and both are specified as present WHENEVER the list is, so a
    // projection that dropped the count would make truncation undetectable.
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
      abstained,
      ...(abstainReason ? { abstainReason } : {}),
      ...(gateShortened ? { gateShortened } : {}),
      ...(viaEntity ? { viaEntity } : {}),
      ...(entityIndexDraining ? { entityIndexDraining } : {}),
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleGet(
  deps: MemoryToolDeps,
  args: { id?: string; ids?: string[]; relations_limit?: number },
) {
  try {
    const { scope } = await resolveEffectiveScope(deps);

    const hasId = typeof args.id === 'string' && args.id.length > 0;
    const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
    if (hasId === hasIds) {
      return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
    }

    assertAuthorized('read', scope, deps);
    if (args.ids !== undefined) {
      const batchBudget = annotationBudgetError(
        'ids',
        args.ids.length,
        args.relations_limit ?? RELATION_ANNOTATION_DEFAULT,
      );
      if (batchBudget) return batchBudget;
      // Batch: scoped + ordered; out-of-scope / unknown ids land in
      // `notFound` and never leak content.
      const rows = deps.memory.getMany(args.ids, scope);
      const relations = deps.relations
        ? deps.relations.listForMemories(
            rows.map((m) => m.id),
            args.relations_limit ?? RELATION_ANNOTATION_DEFAULT,
          )
        : null;
      const entitiesByMemory = deps.repos
        ? deps.repos.entities.findEntitiesForMemories(rows.map((m) => m.id))
        : new Map<string, { kind: string; value: string }[]>();
      const found = new Set(rows.map((m) => m.id));
      return ok({
        memories: rows.map((m) => {
          const ents = entitiesByMemory.get(m.id) ?? [];
          const annotations = relations?.get(m.id);
          return {
            id: m.id,
            scope: m.scope,
            projectId: m.projectId,
            type: m.type,
            title: m.title,
            content: m.content,
            tags: m.tags,
            status: m.status,
            createdAt: m.createdAt,
            lastSeenAt: m.lastSeenAt,
            topicKey: m.topicKey,
            relations: boundAnnotationReasons(annotations?.views ?? [], ANNOTATION_REASON_CHARS),
            relationsTotal: annotations?.total ?? 0,
            ...projectEntities(ents, ENTITIES_PROJECTION_CAP),
          };
        }),
        notFound: args.ids.filter((id) => !found.has(id)),
      });
    }

    if (args.id === undefined) {
      return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
    }
    const result = deps.memory.get(args.id, scope);
    if (!result) {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }
    const annotations = deps.relations?.listForMemory(
      result.memory.id,
      args.relations_limit ?? RELATION_ANNOTATION_DEFAULT_SINGLE,
    );
    const ents = deps.repos ? deps.repos.entities.findEntitiesForMemory(result.memory.id) : [];
    return ok({
      memory: {
        id: result.memory.id,
        scope: result.memory.scope,
        projectId: result.memory.projectId,
        type: result.memory.type,
        title: result.memory.title,
        content: result.memory.content,
        tags: result.memory.tags,
        status: result.memory.status,
        replaces: result.memory.replaces,
        createdAt: result.memory.createdAt,
        topicKey: result.memory.topicKey,
      },
      head: {
        id: result.head.id,
        title: result.head.title,
        content: result.head.content,
        status: result.head.status,
      },
      // Pass-through: the service already projects exactly these four fields, so
      // re-mapping here would only be a second place for them to drift.
      predecessors: result.predecessors,
      predecessorCount: result.predecessorCount,
      truncated: result.truncated,
      headTruncated: result.headTruncated,
      confirmationCount: result.confirmationCount,
      relations: annotations?.views ?? [],
      relationsTotal: annotations?.total ?? 0,
      ...projectEntities(ents, ENTITIES_PROJECTION_CAP),
      ...(result.reviewState !== null
        ? {
            reviewState: result.reviewState,
            reviewAfter: result.reviewAfter ?? null,
            reviewEscalated: result.reviewEscalated,
          }
        : {}),
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleConfirm(
  deps: MemoryToolDeps,
  args: {
    id?: string;
    ids?: string[];
    sessionId?: string;
    verdict?: 'affirm' | 'refute';
    reason?: string;
  },
) {
  const ctx = getRequestContext();

  try {
    const { scope } = await resolveEffectiveScope(deps);

    const hasId = typeof args.id === 'string' && args.id.length > 0;
    const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
    if (hasId === hasIds) {
      return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
    }

    assertAuthorized('write', scope, deps);
    // An explicit sessionId wins; otherwise fall back to the unambiguous
    // active session for (token, project) — either way
    // confirmations.session_id stops being permanently NULL. See
    // openspec/changes/fix-audited-defects.
    const confirmProjectId = scope.kind === 'project' ? scope.projectId : null;
    let sessionId: string | undefined;
    try {
      sessionId = resolveActiveSessionId(deps, confirmProjectId, args.sessionId) ?? undefined;
    } catch (err) {
      return errToMcp(err);
    }
    const opts = {
      source: { tokenName: ctx.token.name },
      sessionId,
      verdict: args.verdict,
      reason: args.reason,
    };
    if (args.ids !== undefined) {
      const { confirmed, headTruncated } = deps.memory.confirmMany(args.ids, scope, opts);
      return ok({ ok: true, confirmed, ...(headTruncated ? { headTruncated } : {}) });
    }
    if (args.id === undefined) {
      return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
    }
    const { headTruncated } = deps.memory.confirm(args.id, scope, opts);
    return ok({ ok: true, ...(headTruncated ? { headTruncated } : {}) });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'memory_not_found') {
      return mcpError('not_found', 'memory not found');
    }
    return errToMcp(err);
  }
}

async function handleArchive(deps: MemoryToolDeps, args: { id: string }) {
  try {
    const { scope } = await resolveEffectiveScope(deps);
    assertAuthorized('write', scope, deps);
    deps.memory.archive(args.id, scope);
    return ok({ ok: true, id: args.id, status: 'archived' as const });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'memory_not_found') {
      return mcpError('not_found', 'memory not found');
    }
    return errToMcp(err);
  }
}

const CONTEXT_SNIPPET_CHARS = 350;
// needsReview is recurring (every memory.context) and usually populated, so
// it is kept frugal on COUNT (only the 3 oldest). Its snippet uses the same
// CONTEXT_SNIPPET_CHARS cap as the other lists for a homogeneous payload.
const NEEDS_REVIEW_MAX = 3;

/** Small and separate from `memoriesLimit` so enabling relevance never halves the recency channel (design.md Open Questions). */
export const RELEVANCE_LIMIT = 5;

/**
 * When `focus` is absent, derive a seed from signals the server already
 * holds: the active project's label, the current (in-progress, unsummarized
 * — so not in `recentSessions`) session's placeholder title (carries the
 * cwd basename), and the most recent curated prompt. Returns undefined when
 * nothing usable is derivable, so the caller can leave `relevantMemories`
 * empty rather than running a query on empty text.
 */
function deriveFocusSeed(
  deps: MemoryToolDeps,
  scope: Scope,
  recentPrompts: { content: string }[],
): string | undefined {
  const parts: string[] = [];
  const projectId = scope.kind === 'project' ? scope.projectId : null;
  const project = projectId ? deps.projects?.getById(projectId) : undefined;
  if (project) parts.push(project.displayName ?? project.slug);

  if (deps.router && deps.agentSessions) {
    // Same precedence as `resolveSessionId`, but inlined to reuse the row
    // `findActiveForTransport` already fetches instead of re-fetching it by
    // id — this runs on every unfocused memory.context call.
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
    return errToMcp(err);
  }
  const sessionsLimit = clamp(args.sessions ?? 3, 0, 25);
  const memoriesLimit = clamp(args.memories ?? 10, 0, 100);
  const clamped =
    (args.sessions ?? 0) > 25 ||
    (args.prompts ?? 0) > 50 ||
    (args.memories ?? 0) > 100 ||
    (args.judgments ?? 0) > PENDING_JUDGMENTS_MAX;
  const includeArchived = args.includeArchived === true;

  const recentSessions = deps.agentSessions
    .recentForContext({
      projectId: scope.kind === 'project' ? scope.projectId : null,
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
      scope: scope.kind === 'project' ? 'project' : 'global',
      projectId: scope.kind === 'project' ? scope.projectId : null,
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

  const promptsLimit = clamp(args.prompts ?? 5, 0, 50);
  const recentPrompts = deps.prompts
    .recentForContext({
      projectId: scope.kind === 'project' ? scope.projectId : null,
      limit: promptsLimit,
    })
    .map((p) => ({
      id: p.id,
      content: snippet(p.content, CONTEXT_SNIPPET_CHARS),
      agent: p.agent,
      createdAt: p.createdAt,
    }));

  // Relevance channel — separate from recentMemories (which is pure
  // recency) so the model can tell the two apart. An explicit `focus`
  // always wins; otherwise a seed is derived so the improvement doesn't
  // depend on the agent knowing to ask.
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
    // Entity-derived results are folded into this one channel rather than
    // exposed separately (design.md's resolved open question 3: "leaning
    // fold, more explainable as one channel than two"). An entity
    // recognized in the seed (most often from a recent prompt naming a
    // file/error/ticket) is an exact match, so it's admitted ahead of the
    // ranked hybrid-search fallback, deduped by id, capped at the same
    // limit. `via` keeps the two populations distinguishable in the
    // response, matching `memory.search`'s `viaEntity` observability.
    const memScope = scope.kind === 'global' ? 'global' : 'project';
    const projectId = scope.kind === 'project' ? scope.projectId : null;
    const byId = new Map<string, { memory: Memory; via: 'entity' | 'ranked' }>();
    if (deps.repos) {
      for (const e of extractEntities('', focusText)) {
        if (byId.size >= RELEVANCE_LIMIT) break;
        const rows = deps.repos.entities.findMemoriesByEntity({
          scope: memScope,
          projectId,
          kind: e.kind,
          value: e.value,
          limit: RELEVANCE_LIMIT,
        });
        for (const r of rows) {
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

  // Pending relations the agent should close with memory.judge while context
  // is fresh. Unjudged rows are deterministically orphaned by the sweep after
  // the deadline.
  const now = Date.now();
  const wantsInventory = args.judgments !== undefined;
  const judgmentsLimit = clamp(
    args.judgments ?? PENDING_JUDGMENTS_DEFAULT,
    0,
    PENDING_JUDGMENTS_MAX,
  );
  const pendingCutoff = now - (deps.orphanAfterMs ?? 86_400_000);
  const relationsScope = {
    scope: scope.kind === 'project' ? ('project' as const) : ('global' as const),
    projectId: scope.kind === 'project' ? scope.projectId : null,
  };
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

  // Active memories past their review shelf life — re-affirm with
  // memory.confirm, supersede with memory.save + topic_key, or judge if they
  // contradict another memory. Unary (one memory, no counterpart), disjoint
  // from pendingJudgments. Derived read-time state; nothing is mutated.
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
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    recentSessions,
    recentPrompts,
    recentMemories,
    relevantMemories,
    ...(rankedPass ? { rankedPass } : {}),
    pendingJudgments,
    pendingJudgmentsTotal,
    needsReview,
    needsReviewTotal,
    clamped,
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
  const before = clamp(args.before ?? 5, 0, 50);
  const after = clamp(args.after ?? 5, 0, 50);
  if (before + after > 50) {
    return mcpError(
      'invalid_input',
      'memory.timeline: before + after exceeds 50; for larger windows use memory.search',
    );
  }
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  const target = deps.memory.get(args.memoryId, scope);
  if (!target) {
    return mcpError('not_found', `memory '${args.memoryId}' not found in this scope`);
  }
  const t = target.memory;

  if (t.sessionId) {
    const neighborScope = {
      scope: scope.kind === 'project' ? ('project' as const) : ('global' as const),
      projectId: scope.kind === 'project' ? scope.projectId : null,
    };
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
    scope: scope.kind === 'project' ? ('project' as const) : ('global' as const),
    projectId: scope.kind === 'project' ? scope.projectId : null,
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
