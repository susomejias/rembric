import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RootsListChangedNotificationSchema,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

import type { Repositories } from '../db/repositories/index.js';
import type { MemoryScope } from '../db/schema/memory.js';
import type { SessionRouter } from '../server/session-router.js';
import { SUMMARY_MAX_CHARS, type AgentSessionsService } from '../services/agent-sessions.js';
import type { MemoryService } from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { PromptsService } from '../services/prompts.js';
import type { RelationsService } from '../services/relations.js';
import type { CandidateOptions } from '../services/save-time-candidates.js';

import { aboutOutput, handleAbout } from './about-tool.js';
import { buildInstructions } from './instructions.js';
import {
  buildMemoryHandlers,
  contextOutput,
  contextSchema,
  memoryArchiveOutput,
  memoryArchiveSchema,
  memoryConfirmOutput,
  memoryConfirmSchema,
  memoryGetOutput,
  memoryGetSchema,
  memorySaveOutput,
  memorySaveSchema,
  memorySearchOutput,
  memorySearchSchema,
  timelineOutput,
  timelineSchema,
} from './memory-tools.js';
import {
  buildObservabilityHandlers,
  capturePassiveOutput,
  capturePassiveSchema,
  doctorOutput,
  statsOutput,
  type DoctorReport,
} from './observability-tools.js';
import {
  buildProjectHandlers,
  projectCurrentOutput,
  projectCurrentSchema,
  projectListOutput,
  projectListSchema,
  projectUseOutput,
  projectUseSchema,
} from './project-tools.js';
import {
  buildPromptHandlers,
  savePromptOutput,
  savePromptSchema,
  searchPromptsOutput,
  searchPromptsSchema,
} from './prompt-tools.js';
import {
  buildRelationsHandlers,
  compareOutput,
  compareSchema,
  judgeOutput,
  judgeSchema,
  suggestTopicKeyOutput,
  suggestTopicKeySchema,
} from './relations-tools.js';
import {
  buildSessionHandlers,
  sessionEndOutput,
  sessionEndSchema,
  sessionGetOutput,
  sessionGetSchema,
  sessionStartOutput,
  sessionStartSchema,
  sessionSummaryOutput,
  sessionSummarySchema,
} from './session-tools.js';

/**
 * Construct the MCP server and register every tool.
 *
 * The server is request-stateless — per-request data (token, project,
 * mcp-session-id) is carried in AsyncLocalStorage by the HTTP layer.
 *
 * The factory closes over `(requestedSlug)` so the emitted
 * `initialize.instructions` block matches the connection scope.
 */

export interface CreateMcpServerOptions {
  memory: MemoryService;
  projects: ProjectsService;
  agentSessions: AgentSessionsService;
  prompts: PromptsService;
  relations: RelationsService;
  candidates: CandidateOptions;
  /** Inline save-time embedding (see MemoryToolDeps.embedNow). */
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    scope: MemoryScope,
    projectId: string | null,
  ) => Promise<boolean>;
  router: SessionRouter;
  repos: Repositories;
  doctor: () => DoctorReport;
  /** Fire-and-forget consolidation sweep, invoked after session start. */
  sweep?: (projectId: string | null) => void;
  /** Pending relations older than this surface in memory.context. */
  orphanAfterMs?: number;
  /** URL path slug for this connection, used to scope `instructions`. */
  requestedSlug?: string | null;
  name?: string;
  version?: string;
}

const SAVE_DESCRIPTION =
  'Save a structured memory. Call this IMMEDIATELY after: bug fix · architecture/design decision · non-obvious discovery · configuration change · pattern (naming, structure, convention) · user preference or constraint learned. Required: type ∈ {user,feedback,project,reference,procedural}, title (a short ≤100-char label of what this memory is about — written as a scannable headline, not the cwd), content. Optional: tags[], topic_key, sessionId (pass it if you know your current session id — never invent one — to guarantee correct attachment when multiple sessions could be active). If this update is the LATEST take on an evolving topic you saved before, pass `topic_key` (call memory.suggest_topic_key first if unsure) — the previous active row in that slot is auto-superseded atomically. The response includes `candidates[]` when the save matches existing memories above the configured similarity threshold; close each pending judgment with memory.judge while the context is fresh. Path-scoped connections (/mcp/<slug>) reject scope=global with code "scope_locked"; on /mcp the agent picks scope (project-scope requires either path-scoping or a prior project.use call).';

