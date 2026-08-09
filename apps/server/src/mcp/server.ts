import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RootsListChangedNotificationSchema,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodObject, type ZodRawShape } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import type { SessionRouter } from '../server/session-router.js';
import { runWithToolCallId } from '../server/tool-call-context.js';
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
import { markRefreshPending } from './roots-discovery.js';
import {
  buildSessionHandlers,
  sessionEndOutput,
  sessionEndSchema,
  sessionGetOutput,
  sessionGetSchema,
  sessionResumeOutput,
  sessionResumeSchema,
  sessionStartOutput,
  sessionStartSchema,
  sessionSummaryOutput,
  sessionSummarySchema,
} from './session-tools.js';
import { SUMMARY_SECTIONS } from './summary-rubric.js';

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
    projectId: string,
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

// Claude Code 2.1.220 tail-cuts any tool description over 2048 chars (`LB`);
// 1900 keeps an early-warning margin. Unlike INSTRUCTIONS_MAX_LENGTH this is a
// verified client ceiling, not a token budget — see the mcp-api requirement
// "Tool descriptions MUST stay below the client truncation ceiling".
export const DESCRIPTION_MAX_LENGTH = 1900;

const SAVE_DESCRIPTION =
  'Save a structured memory. Call this IMMEDIATELY after: bug fix · architecture/design decision · non-obvious discovery · configuration change · pattern (naming, structure, convention) · user preference or constraint learned. Required: type ∈ {user,feedback,project,reference,procedural}, title (a short ≤100-char label of what this memory is about — written as a scannable headline, not the cwd), content. Optional: tags[], topic_key, sessionId (pass it if you know your current session id — never invent one — to guarantee correct attachment when multiple sessions could be active). If this update is the LATEST take on an evolving topic you saved before, pass `topic_key` (call memory.suggest_topic_key first if unsure) — the previous active row in that slot is auto-superseded atomically. The response includes `candidates[]` when the save matches existing memories above the configured similarity threshold; close each pending judgment with memory.judge while the context is fresh. `candidatesDetected` counts the matches ranked BEFORE the operator cap CANDIDATES_PER_SAVE_MAX (default 5) trimmed the list: a lower bound on how many memories resemble this one, not a scope total, and no request argument raises it. Only `candidates[]` entries carry `judgmentId`s, so a high count is NOT a queue you just created — when it far exceeds the returned length, converge the topic under one `topic_key` (memory.suggest_topic_key) instead of judging many pairs. The remainder stays reachable via memory.search and recordable per pair with memory.compare.';

const SEARCH_DESCRIPTION =
  'Search memories. Call this whenever the user references past work or asks "remember", "recall", "what did we do", "recuerda". Ranks by hybrid semantic + keyword relevance (vector similarity ⊕ FTS5), so paraphrases and cross-lingual queries match. Supports type/tag/status/limit filters, plus an exact `topic_key` filter that returns a topic\'s whole history — the active row plus every row it superseded — so you can check whether a topic already converged before saving with a new key. Got a literal identifier? Pass it as `entity`, not `query` — exact-address lookup, unranked and complete within scope (with no `limit`, up to 400 linked memories rather than the 8-row default), combinable with the same filters, without the noise a text query has on identifiers. Answers "what do I know about this file/error/host"; with `query` it narrows rather than fuses. Returns a small default page (8); need more? Prefer raising `limit` (up to 200). `offset` paging is shallow on a text query (ranked over a bounded window, so a deep `offset` returns an empty page); the no-query listing paginates fully. `across_projects:true` also reads the other projects this token may reach. Never a default: only on an explicit ask, or when the answer is not expected in this project. It dilutes the page with foreign memories. `searchedProjects[]` names what was read. Each row carries `reviewState`: `needs_review` means the memory has not been re-affirmed within its shelf life — re-verify it (memory.confirm if still true, memory.save+topic_key if it changed, memory.judge if it contradicts another memory). `abstained:true` means nothing matched — treat as "nothing relevant found", not as a signal to invent or assume context. `gateShortened:true` means a relevance gate cut weaker rows: a short page is not corpus exhaustion, and a full page is not proof of relevance.';

