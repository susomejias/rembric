import { keyHint } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

// These specifiers are rewritten to `./bin/` at publish time.
import type { SessionProtocol } from '../bin/rembric-plugin-core.mjs';
import {
  createSessionProtocol,
  diag,
  extractCommandPaths,
  RARELY_USED_TOOLS,
  underscoreToolNames,
} from '../bin/rembric-plugin-core.mjs';
import { HOST_SESSION_HEADER } from '../mcp-bridge/rembric-host-binding.mjs';
import { FINGERPRINT_HEADER, resolveProject } from '../mcp-bridge/rembric-project.mjs';

type JsonSchema = Record<string, unknown>;

type ToolContent = { type: string; text?: string };

type ToolExecuteResult = {
  content: ToolContent[];
  details: unknown;
};

type ToolRenderResultOptions = { expanded: boolean; isPartial: boolean };

type ToolRenderContext = { isError: boolean; expanded: boolean; isPartial: boolean };

type ThemeLike = { fg: (color: string, text: string) => string; bold: (text: string) => string };

type RenderComponent = { render: (width: number) => string[]; invalidate: () => void };

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  exposure?: 'deferred';
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ExtensionContext,
  ) => Promise<ToolExecuteResult>;
  renderCall?: (args: unknown, theme: ThemeLike, context: ToolRenderContext) => RenderComponent;
  renderResult?: (
    result: ToolExecuteResult,
    options: ToolRenderResultOptions,
    theme: ThemeLike,
    context: ToolRenderContext,
  ) => RenderComponent;
};

type ExtensionContext = {
  cwd: string;
  sessionManager: { getSessionId: () => string; getSessionFile?: () => string | undefined };
  ui?: { notify: (message: string, type?: 'info' | 'warning' | 'error') => void };
};

type BeforeAgentStartEvent = { prompt?: string; systemPrompt?: string };

type BeforeAgentStartResult = {
  message?: { customType: string; content: string; display: boolean };
  systemPrompt?: string;
};

type MessageEndEvent = {
  message?: { role?: string; content?: unknown; customType?: string };
};

type ToolExecutionEndEvent = {
  toolName: string;
  result?: { content?: unknown };
  isError?: boolean;
};

type SessionShutdownEvent = { reason?: string; targetSessionFile?: string };

type ToolCallEvent = { toolCallId: string; toolName: string; input?: Record<string, unknown> };

type ToolResultEvent = { toolCallId: string; content?: ToolContent[]; structuredContent?: unknown };

type ToolResultEventResult = { content: ToolContent[]; structuredContent?: unknown };

type HostToolInfo = { name: string; reachesTools?: unknown };

type ExtensionApi = {
  registerTool: (definition: ToolDefinition) => void;
  on: <E>(event: string, handler: (event: E, ctx: ExtensionContext) => unknown) => void;
  getAllTools?: () => HostToolInfo[];
  getActiveTools?: () => string[];
  setActiveTools?: (names: string[]) => void;
};

type DiscoveredTool = { name: string; description?: string; inputSchema: JsonSchema };

const CLIENT_NAME = 'rembric-pi';
const PROTOCOL_VERSION = '2025-06-18';
const DISCOVERY_TIMEOUT_MS = 10_000;

const CLOSING_SHUTDOWN_REASONS = new Set(['quit', 'new', 'resume', 'fork']);
const PI_SUBAGENTS_CHILD_TAG = '<active_agent name=';
const TOOL_SEARCH = 'tool_search';

const SUBAGENT_SURFACES = {
  tools: new Set(['subagent', 'subagent_run', 'subagent_continue', 'subagent_result']),
  messages: new Set(['subagent-notify', 'gentle-agents.message']),
};

function discoveryDeadline(): AbortSignal {
  return AbortSignal.timeout(
    Number(process.env.REMBRIC_DISCOVERY_TIMEOUT_MS ?? DISCOVERY_TIMEOUT_MS),
  );
}