const SEARCH_DESCRIPTION =
  'Search memories. Call this whenever the user references past work or asks "remember", "recall", "what did we do", "recuerda", "acuérdate". Ranks by hybrid semantic + keyword relevance (vector similarity ⊕ FTS5), so paraphrases and cross-lingual queries match. Supports type/tag/status/limit filters, plus an exact `topic_key` filter (bypasses ranking) to see every memory ever saved under a given key — use it to check whether a topic already converged before saving with a new key. Returns a small default page (8); if every result looks relevant and you need more, prefer raising `limit` (up to 200). `offset` paging also works but is shallow on a text query (results are ranked by relevance over a bounded window, so a deep `offset` returns an empty page); the no-query listing paginates fully. Path-scoped connections see only that project; unscoped see globals only. Each row carries `reviewState`: `needs_review` means the memory has not been re-affirmed within its shelf life — re-verify it (memory.confirm if still true, memory.save+topic_key if it changed, memory.judge if it contradicts another memory). `abstained:true` means no memory cleared the relevance floor — treat as "nothing relevant found", not as a signal to invent or assume context.';

const GET_DESCRIPTION =
  'Retrieve a memory by id, including its predecessor chain (replaces) and confirmation count. Use when memory.search returned a result and you need full untruncated content or history. `predecessors[]` is bounded (id/title/status/createdAt only, no content) — `truncated:true` means more predecessor history exists than was returned; `headTruncated:true` means the supersedes-chain head could not be fully resolved. For an active memory the response also carries `reviewState`/`reviewAfter`: `needs_review` means re-verify (memory.confirm if still true, memory.save+topic_key if changed).';

const CONFIRM_DESCRIPTION =
  'Record a confirmation event for the head of the supersedes chain reachable from this id. Call this when the user explicitly endorses a memory ("yes, that\'s right", "still true") so future retrievals can prioritise it. Pass `ids: string[]` to re-affirm several memories in one call — e.g. close out all of memory.context.needsReview when they are all still true. Optional: sessionId (pass it if you know your current one — never invent one — to guarantee correct attachment when multiple sessions could be active).';

const ARCHIVE_DESCRIPTION =
  'Retire a memory: flip one active memory in this scope to `archived` so it stops surfacing in recall. Call this ONLY when the user explicitly asks to retire, remove, or forget a specific memory — never as autonomous cleanup or housekeeping while recalling or saving, and never on your own judgement that a memory looks stale. If a replacement exists, do NOT archive: prefer a supersede (memory.save with the same `topic_key`, or memory.judge) which keeps a successor link — archive is the no-successor path for genuine retirement. Also use it as the second half of a user-requested cross-project move: memory.save the memory into the destination project, then memory.archive the original here. Args: { id }. Errors: `not_found` if the id is missing or in another scope, `conflict` if it is not active. Reversible: an operator can undo the archive from the dashboard.';

// Rembric is append-only (rows are never deleted; supersede is a reversible,
// journaled status flip) and a closed local store, so destructiveHint and
// openWorldHint are false for EVERY tool — defined once here so no per-tool
// factory can get them wrong.
const NON_DESTRUCTIVE_CLOSED = { destructiveHint: false, openWorldHint: false } as const;

const READ_ANNOTATIONS = (title: string): ToolAnnotations => ({
  title,
  ...NON_DESTRUCTIVE_CLOSED,
  readOnlyHint: true,
  idempotentHint: true,
});

const WRITE_ANNOTATIONS = (title: string): ToolAnnotations => ({
  title,
  ...NON_DESTRUCTIVE_CLOSED,
  readOnlyHint: false,
  idempotentHint: false,
});