const GET_DESCRIPTION =
  'Retrieve a memory by id, including its predecessor chain (replaces) and confirmation count. Use when memory.search returned a result and you need full untruncated content or history. `predecessors[]` is bounded (id/title/status/createdAt only, no content) — `truncated:true` means more predecessor history exists than was returned; `headTruncated:true` means the supersedes-chain head could not be fully resolved. For an active memory the response also carries `reviewState`/`reviewAfter`: `needs_review` means re-verify (memory.confirm if still true, memory.save+topic_key if changed).';

const CONFIRM_DESCRIPTION =
  'Record a verdict on the head of the supersedes chain reachable from this id — the only way to close a `needs_review` memory. Default `verdict:"affirm"`: call it when the user explicitly endorses a memory ("yes, that\'s right", "still true") so future retrievals can prioritise it. `verdict:"refute"` records the opposite and REQUIRES `reason`: use it only when a memory you actually surfaced and acted on turned out wrong or stale and you have verified that. A refutation edits and archives nothing; it marks the memory `needs_review` immediately, whatever its shelf life, so a human or a later pass re-verifies it — and it does not extend the memory\'s life the way an affirmation does. Pass `ids: string[]` to record one verdict over several memories in one call — e.g. close out all of memory.context.needsReview when they are all still true. Optional: sessionId (pass it if you know your current one — never invent one — to guarantee correct attachment when multiple sessions could be active). Errors: `invalid_input` if `refute` arrives without a reason, `not_found` for an id outside this scope.';

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

  // Registers strict: a raw shape becomes a plain `z.object()`, which strips
  // unknown keys instead of refusing them.
  const registerTool = <InputArgs extends ZodRawShape, OutputArgs extends ZodRawShape>(
    name: string,
    config: {
      description: string;
      inputSchema: InputArgs;
      outputSchema?: OutputArgs;
      annotations: ToolAnnotations;
    },
    cb: ToolCallback<InputArgs>,
  ): void => {
    server.registerTool<OutputArgs, ZodObject<InputArgs, 'strict'>>(
      name,
      { ...config, inputSchema: z.object(config.inputSchema).strict() },
      // The sole registration funnel, so every tool — including one added
      // later — runs with its JSON-RPC id available to server→client requests.
      (args, extra) => runWithToolCallId(extra.requestId, () => cb(args, extra)),
    );
  };

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
  registerTool(
    'memory.save',
    {
      description: SAVE_DESCRIPTION,
      inputSchema: memorySaveSchema,
      outputSchema: memorySaveOutput,
      annotations: WRITE_ANNOTATIONS('Save memory'),
    },
    memoryHandlers.save,
  );
  registerTool(
    'memory.search',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: memorySearchSchema,
      outputSchema: memorySearchOutput,
      annotations: READ_ANNOTATIONS('Search memories'),
    },
    memoryHandlers.search,
  );
  registerTool(
    'memory.get',
    {
      description: GET_DESCRIPTION,
      inputSchema: memoryGetSchema,
      outputSchema: memoryGetOutput,
      annotations: READ_ANNOTATIONS('Get memory'),
    },
    memoryHandlers.get,
  );
  registerTool(
    'memory.confirm',
    {
      description: CONFIRM_DESCRIPTION,
      inputSchema: memoryConfirmSchema,
      outputSchema: memoryConfirmOutput,
      annotations: WRITE_ANNOTATIONS('Confirm memory'),
    },
    memoryHandlers.confirm,
  );
  registerTool(
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

  registerTool(
    'memory.session_start',
    {
      description:
        "Start an agent session. In normal operation you do NOT need to call this — the host registers the session automatically (Claude Code/Codex hooks and the Hermes/opencode/Pi providers POST to the sessions endpoint). Call it only when running without that host wiring and you need an explicit session to wrap with memory.session_summary. Args: { agent?, description?, project? (slug, overrides roots) }. Returns: { sessionId, scope, projectId, startedAt, title, reused }. `reused:true` means this call ADOPTED the host's already-active session instead of starting one, so the sessionId is the host's, not a new session.",
      inputSchema: sessionStartSchema,
      outputSchema: sessionStartOutput,
      annotations: WRITE_ANNOTATIONS('Start session'),
    },
    sessionHandlers.sessionStart,
  );
  registerTool(
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
  registerTool(
    'memory.session_summary',
    {
      description: `Save the end-of-session summary AND a short title. Call this at the END OF EVERY TURN that did real work — never end a working turn silent; do NOT wait for the literal word "done"/"listo". Args: { summary (<=${SUMMARY_MAX_CHARS} chars, server rejects longer with invalid_input), title? (<=100 chars, descriptive of work done, NOT the cwd), sessionId? (pass it if you know your current session id — never invent one — to guarantee correct attachment when multiple sessions could be active) }. Keep it concise but include useful handoff detail. Body: ${SUMMARY_SECTIONS}. Does NOT end the session — use memory.session_end for that.`,
      inputSchema: sessionSummarySchema,
      outputSchema: sessionSummaryOutput,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS('Save session summary'),
    },
    sessionHandlers.sessionSummary,
  );
  registerTool(
    'memory.session_resume',
    {
      description:
        "Return an already-closed session to active, so a resumed conversation reattaches to its original row instead of running unattributed or forking a second one. Call it when you are continuing a conversation whose Rembric session was ended or abandoned (the retirement sweep abandons idle sessions) and you know that session's id — never invent one. Args: { sessionId } — REQUIRED, with no fallback: an omitted id is rejected with invalid_input rather than guessed by recency. Returns: { ok: true, sessionId, status ('active'), startedAt, resumedAt (the new activity stamp; unchanged when the session was already active), previousStatus, previousEndedAt, title }. `previousStatus` and `previousEndedAt` report what this call discarded — `previousEndedAt` is NOT retained on the row afterwards, so this response is the only place it is ever reported. On success the session becomes this connection's session, so later memory.save calls attach to it with no sessionId argument. Resuming an already-active session succeeds and mutates nothing. Errors: session_not_found (unknown id, or a session belonging to another token or project), session_deleted (an operator soft-deleted it — ask them to undelete it).",
      inputSchema: sessionResumeSchema,
      outputSchema: sessionResumeOutput,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS('Resume session'),
    },
    sessionHandlers.sessionResume,
  );
  registerTool(
    'memory.context',
    {
      description:
        'Get recent context for this scope: recentSessions (with summaries), recentMemories (sorted by last_seen_at), relevantMemories (ranked by relevance to `focus`, or a server-derived seed when omitted — empty if nothing is relevant), pendingJudgments (unresolved relation pairs to close with memory.judge, by default only the aged ones, 5 at a time) with pendingJudgmentsTotal (how many adjudicable pairs are pending in scope — the list is a page of it), and needsReview (active memories past their re-verification shelf life — re-affirm with memory.confirm, supersede with memory.save+topic_key, or judge if they contradict another memory) with needsReviewTotal. Call this when starting or resuming work that may have prior context, after a /compact event, or when asked "what did we do" — before acting, but only if you lack the prior detail you need (do not load it speculatively on every session start). To DRAIN the judgment queue rather than be warned about it, pass `judgments: N` (max 50 — a deeper queue takes more than one pass; asking for more is rejected, not clamped): an explicit size also lifts the age filter, so pairs created recently — unreachable any other way once their save-time candidates[] is gone — are returned too. Default sizes are small (sessions 3, memories 10, prompts 5, judgments 5) and each has a maximum: sessions 25, prompts 50, memories 100, judgments 50. Above it the call is rejected, not clamped.',
      inputSchema: contextSchema,
      outputSchema: contextOutput,
      annotations: READ_ANNOTATIONS('Recent context'),
    },
    memoryHandlers.context,
  );
  registerTool(
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
  registerTool(
    'memory.timeline',
    {
      description:
        'Drill into chronological neighbors of a specific memory. Args: { memoryId, before? (default 5), after? (default 5) }; before + after must not exceed 50 — a larger window is rejected with invalid_input, not clamped; use memory.search instead. Returns memories before and after the target within the same session (or, when the target has no session, a ±2h time window with fallback:"time_window").',
      inputSchema: timelineSchema,
      outputSchema: timelineOutput,
      annotations: READ_ANNOTATIONS('Memory timeline'),
    },
    memoryHandlers.timeline,
  );
  registerTool(
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
  registerTool(
    'memory.save_prompt',
    {
      description:
        'Persist a REUSABLE prompt for the active session/project so future sessions can read it via memory.context.recentPrompts (and so the operator can browse them at /dashboard/prompts). This is a curated library, not a log: do NOT call it routinely, and never once per session as a matter of course. Call it only when the user explicitly asks for a prompt to be saved, or hands you text that is plainly a reusable artifact (a template, a standing instruction, a wording they will want to run again). A first message is NOT eligible merely because it states a goal — that is every first message. Decisions, fixes and discoveries go to memory.save; what happened in a session goes to memory.session_summary. When in doubt, do not call this. REQUIRED fields: content (verbatim text, ≤20k chars) AND title (≤100 chars, scannable label for retrieval lists — a prompt without a title is not searchable in practice). Optional: tags (string[] for categorical filtering — fed into the FTS5 index alongside content), replaces (id of a predecessor prompt to atomically refine — the old row is soft-deleted and the new row links via `replaces[]`), sessionId (pass it if you know your current one — never invent one — to guarantee correct attachment when multiple sessions could be active). When the refined predecessor does not exist, is in another scope, or is already deleted, the call is rejected with `prompt_not_found` / `prompt_scope_mismatch` / `prompt_already_deleted`.',
      inputSchema: savePromptSchema,
      outputSchema: savePromptOutput,
      annotations: WRITE_ANNOTATIONS('Save prompt'),
    },
    promptHandlers.savePrompt,
  );
  registerTool(
    'memory.search_prompts',
    {
      description:
        'Search curated prompts in the active scope. With `query`, runs an FTS5 MATCH over `content + tags` (token-aware); without it, falls back to recency. Filters: `sessionId`, `agent`, `includeDeleted` (default false). Returns `{ scope, prompts[], total }`. `limit` defaults to 25, max 100 — above that the call is rejected, not clamped. Use when the user references a prior goal/directive and you need to retrieve the exact wording.',
      inputSchema: searchPromptsSchema,
      outputSchema: searchPromptsOutput,
      annotations: READ_ANNOTATIONS('Search prompts'),
    },
    promptHandlers.searchPrompts,
  );
  registerTool(
    'memory.doctor',
    {
      description:
        'Read-only operational diagnostics, SERVER-WIDE (all projects): DB/embeddings/entities/consolidation health, `sessions.active`, and review queue depths (`needsReview`, `pendingJudgments`), plus warnings. These counters are NOT scoped — `memory.stats` carries the scoped equivalents (`needsReviewTotal`, `pendingJudgmentsTotal`) and they will differ — for two reasons: population (server-wide vs scoped) and, for `pendingJudgments` only, filtering (doctor counts every pending row; the scoped totals count only adjudicable pairs, both endpoints still active). Use at session start when behavior seems off.',
      inputSchema: {},
      outputSchema: doctorOutput,
      annotations: READ_ANNOTATIONS('Diagnostics'),
    },
    observabilityHandlers.doctor,
  );
  registerTool(
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
  registerTool(
    'memory.stats',
    {
      description:
        'Read-only counters: `memoriesByStatus`, `memoriesByType`, `sessionsByStatus`, `needsReviewTotal`, `pendingJudgmentsTotal` — all scoped to the active project. `memory.doctor` reports same-named counters server-wide, so its numbers will differ.',
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
  registerTool(
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
  registerTool(
    'project.list',
    {
      description:
        'List existing projects. Each entry carries activeMemoryCount — how many memories in that project are still active; archived and superseded rows are not counted. Use when the user references a project that may not be active in this session.',
      inputSchema: projectListSchema,
      outputSchema: projectListOutput,
      annotations: READ_ANNOTATIONS('List projects'),
    },
    projectHandlers.list,
  );
  registerTool(
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
  registerTool(
    'memory.suggest_topic_key',
    {
      description:
        'Suggest a stable topic_key for an evolving memory based on type + title/content. Deterministic — no LLM. Call before memory.save when updating a topic you have saved before, so the new row supersedes the previous one atomically instead of fragmenting the result set. The response is scope-aware: `occupied:true` means an active memory already holds the exact suggested key (`occupantId`/`occupantTitle` name it — pass that same key to converge onto it rather than minting a synonym); `nearby[]` lists active keys sharing a prefix, in case one of those is the topic you meant. `topic_key` is null with a `reason` when the title reaches no transliterable word (Han, Kana, Hangul): author your own key, Unicode is accepted — do NOT retry, the heuristic is deterministic. Also check via memory.search({topic_key}) if you want the full history under a key.',
      inputSchema: suggestTopicKeySchema,
      outputSchema: suggestTopicKeyOutput,
      annotations: READ_ANNOTATIONS('Suggest topic key'),
    },
    relationsHandlers.suggestTopicKey,
  );
  registerTool(
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
  registerTool(
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

  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    // Recorded, not acted on: with no tool call in flight, a `roots/list` sent
    // from here would not be routed to the client.
    markRefreshPending(server);
  });

  return server;
}
