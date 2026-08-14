import { keyHint } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

// These two specifiers are rewritten to `./bin/` at publish time.
import { readRembricSlug } from '../bin/rembric-dotenv.mjs';
import type { SessionProtocol } from '../bin/rembric-plugin-core.mjs';
import {
  createSessionProtocol,
  diag,
  POST_TIMEOUT_MS,
  underscoreToolNames,
} from '../bin/rembric-plugin-core.mjs';

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
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<ToolExecuteResult>;
  renderCall?: (args: unknown, theme: ThemeLike, context: ToolRenderContext) => RenderComponent;
  renderResult?: (
    result: ToolExecuteResult,
    options: ToolRenderResultOptions,
    theme: ThemeLike,
    context: ToolRenderContext,
  ) => RenderComponent;
};

// `ui` is optional because the extension is installed into whatever harness
// version the operator has, and a missing diagnostic channel must not cost them
// a working extension.
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
  message?: { role?: string; content?: unknown };
};

// `reason` is a plain optional string, not the harness's five-member union: a
// union types the non-member branch out of existence, and that branch is what
// keeps a future sixth reason from ending a session that is still running.
type SessionShutdownEvent = { reason?: string; targetSessionFile?: string };

type ExtensionApi = {
  registerTool: (definition: ToolDefinition) => void;
  on: <E>(event: string, handler: (event: E, ctx: ExtensionContext) => unknown) => void;
};

type DiscoveredTool = { name: string; description?: string; inputSchema: JsonSchema };

const CLIENT_NAME = 'rembric-pi';
const PROTOCOL_VERSION = '2025-06-18';
const DISCOVERY_TIMEOUT_MS = 10_000;

// Membership, never `reason !== 'reload'`: an unrecognised reason must fail
// toward not ending, because no path returns a session to `active` while a
// session left active is retired by the server's stale-active sweep.
const CLOSING_SHUTDOWN_REASONS = new Set(['quit', 'new', 'resume', 'fork']);

// One deadline for the whole handshake, not one per request: the harness awaits
// the factory and `session_start`, so per-request timeouts would sum. Read per
// use, so an override set after this module loads still wins.
function discoveryDeadline(): AbortSignal {
  return AbortSignal.timeout(
    Number(process.env.REMBRIC_DISCOVERY_TIMEOUT_MS ?? DISCOVERY_TIMEOUT_MS),
  );
}

function createMcpClient(endpoint: string, apiToken: string) {
  let mcpSessionId: string | null = null;
  let negotiatedVersion = PROTOCOL_VERSION;
  let nextId = 1;
  let serverInstructions: string | null = null;

  function headers(): Record<string, string> {
    const out: Record<string, string> = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': negotiatedVersion,
    };
    if (mcpSessionId) out['mcp-session-id'] = mcpSessionId;
    return out;
  }

  function decode(body: string): Record<string, unknown> | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
      return JSON.parse(trimmed) as Record<string, unknown>;
    }
    for (const line of trimmed.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload) return JSON.parse(payload) as Record<string, unknown>;
    }
    return null;
  }

  async function send(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const id = nextId++;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: headers(),
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
      // Not awaited: a path-scoped connection is already bound to its project,
      // so nothing downstream depends on the notification landing.
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
    ): Promise<{ text: string; isError: boolean }> {
      const result = await send('tools/call', { name, arguments: args }, signal);
      const content = (result.content as ToolContent[] | undefined) ?? [];
      const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
      return { text, isError: result.isError === true };
    },

    // Bounded by the flush budget, not the discovery deadline: this DELETE is
    // awaited alongside the final summary POST on the way out.
    async close(): Promise<void> {
      if (!mcpSessionId) return;
      await fetch(endpoint, {
        method: 'DELETE',
        headers: headers(),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).catch(() => {
        // Deliberate: the process is exiting, and a failed teardown costs the
        // server one idle transport, which it drops on close.
      });
    },
  };
}

type McpClient = ReturnType<typeof createMcpClient>;