const IDEMPOTENT_WRITE_ANNOTATIONS = (title: string): ToolAnnotations => ({
  title,
  ...NON_DESTRUCTIVE_CLOSED,
  readOnlyHint: false,
  idempotentHint: true,
});

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: opts.name ?? 'rembric',
      version: opts.version ?? '0.0.0',
    },
    {
      instructions: buildInstructions({ requestedSlug: opts.requestedSlug ?? null }),
    },
  );

  // ── Memory tools: save / search / get / confirm + context / timeline ─
  const memoryHandlers = buildMemoryHandlers({
    memory: opts.memory,
    relations: opts.relations,
    candidates: opts.candidates,
    embedNow: opts.embedNow,
    repos: opts.repos,
    router: opts.router,
    projects: opts.projects,
    agentSessions: opts.agentSessions,
    prompts: opts.prompts,
    orphanAfterMs: opts.orphanAfterMs,
    getServer: () => server,
  });
  server.registerTool(
    'memory.save',
    {
      description: SAVE_DESCRIPTION,
      inputSchema: memorySaveSchema,
      outputSchema: memorySaveOutput,
      annotations: WRITE_ANNOTATIONS('Save memory'),
    },
    memoryHandlers.save,
  );
  server.registerTool(
    'memory.search',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: memorySearchSchema,
      outputSchema: memorySearchOutput,
      annotations: READ_ANNOTATIONS('Search memories'),
    },
    memoryHandlers.search,
  );
  server.registerTool(
    'memory.get',
    {
      description: GET_DESCRIPTION,
      inputSchema: memoryGetSchema,
      outputSchema: memoryGetOutput,
      annotations: READ_ANNOTATIONS('Get memory'),
    },
    memoryHandlers.get,
  );
  server.registerTool(
    'memory.confirm',
    {
      description: CONFIRM_DESCRIPTION,
      inputSchema: memoryConfirmSchema,
      outputSchema: memoryConfirmOutput,
      annotations: WRITE_ANNOTATIONS('Confirm memory'),
    },
    memoryHandlers.confirm,
  );
  server.registerTool(
    'memory.archive',
    {
      description: ARCHIVE_DESCRIPTION,
      inputSchema: memoryArchiveSchema,
      outputSchema: memoryArchiveOutput,
      annotations: WRITE_ANNOTATIONS('Archive memory'),
    },
    memoryHandlers.archive,
  );

  // ── Session lifecycle tools ───────────────────────────────────────
  const sessionHandlers = buildSessionHandlers({
    agentSessions: opts.agentSessions,
    projects: opts.projects,
    router: opts.router,
    sweep: opts.sweep,
    getServer: () => server,
  });

  // ── Curated-prompt tools ──────────────────────────────────────────
  const promptHandlers = buildPromptHandlers({
    prompts: opts.prompts,
    agentSessions: opts.agentSessions,
    router: opts.router,
    projects: opts.projects,
    getServer: () => server,
  });

  // ── Observability tools ───────────────────────────────────────────
  const observabilityHandlers = buildObservabilityHandlers({
    memory: opts.memory,
    agentSessions: opts.agentSessions,
    repos: opts.repos,
    router: opts.router,
    projects: opts.projects,
    doctor: opts.doctor,
    relations: opts.relations,
    candidates: opts.candidates,
    embedNow: opts.embedNow,
    getServer: () => server,
  });

  server.registerTool(
    'memory.session_start',
    {
      description:
        'Start an agent session. In normal operation you do NOT need to call this — the host registers the session automatically (Claude Code/Codex hooks and the Hermes/opencode providers POST to the sessions endpoint on startup). Call it only when running without that host wiring and you need an explicit session to wrap with memory.session_summary. Args: { agent?, description?, project? (slug, overrides roots) }. Returns: { sessionId, scope, projectId, startedAt }.',
      inputSchema: sessionStartSchema,
      outputSchema: sessionStartOutput,
      annotations: WRITE_ANNOTATIONS('Start session'),
    },
    sessionHandlers.sessionStart,
  );
  server.registerTool(
    'memory.session_end',
    {
      description:
        'End the active session without writing a summary. Prefer memory.session_summary unless the session is being abandoned. Optional: sessionId (pass it if you know your current one — never invent one — to guarantee correct attachment when multiple sessions could be active).',
      inputSchema: sessionEndSchema,
      outputSchema: sessionEndOutput,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS('End session'),
    },
    sessionHandlers.sessionEnd,
  );
  server.registerTool(
    'memory.session_summary',
    {
      description: `Save the end-of-session summary AND a short title. Call this at the END OF EVERY TURN that did real work — never end a working turn silent; do NOT wait for the literal word "done"/"listo". Args: { summary (<=${SUMMARY_MAX_CHARS} chars, server rejects longer with invalid_input), title? (<=100 chars, descriptive of work done, NOT the cwd), sessionId? (pass it if you know your current session id — never invent one — to guarantee correct attachment when multiple sessions could be active) }. Keep it concise but include useful handoff detail. Body: Goal · Instructions · Discoveries · Accomplished · Next Steps · Relevant Files. Does NOT end the session — use memory.session_end for that.`,
      inputSchema: sessionSummarySchema,
      outputSchema: sessionSummaryOutput,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS('Save session summary'),
    },
    sessionHandlers.sessionSummary,
  );
  server.registerTool(
    'memory.context',
    {
      description:
        'Get recent context for this scope: recentSessions (with summaries), recentMemories (sorted by last_seen_at), relevantMemories (ranked by relevance to `focus`, or a server-derived seed when omitted — empty if nothing is relevant), pendingJudgments (aged unresolved relation pairs to close with memory.judge), and needsReview (active memories past their re-verification shelf life — re-affirm with memory.confirm, supersede with memory.save+topic_key, or judge if they contradict another memory). Call this when starting or resuming work that may have prior context, after a /compact event, or when asked "what did we do" — before acting, but only if you lack the prior detail you need (do not load it speculatively on every session start). Default sizes are small; the response includes a `clamped:true` flag if you asked for too much.',
      inputSchema: contextSchema,
      outputSchema: contextOutput,
      annotations: READ_ANNOTATIONS('Recent context'),
    },
    memoryHandlers.context,
  );
  server.registerTool(
    'memory.session_get',
    {
      description:
        "Fetch one session by id with its FULL, untruncated summary — memory.context only returns a short snippet. Scope-enforced: a cross-scope or soft-deleted id returns not_found. Use to resume work surfaced in memory.context when the snippet isn't enough (cross-client / multi-agent handoff).",
      inputSchema: sessionGetSchema,
      outputSchema: sessionGetOutput,
      annotations: READ_ANNOTATIONS('Get session'),
    },
    sessionHandlers.sessionGet,
  );
  server.registerTool(
    'memory.timeline',
    {
      description:
        'Drill into chronological neighbors of a specific memory. Returns memories before and after the target within the same session (or, when the target has no session, a ±2h time window with fallback:"time_window").',
      inputSchema: timelineSchema,
      outputSchema: timelineOutput,
      annotations: READ_ANNOTATIONS('Memory timeline'),
    },
    memoryHandlers.timeline,
  );
  server.registerTool(
    'memory.capture_passive',
    {
      description:
        'Bulk-save learnings: extract numbered/bulleted items from a "## Key Learnings" (or "### Key Learnings", colon optional, case-insensitive) section in the given text and save each as a separate memory (type=reference) through the same curation pipeline as memory.save — topic_key handling, inline embedding, save-time candidate detection. When no such section is found, `saved` is 0 and `reason` explains why; this is NOT the same as success. Call this when you have produced (or the user supplied) a Key Learnings list worth persisting — e.g. when wrapping up a task — instead of issuing many individual memory.save calls. The response may include `candidates[]` if any captured learning conflicts with an existing memory — judge them with memory.judge. Optional: sessionId (pass it if you know your current one — never invent one — to guarantee correct attachment when multiple sessions could be active).',
      inputSchema: capturePassiveSchema,
      outputSchema: capturePassiveOutput,
      annotations: WRITE_ANNOTATIONS('Capture learnings'),
    },
    observabilityHandlers.capturePassive,
  );
  server.registerTool(
    'memory.save_prompt',
    {
      description:
        "Persist the user's most recent prompt for the active session/project so future sessions can read it via memory.context.recentPrompts (and so the operator can browse them at /dashboard/prompts). Call this when the user states a goal or constraint worth remembering. REQUIRED fields: content (verbatim text, ≤20k chars) AND title (≤100 chars, scannable label for retrieval lists — a prompt without a title is not searchable in practice). Optional: tags (string[] for categorical filtering — fed into the FTS5 index alongside content), replaces (id of a predecessor prompt to atomically refine — the old row is soft-deleted and the new row links via `replaces[]`), sessionId (pass it if you know your current one — never invent one — to guarantee correct attachment when multiple sessions could be active). When the refined predecessor does not exist, is in another scope, or is already deleted, the call is rejected with `prompt_not_found` / `prompt_scope_mismatch` / `prompt_already_deleted`.",
      inputSchema: savePromptSchema,
      outputSchema: savePromptOutput,
      annotations: WRITE_ANNOTATIONS('Save prompt'),
    },
    promptHandlers.savePrompt,
  );
  server.registerTool(
    'memory.search_prompts',
    {
      description:
        'Search curated prompts in the active scope. With `query`, runs an FTS5 MATCH over `content + tags` (token-aware); without it, falls back to recency. Filters: `sessionId`, `agent`, `includeDeleted` (default false). Returns `{ scope, prompts[], total, clamped }`. Use when the user references a prior goal/directive and you need to retrieve the exact wording.',
      inputSchema: searchPromptsSchema,
      outputSchema: searchPromptsOutput,
      annotations: READ_ANNOTATIONS('Search prompts'),
    },
    promptHandlers.searchPrompts,
  );
  server.registerTool(
    'memory.doctor',
    {
      description:
        'Read-only operational diagnostics. Returns DB/LLM/embeddings/consolidation health plus warnings. Use at session start when behavior seems off.',
      inputSchema: {},
      outputSchema: doctorOutput,
      annotations: READ_ANNOTATIONS('Diagnostics'),
    },
    observabilityHandlers.doctor,
  );
  server.registerTool(
    'memory.about',
    {
      description:
        'Read-only guidance to update/upgrade Rembric: returns the running server version + the canonical installer commands to update client plugins. Call when the operator asks how to update or upgrade Rembric (server or plugins). Surfaces commands for the operator to run; never executes them.',
      inputSchema: {},
      outputSchema: aboutOutput,
      annotations: READ_ANNOTATIONS('About Rembric'),
    },
    handleAbout,
  );
  server.registerTool(
    'memory.stats',
    {
      description:
        'Read-only counters: memoriesByStatus, memoriesByType, sessionsByStatus, scoped to the active project (or global).',
      inputSchema: {},
      outputSchema: statsOutput,
      annotations: READ_ANNOTATIONS('Stats'),
    },
    observabilityHandlers.stats,
  );

  // ── Project management tools ──────────────────────────────────────
  // The handlers receive a back-reference to the McpServer instance via
  // `getServer` so the roots-discovery helper can call
  // `server.server.listRoots()` on the underlying transport.
  const projectHandlers = buildProjectHandlers({
    repos: opts.repos,
    projects: opts.projects,
    agentSessions: opts.agentSessions,
    router: opts.router,
    getServer: () => server,
  });
  server.registerTool(
    'project.use',
    {
      description:
        'Activate a project for this MCP session by slug. By default, never creates and never switches mid-session. Pass autocreate:true to mint a new project (slug must match strict regex). Pass confirmSwitch:true to replace the current project (only allowed when no session is active — close it first via memory.session_summary). ASK THE USER before passing either flag.',
      inputSchema: projectUseSchema,
      outputSchema: projectUseOutput,
      annotations: WRITE_ANNOTATIONS('Use project'),
    },
    projectHandlers.use,
  );
  server.registerTool(
    'project.list',
    {
      description:
        'List existing projects and their memory counts. Use when the user references a project that may not be active in this session.',
      inputSchema: projectListSchema,
      outputSchema: projectListOutput,
      annotations: READ_ANNOTATIONS('List projects'),
    },
    projectHandlers.list,
  );
  server.registerTool(
    'project.current',
    {
      description:
        'Report the project active in this session (slug, projectId, source) plus any pending suggestedSlugs surfaced by roots-based discovery.',
      inputSchema: projectCurrentSchema,
      outputSchema: projectCurrentOutput,
      annotations: READ_ANNOTATIONS('Current project'),
    },
    projectHandlers.current,
  );

  // ── Relations tools (judgment graph) ──────────────────────────────
  const relationsHandlers = buildRelationsHandlers({
    relations: opts.relations,
    router: opts.router,
    projects: opts.projects,
    repos: opts.repos,
    getServer: () => server,
  });
  server.registerTool(
    'memory.suggest_topic_key',
    {
      description:
        'Suggest a stable topic_key for an evolving memory based on type + title/content. Deterministic — no LLM. Call before memory.save when updating a topic you have saved before, so the new row supersedes the previous one atomically instead of fragmenting the result set. The response is scope-aware: `occupied:true` means an active memory already holds the exact suggested key (`occupantId`/`occupantTitle` name it — pass that same key to converge onto it rather than minting a synonym); `nearby[]` lists active keys sharing a prefix, in case one of those is the topic you meant. Also check via memory.search({topic_key}) if you want the full history under a key.',
      inputSchema: suggestTopicKeySchema,
      outputSchema: suggestTopicKeyOutput,
      annotations: READ_ANNOTATIONS('Suggest topic key'),
    },
    relationsHandlers.suggestTopicKey,
  );
  server.registerTool(
    'memory.judge',
    {
      description:
        'Close a pending judgment surfaced by memory.save.candidates[]. Pass the judgmentId, a relation (supersedes/conflicts_with/related/compatible/scoped/not_conflict), optional reason and confidence. relation=supersedes atomically marks the candidate target memory as superseded. Pass `judgments: [...]` to close all of memory.save.candidates[] in one call — each item is judged independently, so a bad id reports an error without rolling back the others.',
      inputSchema: judgeSchema,
      outputSchema: judgeOutput,
      annotations: WRITE_ANNOTATIONS('Judge memories'),
    },
    relationsHandlers.judge,
  );
  server.registerTool(
    'memory.compare',
    {
      description:
        'Proactively record a verdict on two arbitrary memories without a preceding save. Idempotent: re-calling with the same (memoryIdA, memoryIdB) pair updates the existing row. Use when independent analysis finds two memories that are related or contradict; for save-time candidates use memory.judge instead.',
      inputSchema: compareSchema,
      outputSchema: compareOutput,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS('Compare memories'),
    },
    relationsHandlers.compare,
  );

  // ── notifications/roots/list_changed ───────────────────────────────
  // The client emits this notification when its workspace roots change.
  // We re-derive the candidate slug but NEVER auto-switch — the agent
  // observes the updated suggestedSlugs via project.current and decides
  // explicitly (matches the spec scenario "list_changed updates
  // suggestions but does not switch").
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    // No request context is available in the notification handler — we
    // don't have a tokenId / mcpSessionId here. The next `project.current`
    // call will re-trigger discovery because list_changed clears the
    // already-discovered flag for the affected transport.
    //
    // For simplicity (and to satisfy the spec's "never auto-switches"
    // contract), we just clear the discovery sentinel; subsequent
    // `project.current` calls will issue a fresh `roots/list` and update
    // suggestedSlugs accordingly. A finer-grained per-transport reset is
    // a follow-up; today the global reset is safe because discovery is
    // idempotent and cheap.
    const { resetDiscoveryState } = await import('./roots-discovery.js');
    resetDiscoveryState();
  });

  return server;
}
