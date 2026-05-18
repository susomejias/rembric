// Tool registrations for the Rembric OpenClaw plugin.
//
// Each entry declares the OpenClaw tool name (underscore form, mirrored
// in openclaw.plugin.json::contracts.tools), the MCP tool name it
// forwards to (dot form, as registered in src/mcp/server.ts), a short
// description, and the JSON-schema for `parameters` (mirroring
// OpenClaw's `api.registerTool` field names — see
// /tmp/openclaw/src/plugins/types.ts and /tmp/openclaw/extensions/
// memory-lancedb/index.ts for the canonical shape).
//
// The execute handler forwards args to the MCP client and surfaces
// the result. `ok: false` responses throw an Error so OpenClaw renders
// the message as a tool error per its tool-call contract.

const TOOLS = [
  {
    name: 'memory_save',
    mcp: 'memory.save',
    description:
      'Save a memory. Returns { id, candidates? }. When candidates is non-empty, judge each via memory_judge.',
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: { type: 'object', additionalProperties: false },
  },
  {
    name: 'memory_session_start',
    mcp: 'memory.session_start',
    description: 'Start an agent session row.',
    parameters: {
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
    parameters: { type: 'object', additionalProperties: false },
  },
  {
    name: 'memory_session_summary',
    mcp: 'memory.session_summary',
    description: 'Write end-of-session summary + title. Call before saying "done".',
    parameters: {
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
    parameters: {
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
    parameters: {
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
    parameters: { type: 'object', additionalProperties: false },
  },
  {
    name: 'project_list',
    mcp: 'project.list',
    description: 'List visible projects.',
    parameters: {
      type: 'object',
      properties: { includeArchived: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'project_use',
    mcp: 'project.use',
    description: 'Switch the active project for subsequent memory.* calls.',
    parameters: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
];

export const TOOL_DEFINITIONS = TOOLS;

function humanLabel(name) {
  return name
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export function registerTools(api, mcpClient) {
  if (typeof api.registerTool !== 'function') {
    api.logger?.warn?.('rembric: api.registerTool unavailable, skipping tool registrations');
    return 0;
  }
  let registered = 0;
  for (const tool of TOOLS) {
    try {
      api.registerTool({
        name: tool.name,
        label: humanLabel(tool.name),
        description: tool.description,
        parameters: tool.parameters,
        async execute(_toolCallId, params) {
          const result = await mcpClient.callTool(tool.mcp, params ?? {});
          if (!result.ok) {
            throw new Error(`${tool.name}: ${result.code} — ${result.message}`);
          }
          // MCP `tools/call` results are already in `{ content: [...] }`
          // shape, which is what OpenClaw expects from tool.execute. Pass
          // through directly.
          return result.data;
        },
      });
      registered++;
    } catch (err) {
      api.logger?.warn?.(`rembric: api.registerTool failed for "${tool.name}": ${String(err)}`);
    }
  }
  return registered;
}
