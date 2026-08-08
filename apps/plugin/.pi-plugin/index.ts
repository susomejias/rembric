// The shutdown flush is awaited rather than fire-and-forget: Pi awaits its
// shutdown handler with no timeout (measured against 0.84.1). Ctrl-C reaches
// that handler in neither print nor interactive mode; Ctrl-D, SIGTERM and
// SIGHUP do, and the per-turn flush bounds the loss at one turn.
//
// The nudge texts, `<private>` redaction, transcript accumulator and flush
// helpers are imported from the shared core — this client declares no copy of
// any of them. The published tarball carries the shared files, so the CI
// materialisation step rewrites the two relative dev-time imports below to
// their in-tarball paths, exactly as each install.sh already does.
//
// Because this client registers the server's tools under a provider-safe name
// (each dot becomes an underscore), it also owns renaming them in every
// model-facing string it publishes: the tool descriptions, the nudges and the
// server's `initialize.instructions`. The prompt templates get the same
// treatment in their packaged copies (scripts/pi-package.mjs). All of it goes
// through the core's single `underscoreToolNames`.
//
// The harness's types are not imported: `@earendil-works/pi-coding-agent` is
// a peer dependency present only on a user's machine, and this directory is
// outside the repo's pnpm workspace. The structural types below cover the
// surface used here.

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
  isError?: true;
};

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
};

type ExtensionContext = {
  cwd: string;
  sessionManager: { getSessionId: () => string };
};

type BeforeAgentStartEvent = { prompt?: string; systemPrompt?: string };

type BeforeAgentStartResult = {
  message?: { customType: string; content: string; display: boolean };
  systemPrompt?: string;
};

type MessageEndEvent = {
  message?: { role?: string; content?: unknown };
};

type ExtensionApi = {
  registerTool: (definition: ToolDefinition) => void;
  on: <E>(event: string, handler: (event: E, ctx: ExtensionContext) => unknown) => void;
};

type DiscoveredTool = { name: string; description?: string; inputSchema: JsonSchema };

const CLIENT_NAME = 'rembric-pi';
const PROTOCOL_VERSION = '2025-06-18';
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * ONE deadline for the whole handshake, passed to every request in it: the
 * harness awaits the factory and `session_start`, so per-request timeouts
 * would add up in series and the real ceiling on startup would be their sum.
 * A `tools/call` carries the harness's own signal instead, because a search
 * legitimately takes longer than a handshake. Read per use, not once: an
 * override set after this module loads still wins.
 */
function discoveryDeadline(): AbortSignal {
  return AbortSignal.timeout(
    Number(process.env.REMBRIC_DISCOVERY_TIMEOUT_MS ?? DISCOVERY_TIMEOUT_MS),
  );
}

/**
 * Minimal Streamable HTTP MCP client. The transport carries the
 * `mcp-session-id` the server mints at initialize, and a POST answered with
 * SSE is read to completion and its single `data:` frame decoded.
 */
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
      // The other four clients let their host inject this into the system
      // prompt on connect; here the extension IS the MCP client, so dropping
      // it would lose the server's whole proactive-use crib-sheet.
      if (typeof result.instructions === 'string' && result.instructions) {
        serverInstructions = underscoreToolNames(result.instructions);
      }
      // Not awaited: a path-scoped connection is already bound to its project
      // (apps/server/src/mcp/_shared.ts), so nothing downstream waits on it.
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

    // The flush budget, not the discovery one: Pi awaits its shutdown handler
    // with no timeout of its own, and this DELETE is awaited alongside the
    // final summary POST. A teardown whose failure costs the server one idle
    // transport does not deserve a longer share of the user's exit than the
    // POST that carries the session's last turn.
    async close(): Promise<void> {
      if (!mcpSessionId) return;
      await fetch(endpoint, {
        method: 'DELETE',
        headers: headers(),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).catch(() => {
        // The process is exiting; a failed teardown costs the server one
        // idle transport, which it drops on close.
      });
    },
  };
}

type McpClient = ReturnType<typeof createMcpClient>;

/**
 * Rewrites the tool names inside every `description` in a JSON Schema, and
 * nothing else: the descriptions are guidance the provider shows the model and
 * they cite sibling tools, while enum members, patterns and property names are
 * argument values that a rename would corrupt. A tool RESULT is likewise never
 * rewritten — a memory's content is the user's own text and may legitimately
 * contain a dotted name.
 */
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
    if (protocol.disabled) return;

    const client = createMcpClient(`${protocol.baseUrl}/mcp/${slug}`, apiToken);
    core = protocol;
    mcp = client;

    try {
      const deadline = discoveryDeadline();
      await client.initialize(deadline);
      for (const tool of await client.listTools(deadline)) {
        // Registered under the provider-safe name: a real provider refuses the
        // entire tools payload if one name contains a `.`, leaving the harness
        // with no usable tool at all. `tools/call` keeps the canonical name.
        //
        // The rename reaches the descriptions too, because they name sibling
        // tools and the model can only call what this registry holds. Renaming
        // the keys and leaving the guidance dotted would point every
        // cross-reference at a tool that does not exist here.
        //
        // The registered name replaces every dot unconditionally, while the
        // guidance goes through the namespace-aware rename that must not touch
        // prose — provider-safety cannot depend on a namespace list. The test
        // asserts the two agree, so a namespace the list misses fails loudly
        // instead of shipping unrenamed guidance.
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
            return {
              content: [{ type: 'text', text }],
              details: undefined,
              ...(isError ? { isError: true as const } : {}),
            };
          },
        });
      }
    } catch (err) {
      diag(`tool discovery failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  });

  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const prompt = event.prompt ?? '';
    await core.ensureSession(sessionId);
    core.appendUserMessage(sessionId, prompt);

    const result: BeforeAgentStartResult = {};

    // Appended to the prompt the event carries rather than injected once as a
    // message: Pi hands every turn its BASE system prompt and resets the
    // override whenever no extension returns one (core/agent-session.js), so
    // returning it each turn is what keeps it there, and it lands exactly once
    // per turn. The `includes` guard makes that independent of Pi's reset.
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

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!core) return;
    const sessionId = ctx.sessionManager.getSessionId();
    await Promise.all([core.flushSessionSummary(sessionId), mcp?.close()]);
    // After the flush: on a teardown the process survives, a pending debounce
    // timer would otherwise re-POST what just landed.
    core.forgetSession(sessionId);
  });
}
