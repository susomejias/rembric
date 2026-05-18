// Tool registrations for the Rembric OpenClaw plugin.
//
// Each entry declares the OpenClaw tool name (underscore form, mirrored
// in openclaw.plugin.json::contracts.tools), the MCP tool name it
// forwards to (dot form, as registered in src/mcp/server.ts), a short
// description, and the JSON-schema for `arguments`.
//
// The handler forwards args to the MCP client and surfaces the result.
// `ok: false` responses throw an Error so OpenClaw renders the message
// as a tool error per its tool-call contract.

const TOOLS = [
  {
    name: 'memory_save',
    mcp: 'memory.save',
    description:
      'Save a memory. Returns { id, candidates? }. When candidates is non-empty, judge each via memory_judge.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        content: { type: 'string', minLength: 1 },
        topic_key: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'project'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    mcp: 'memory.search',
    description: 'FTS5 keyword + vector search. Returns memories with snippet and score.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'number' },
        offset: { type: 'number' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        status: { type: 'string', enum: ['active', 'superseded', 'archived'] },
        tag: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    mcp: 'memory.get',
    description: 'Fetch a memory by id, with replaces/replaced_by lineage.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_judge',
    mcp: 'memory.judge',
    description:
      'Judge a pending relation candidate. Verdicts: not_conflict | supersedes | superseded_by.',
    inputSchema: {
      type: 'object',
      properties: {
        relation_id: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['not_conflict', 'supersedes', 'superseded_by'],
        },
        rationale: { type: 'string' },
      },
      required: ['relation_id', 'verdict'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_confirm',
    mcp: 'memory.confirm',
    description: 'Confirm that a memory was applied (bumps confidence).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_compare',
    mcp: 'memory.compare',
    description: 'Compare two memory ids: returns kind, score, summary.',
    inputSchema: {
      type: 'object',
      properties: { source_id: { type: 'string' }, target_id: { type: 'string' } },
      required: ['source_id', 'target_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_context',
    mcp: 'memory.context',
    description: 'Recent context for this scope: recentSessions + recentMemories + recentPrompts.',
    inputSchema: {
      type: 'object',
      properties: {
        sessions: { type: 'number' },
        memories: { type: 'number' },
        prompts: { type: 'number' },
        includeArchived: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_timeline',
    mcp: 'memory.timeline',
    description: 'Chronological neighbors of a memory (same session or ±2h time window).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, limit: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_stats',
    mcp: 'memory.stats',
    description: 'Counters: memoriesByStatus, memoriesByType, sessionsByStatus.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'memory_session_start',
    mcp: 'memory.session_start',
    description: 'Start an agent session row.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        description: { type: 'string' },
        project: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_session_end',
    mcp: 'memory.session_end',
    description: 'End the active session without a summary.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'memory_session_summary',
    mcp: 'memory.session_summary',
    description: 'Write end-of-session summary + title. Call before saying "done".',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1 },
        title: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save_prompt',
    mcp: 'memory.save_prompt',
    description: 'Persist the latest user prompt for the active session.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_capture_passive',
    mcp: 'memory.capture_passive',
    description: 'Extract `## Key Learnings:` items and save each as reference.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_current',
    mcp: 'project.current',
    description: 'Get the currently-active project for this connection.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'project_list',
    mcp: 'project.list',
    description: 'List visible projects.',
    inputSchema: {
      type: 'object',
      properties: { includeArchived: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'project_use',
    mcp: 'project.use',
    description: 'Switch the active project for subsequent memory.* calls.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
];

export const TOOL_DEFINITIONS = TOOLS;

export function registerTools(api, mcpClient) {
  for (const tool of TOOLS) {
    api.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (args) => {
        const result = await mcpClient.callTool(tool.mcp, args ?? {});
        if (!result.ok) {
          throw new Error(`${tool.name}: ${result.code} — ${result.message}`);
        }
        return result.data;
      },
    });
  }
}