function createMcpClient(endpoint: string, apiToken: string, fingerprint: string | null) {
  let mcpSessionId: string | null = null;
  let negotiatedVersion = PROTOCOL_VERSION;
  let nextId = 1;
  let serverInstructions: string | null = null;

  function headers(declaredSession: string | null = null): Record<string, string> {
    const out: Record<string, string> = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': negotiatedVersion,
    };
    if (mcpSessionId) out['mcp-session-id'] = mcpSessionId;
    if (fingerprint) out[FINGERPRINT_HEADER] = fingerprint;
    if (declaredSession) out[HOST_SESSION_HEADER] = declaredSession;
    return out;
  }

  function parseMcpJson(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`malformed MCP response body: ${(err as Error).message}`, { cause: err });
    }
  }

  function decode(body: string): Record<string, unknown> | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
      return parseMcpJson(trimmed);
    }
    for (const line of trimmed.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload) return parseMcpJson(payload);
    }
    return null;
  }

  async function send(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    declaredSession: string | null = null,
  ): Promise<Record<string, unknown>> {
    const id = nextId++;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: headers(declaredSession),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`${method} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const sessionHeader = res.headers.get('mcp-session-id');
    if (sessionHeader) mcpSessionId = sessionHeader;
    const message = decode(body);
    const error = message?.error as { message?: string; code?: number } | undefined;
    if (error) {
      throw new Error(`${method} failed: ${error.message ?? `code ${String(error.code)}`}`);
    }
    return (message?.result as Record<string, unknown>) ?? {};
  }

  return {
    async initialize(deadline: AbortSignal): Promise<void> {
      const result = await send(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: '0' },
        },
        deadline,
      );
      if (typeof result.protocolVersion === 'string') negotiatedVersion = result.protocolVersion;
      if (typeof result.instructions === 'string' && result.instructions) {
        serverInstructions = underscoreToolNames(result.instructions);
      }
      void fetch(endpoint, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: deadline,
      }).catch(() => {});
    },

    instructions(): string | null {
      return serverInstructions;
    },

    async listTools(deadline: AbortSignal): Promise<DiscoveredTool[]> {
      const tools: DiscoveredTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await send('tools/list', cursor ? { cursor } : {}, deadline);
        tools.push(...((page.tools as DiscoveredTool[] | undefined) ?? []));
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      } while (cursor);
      return tools;
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      declaredSession: string | null = null,
    ): Promise<{ text: string; isError: boolean }> {
      const result = await send('tools/call', { name, arguments: args }, signal, declaredSession);
      const content = (result.content as ToolContent[] | undefined) ?? [];
      const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
      return { text, isError: result.isError === true };
    },
  };
}

type McpClient = ReturnType<typeof createMcpClient>;

function declaresSessionId(schema: JsonSchema): boolean {
  const properties = schema.properties;
  return typeof properties === 'object' && properties !== null && 'sessionId' in properties;
}

function renameToolsInDescriptions<T>(node: T): T {
  if (Array.isArray(node)) return node.map((item) => renameToolsInDescriptions(item)) as T;
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === 'description' && typeof value === 'string'
        ? underscoreToolNames(value)
        : renameToolsInDescriptions(value);
  }
  return out as T;
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is ToolContent => typeof part === 'object' && part !== null)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

function messageIndicatesToolUse(message: MessageEndEvent['message']): boolean {
  if (!message) return false;
  if (message.role === 'toolResult') return true;
  if (message.role !== 'assistant') return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      typeof part === 'object' && part !== null && (part as ToolContent).type === 'toolCall',
  );
}

function isSelfResume(event: SessionShutdownEvent, ctx: ExtensionContext): boolean {
  const target = event.targetSessionFile;
  if (typeof target !== 'string' || target.length === 0) return false;
  return target === ctx.sessionManager.getSessionFile?.();
}

export function renderToolResultLines(
  text: string,
  expanded: boolean,
  isError: boolean,
  canonicalName: string,
  keyHintText: string,
  theme: ThemeLike,
): string[] {
  if (expanded) return text.split('\n');
  const count = text.split('\n').length;
  const outcome = theme.fg(
    isError ? 'error' : 'success',
    `${isError ? '✗' : '✓'} ${theme.bold(canonicalName)}`,
  );
  const size = theme.fg('muted', ` · ${count} ${count === 1 ? 'line' : 'lines'} · `);
  return [`${outcome}${size}${keyHintText}`];
}

/** The files a built-in read/edit/write/bash call names, before any repository check. */
export function toolCallPaths(event: ToolCallEvent): string[] {
  const input = event.input ?? {};
  if (['read', 'edit', 'write'].includes(event.toolName)) {
    return typeof input.path === 'string' && input.path ? [input.path] : [];
  }
  if (event.toolName === 'bash') {
    return typeof input.command === 'string' ? extractCommandPaths(input.command) : [];
  }
  return [];
}

export default function rembric(pi: ExtensionApi): void {
  let core: SessionProtocol | null = null;
  let mcp: McpClient | null = null;
  const declaredChild =
    process.env.REMBRIC_SUBAGENT === '1' ||
    process.env.GENTLE_PI_AGENTS_CHILD === '1' ||
    process.env.PI_SUBAGENT_CHILD === '1';
  const trackForced = process.env.REMBRIC_TRACK_SESSION === '1';
  const pendingFileRecall = new Map<string, Promise<string[]>>();

  function registeredHostSessionId(ctx: ExtensionContext | undefined): string | null {
    if (!core || !ctx) return null;
    const hostSessionId = ctx.sessionManager.getSessionId();
    return core.isRegistered(hostSessionId) ? hostSessionId : null;
  }

  function withHostSessionId(
    params: Record<string, unknown>,
    hostSessionId: string | null,
  ): Record<string, unknown> {
    if (params.sessionId !== undefined || !hostSessionId) return params;
    return { ...params, sessionId: hostSessionId };
  }

  // A deferred tool is reachable only through an active tool_search; without one it would vanish.
  function activateToolSearch(): boolean {
    try {
      if (!pi.getAllTools || !pi.getActiveTools || !pi.setActiveTools) return false;
      const all = pi.getAllTools();
      if (!all.some((tool) => tool.name === TOOL_SEARCH && Boolean(tool.reachesTools)))
        return false;
      const active = pi.getActiveTools();
      if (!active.includes(TOOL_SEARCH)) pi.setActiveTools([...active, TOOL_SEARCH]);
      return true;
    } catch (err) {
      diag(`tool deferral skipped: ${err instanceof Error ? err.message : 'error'}`);
      return false;
    }
  }

  async function discoverTools(client: McpClient, ctx: ExtensionContext): Promise<void> {
    try {
      const deadline = discoveryDeadline();
      await client.initialize(deadline);
      const tools = await client.listTools(deadline);
      const canDefer = activateToolSearch();
      for (const tool of tools) {
        const attachesSession = declaresSessionId(tool.inputSchema);
        const deferred = canDefer && RARELY_USED_TOOLS.includes(tool.name);
        pi.registerTool({
          name: tool.name.replace(/\./g, '_'),
          label: tool.name,
          description: underscoreToolNames(tool.description ?? tool.name),
          parameters: renameToolsInDescriptions(tool.inputSchema) as JsonSchema,
          ...(deferred && { exposure: 'deferred' as const }),
          execute: async (_toolCallId, params, signal, _onUpdate, toolCtx) => {
            const args = (params ?? {}) as Record<string, unknown>;
            const hostSessionId = registeredHostSessionId(toolCtx);
            const { text, isError } = await client.callTool(
              tool.name,
              attachesSession ? withHostSessionId(args, hostSessionId) : args,
              signal,
              hostSessionId,
            );
            if (isError) throw new Error(text);
            return { content: [{ type: 'text', text }], details: undefined };
          },
          renderCall: (_args, theme) =>
            new Text(theme.fg('toolTitle', theme.bold(tool.name)), 0, 0),
          renderResult: (result, options, theme, context) => {
            const text = (result.content ?? [])
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('\n');
            const lines = renderToolResultLines(
              text,
              options.expanded,
              context.isError,
              tool.name,
              keyHint('app.tools.expand', 'to expand'),
              theme,
            );
            const body = lines.join('\n');
            return new Text(options.expanded ? theme.fg('toolOutput', body) : body, 0, 0);
          },
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'error';
      diag(`tool discovery failed: ${detail}`);
      ctx.ui?.notify(`Rembric tools unavailable — ${detail}`, 'error');
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (core || mcp) return;

    const cwd = ctx.cwd;
    const serverUrl = process.env.REMBRIC_SERVER_URL;
    const apiToken = process.env.REMBRIC_API_TOKEN ?? '';
    const project = await resolveProject({ startDir: cwd, env: process.env, serverUrl, apiToken });

    if (project.mode === 'unbound' && serverUrl) {
      diag(project.message);
      ctx.ui?.notify(`Rembric: ${project.message}`, 'warning');
      mcp = createMcpClient(`${serverUrl.replace(/\/$/, '')}/mcp`, apiToken, project.header);
      await discoverTools(mcp, ctx);
      return;
    }

    const slug = project.mode === 'project' ? project.slug : null;
    const protocol = createSessionProtocol({
      agent: 'pi',
      serverUrl,
      apiToken,
      slug,
      cwd,
      projectIssue: project.mode === 'refused' ? project.message : null,
    });
    if (protocol.disabled) {
      ctx.ui?.notify(
        `Rembric is off — ${protocol.disabledReason}. Fix it and restart Pi.`,
        'warning',
      );
      return;
    }
    if (project.conflict && project.message) {
      diag(project.message);
      ctx.ui?.notify(`Rembric: ${project.message}`, 'warning');
    }

    const client = createMcpClient(`${protocol.baseUrl}/mcp/${slug}`, apiToken, project.header);
    core = protocol;
    mcp = client;
    await discoverTools(client, ctx);
  });

  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = event.prompt ?? '';
    const suppress =
      !trackForced &&
      (declaredChild ||
        ctx.mode === 'rpc' ||
        (event.systemPrompt ?? '').includes(PI_SUBAGENTS_CHILD_TAG));
    if (suppress) core.markSubAgent(sessionId);
    core.beginTurn(sessionId);
    await core.ensureSession(sessionId);
    core.appendUserMessage(sessionId, prompt);

    const result: BeforeAgentStartResult = {};

    const instructions = suppress ? null : (mcp?.instructions() ?? null);
    const base = event.systemPrompt ?? '';
    if (instructions && !base.includes(instructions)) {
      result.systemPrompt = base ? `${base}\n\n${instructions}` : instructions;
    }

    const lines = core.nudgesForTurn(sessionId, prompt).map(underscoreToolNames);
    if (prompt) {
      for (const hint of await core.recallHints(sessionId, prompt)) {
        lines.push(underscoreToolNames(hint));
      }
    }
    if (lines.length > 0) {
      result.message = { customType: 'rembric', content: lines.join('\n'), display: false };
    }
    return result.systemPrompt === undefined && result.message === undefined ? undefined : result;
  });

  pi.on('message_end', (event: MessageEndEvent, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (messageIndicatesToolUse(event.message)) core.markToolUsed(sessionId);
    if (
      event.message?.role === 'custom' &&
      SUBAGENT_SURFACES.messages.has(event.message.customType ?? '')
    ) {
      void core.postSubagentReport(sessionId, assistantText(event.message.content));
      return;
    }
    if (event.message?.role !== 'assistant') return;
    const text = assistantText(event.message.content);
    if (!text) return;
    core.appendAssistantMessage(sessionId, text);
  });

  pi.on('tool_execution_end', (event: ToolExecutionEndEvent, ctx) => {
    if (!core || event.isError || !SUBAGENT_SURFACES.tools.has(event.toolName)) return;
    void core.postSubagentReport(
      ctx.sessionManager.getSessionId(),
      assistantText(event.result?.content),
    );
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    void core.reportTurn(sessionId);
    core.scheduleIdleFlush(sessionId);
  });

  // A tool_call failure blocks the tool, so this handler only starts the lookup and never throws.
  pi.on('tool_call', (event: ToolCallEvent, ctx) => {
    try {
      if (!core) return;
      const candidates = toolCallPaths(event);
      if (candidates.length === 0) return;
      const sessionId = ctx.sessionManager.getSessionId();
      pendingFileRecall.set(
        event.toolCallId,
        core.fileRecall(sessionId, ctx.cwd, candidates).catch(() => []),
      );
    } catch (err) {
      diag(`file recall skipped: ${err instanceof Error ? err.message : 'error'}`);
    }
  });

  pi.on(
    'tool_result',
    async (event: ToolResultEvent): Promise<ToolResultEventResult | undefined> => {
      const pending = pendingFileRecall.get(event.toolCallId);
      if (!pending) return undefined;
      pendingFileRecall.delete(event.toolCallId);
      const lines = await pending;
      if (lines.length === 0) return undefined;
      return {
        content: [...(event.content ?? []), { type: 'text', text: lines.join('\n') }],
        ...(event.structuredContent !== undefined && {
          structuredContent: event.structuredContent,
        }),
      };
    },
  );

  pi.on('session_shutdown', async (event: SessionShutdownEvent, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const closes = CLOSING_SHUTDOWN_REASONS.has(event.reason ?? '') && !isSelfResume(event, ctx);
    await (closes ? core.endSession(sessionId) : core.flushSessionSummary(sessionId));
    core.forgetSession(sessionId);
    pendingFileRecall.clear();
  });
}