// `description` strings only: enum members, patterns and property names are
// argument values a rename would corrupt.
function renameToolsInDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(renameToolsInDescriptions);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === 'description' && typeof value === 'string'
        ? underscoreToolNames(value)
        : renameToolsInDescriptions(value);
  }
  return out;
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

// Resuming the session already open emits `reason: "resume"` with the same id,
// so the reason alone cannot tell replacement-by-another from replacement-by-
// itself. Compared only when the event names a file: on `quit` it is absent, and
// a bare comparison would read `undefined === undefined` and suppress the end.
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

export default function rembric(pi: ExtensionApi): void {
  let core: SessionProtocol | null = null;
  let mcp: McpClient | null = null;

  pi.on('session_start', async (_event, ctx) => {
    if (core) return;

    const cwd = ctx.cwd;
    const slug = readRembricSlug(cwd);
    const apiToken = process.env.REMBRIC_API_TOKEN ?? '';
    const protocol = createSessionProtocol({
      agent: 'pi',
      serverUrl: process.env.REMBRIC_SERVER_URL,
      apiToken,
      slug,
      cwd,
    });
    if (protocol.disabled) {
      ctx.ui?.notify(
        `Rembric is off — ${protocol.disabledReason}. Fix it and restart Pi.`,
        'warning',
      );
      return;
    }

    const client = createMcpClient(`${protocol.baseUrl}/mcp/${slug}`, apiToken);
    core = protocol;
    mcp = client;

    try {
      const deadline = discoveryDeadline();
      await client.initialize(deadline);
      for (const tool of await client.listTools(deadline)) {
        // A provider refuses the whole tools payload if one name contains a
        // `.`, so registration is underscored and `tools/call` keeps the
        // canonical name, which `label` carries.
        pi.registerTool({
          name: tool.name.replace(/\./g, '_'),
          label: tool.name,
          description: underscoreToolNames(tool.description ?? tool.name),
          parameters: renameToolsInDescriptions(tool.inputSchema) as JsonSchema,
          execute: async (_toolCallId, params, signal) => {
            const { text, isError } = await client.callTool(
              tool.name,
              (params ?? {}) as Record<string, unknown>,
              signal,
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
  });

  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = event.prompt ?? '';
    await core.ensureSession(sessionId);
    core.appendUserMessage(sessionId, prompt);

    const result: BeforeAgentStartResult = {};

    // Pi hands every turn its BASE system prompt and resets the override when no
    // extension returns one, so returning it each turn is what keeps it there;
    // the `includes` guard keeps it at once per turn regardless.
    const instructions = mcp?.instructions() ?? null;
    const base = event.systemPrompt ?? '';
    if (instructions && !base.includes(instructions)) {
      result.systemPrompt = base ? `${base}\n\n${instructions}` : instructions;
    }

    const lines = core.nudgesForTurn(sessionId, prompt).map(underscoreToolNames);
    if (lines.length > 0) {
      result.message = { customType: 'rembric', content: lines.join('\n'), display: false };
    }
    return result.systemPrompt === undefined && result.message === undefined ? undefined : result;
  });

  pi.on('message_end', (event: MessageEndEvent, ctx) => {
    if (!core) return;
    if (event.message?.role !== 'assistant') return;
    const text = assistantText(event.message.content);
    if (!text) return;
    core.appendAssistantMessage(ctx.sessionManager.getSessionId(), text);
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!core) return;
    core.scheduleIdleFlush(ctx.sessionManager.getSessionId());
  });

  pi.on('session_shutdown', async (event: SessionShutdownEvent, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const closes = CLOSING_SHUTDOWN_REASONS.has(event.reason ?? '') && !isSelfResume(event, ctx);
    await Promise.all([
      closes ? core.endSession(sessionId) : core.flushSessionSummary(sessionId),
      mcp?.close(),
    ]);
    // After the flush, and only reachable on a teardown the process survives:
    // otherwise a pending debounce timer re-POSTs what just landed.
    core.forgetSession(sessionId);
  });
}
