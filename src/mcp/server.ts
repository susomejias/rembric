import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Db } from '../db/client.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { MemoryService } from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { PromptsService } from '../services/prompts.js';

import { buildInstructions } from './instructions.js';
import {
  buildProjectHandlers,
  projectCurrentSchema,
  projectListSchema,
  projectUseSchema,
} from './project-tools.js';
import {
  buildSessionsHandlers,
  capturePassiveSchema,
  contextSchema,
  type DoctorReport,
  savePromptSchema,
  sessionEndSchema,
  sessionStartSchema,
  sessionSummarySchema,
  timelineSchema,
} from './sessions-tools.js';
import {
  buildHandlers,
  memoryConfirmSchema,
  memoryGetSchema,
  memorySaveSchema,
  memorySearchSchema,
} from './tools.js';

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
  router: SessionRouter;
  db: Db;
  doctor: () => DoctorReport;
  /** URL path slug for this connection, used to scope `instructions`. */
  requestedSlug?: string | null;
  name?: string;
  version?: string;
}

const SAVE_DESCRIPTION =
  'Save a structured memory. Call this IMMEDIATELY after: bug fix · architecture/design decision · non-obvious discovery · configuration change · pattern (naming, structure, convention) · user preference or constraint learned. Required: type ∈ {user,feedback,project,reference}, content. Optional: tags[]. Path-scoped connections (/mcp/<slug>) reject scope=global with code "scope_locked"; on /mcp the agent picks scope (project-scope requires either path-scoping or a prior project.use call).';

const SEARCH_DESCRIPTION =
  'Search memories. Call this whenever the user references past work or asks "remember", "recall", "what did we do", "recordá", "acordate". Supports FTS5 keyword search + type/tag/status/limit filters. Path-scoped connections see only that project; unscoped see globals only.';

const GET_DESCRIPTION =
  'Retrieve a memory by id, including its predecessor chain (replaces) and confirmation count. Use when memory.search returned a result and you need full untruncated content or history.';

const CONFIRM_DESCRIPTION =
  'Record a confirmation event for the head of the supersedes chain reachable from this id. Call this when the user explicitly endorses a memory ("yes, that\'s right", "still true") so future retrievals can prioritise it.';

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

  // ── Original 4 memory tools ────────────────────────────────────────
  const handlers = buildHandlers({ memory: opts.memory });
  server.registerTool(
    'memory.save',
    { description: SAVE_DESCRIPTION, inputSchema: memorySaveSchema },
    handlers.save,
  );
  server.registerTool(
    'memory.search',
    { description: SEARCH_DESCRIPTION, inputSchema: memorySearchSchema },
    handlers.search,
  );
  server.registerTool(
    'memory.get',
    { description: GET_DESCRIPTION, inputSchema: memoryGetSchema },
    handlers.get,
  );
  server.registerTool(
    'memory.confirm',
    { description: CONFIRM_DESCRIPTION, inputSchema: memoryConfirmSchema },
    handlers.confirm,
  );

  // ── Session lifecycle + research + observability tools ────────────
  const sessions = buildSessionsHandlers({
    db: opts.db,
    agentSessions: opts.agentSessions,
    memory: opts.memory,
    projects: opts.projects,
    prompts: opts.prompts,
    router: opts.router,
    doctor: opts.doctor,
    getServer: () => server,
  });

  server.registerTool(
    'memory.session_start',
    {
      description:
        'Start an agent session. Call this once when the user begins a task you intend to wrap with memory.session_summary. Args: { agent?, description?, project? (slug, overrides roots) }. Returns: { sessionId, scope, projectId, startedAt }.',
      inputSchema: sessionStartSchema,
    },
    sessions.sessionStart,
  );
  server.registerTool(
    'memory.session_end',
    {
      description:
        'End the active session without writing a summary. Prefer memory.session_summary unless the session is being abandoned.',
      inputSchema: sessionEndSchema,
    },
    sessions.sessionEnd,
  );
  server.registerTool(
    'memory.session_summary',
    {
      description:
        'Save the end-of-session summary. Call this BEFORE saying "done"/"listo". Body: Goal · Instructions · Discoveries · Accomplished · Next Steps · Relevant Files. Closes the session.',
      inputSchema: sessionSummarySchema,
    },
    sessions.sessionSummary,
  );
  server.registerTool(
    'memory.context',
    {
      description:
        'Get recent context for this scope: recentSessions (with summaries), recentMemories (sorted by last_seen_at). Call this when starting work on something that might have been touched before. Default sizes are small; the response includes a `clamped:true` flag if you asked for too much.',
      inputSchema: contextSchema,
    },
    sessions.context,
  );
  server.registerTool(
    'memory.timeline',
    {
      description:
        'Drill into chronological neighbors of a specific memory. Returns memories before and after the target within the same session (or, when the target has no session, a ±2h time window with fallback:"time_window").',
      inputSchema: timelineSchema,
    },
    sessions.timeline,
  );
  server.registerTool(
    'memory.capture_passive',
    {
      description:
        'Extract numbered/bulleted items from a `## Key Learnings:` section in the given text and save each as a separate memory (type=reference). No-op when no learnings block is found.',
      inputSchema: capturePassiveSchema,
    },
    sessions.capturePassive,
  );
  server.registerTool(
    'memory.save_prompt',
    {
      description:
        "Persist the user's most recent prompt for the active session/project so future sessions can read it via memory.context.recentPrompts. Call this when the user states a goal or constraint worth remembering.",
      inputSchema: savePromptSchema,
    },
    sessions.savePrompt,
  );
  server.registerTool(
    'memory.doctor',
    {
      description:
        'Read-only operational diagnostics. Returns DB/LLM/embeddings/consolidation health plus warnings. Use at session start when behavior seems off.',
      inputSchema: {},
    },
    sessions.doctor,
  );
  server.registerTool(
    'memory.stats',
    {
      description:
        'Read-only counters: memoriesByStatus, memoriesByType, sessionsByStatus, scoped to the active project (or global).',
      inputSchema: {},
    },
    sessions.stats,
  );

  // ── Project management tools ──────────────────────────────────────
  // The handlers receive a back-reference to the McpServer instance via
  // `getServer` so the roots-discovery helper can call
  // `server.server.listRoots()` on the underlying transport.
  const projectHandlers = buildProjectHandlers({
    db: opts.db,
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
    },
    projectHandlers.use,
  );
  server.registerTool(
    'project.list',
    {
      description:
        'List existing projects and their memory counts. Use when the user references a project that may not be active in this session.',
      inputSchema: projectListSchema,
    },
    projectHandlers.list,
  );
  server.registerTool(
    'project.current',
    {
      description:
        'Report the project active in this session (slug, projectId, source) plus any pending suggestedSlugs surfaced by roots-based discovery.',
      inputSchema: projectCurrentSchema,
    },
    projectHandlers.current,
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
