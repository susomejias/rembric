// x-release-please-start-version
// @rembric-plugin-version 0.33.1
const MCP_BRIDGE_VERSION = '0.33.1';
// x-release-please-end
// cwd-spike-result: plan-a
// dispose-spike-result: fire-and-forget
// ONLY `RembricPlugin` may be exported: opencode invokes every named export as a Plugin function.

import {
  createSessionProtocol,
  diag,
  POST_COMPACT_NUDGE_CORE,
} from '../bin/rembric-plugin-core.mjs';
import { readRembricSlug } from '../mcp-bridge/rembric-dotenv.mjs';

type EventInput = {
  event: {
    type: string;
    properties?: Record<string, unknown>;
  };
};

type ChatMessageInput = { sessionID: string; messageID?: string };
type ChatMessageOutput = {
  parts: Array<{
    id?: string;
    sessionID?: string;
    messageID?: string;
    type: string;
    text?: string;
  }>;
  message: { id?: string; summary?: { title?: string; body?: string } };
};

type MessageUpdatedEventProps = {
  info?: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
};

type MessagePartUpdatedEventProps = {
  part?: {
    id?: string;
    sessionID?: string;
    messageID?: string;
    type?: string;
    text?: string;
  };
};

type SessionIdleEventProps = { sessionID?: string };

type CompactingInput = { sessionID?: string };
type CompactingOutput = { context: string[] };

type PluginContext = { directory: string };

type McpServerConfig = {
  command?: string[];
  [key: string]: unknown;
};

type OpenCodeConfig = {
  mcp?: Record<string, McpServerConfig>;
  [key: string]: unknown;
};

type PluginReturn = {
  config?: (config: OpenCodeConfig) => void;
  event?: (input: EventInput) => Promise<void>;
  'chat.message'?: (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
  'experimental.session.compacting'?: (
    input: CompactingInput,
    output: CompactingOutput,
  ) => Promise<void>;
};

type Plugin = (ctx: PluginContext) => Promise<PluginReturn>;

function nudgePart(
  sessionId: string,
  messageId: string,
  text: string,
): { id: string; sessionID: string; messageID: string; type: 'text'; text: string } {
  // opencode validates the entity-type id prefix on write, so a bare UUID is rejected.
  return {
    id: `prt_${crypto.randomUUID().replace(/-/g, '')}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  };
}

export const RembricPlugin: Plugin = async (ctx) => {
  const slug = readRembricSlug(ctx.directory);
  const core = createSessionProtocol({
    agent: 'opencode',
    serverUrl: process.env.REMBRIC_SERVER_URL,
    apiToken: process.env.REMBRIC_API_TOKEN,
    slug,
    cwd: ctx.directory,
  });

  const assistantMessageIds = new Set<string>();
  const assistantParts = new Map<string, Map<string, string>>();
  const reportedThisTurn = new Set<string>();

  function forgetMessageState(entries: ReadonlyArray<{ id?: string }>): void {
    for (const entry of entries) {
      if (!entry.id) continue;
      assistantMessageIds.delete(entry.id);
      assistantParts.delete(entry.id);
    }
  }

  return {
    config: (config) => {
      const command = ['npx', '-y', `@rembric/mcp-bridge@${MCP_BRIDGE_VERSION}`];
      config.mcp ??= {};
      const rembric = (config.mcp.rembric ??= {
        type: 'local',
        command,
        environment: {
          REMBRIC_SERVER_URL: '{env:REMBRIC_SERVER_URL}',
          REMBRIC_API_TOKEN: '{env:REMBRIC_API_TOKEN}',
        },
        enabled: true,
      });
      rembric.command = command;
    },
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        const info = (event.properties?.info ?? {}) as {
          id?: string;
          parentID?: string;
          title?: string;
        };
        const sessionId = info.id ?? '';
        const parentID = info.parentID ?? '';
        const title = info.title ?? '';
        const isSubAgent = Boolean(parentID) || title.endsWith(' subagent)');

        diag(
          `session.created id=${sessionId} parentID=${parentID} title=${title} subagent=${isSubAgent}`,
        );

        if (!sessionId) return;
        if (isSubAgent) {
          core.markSubAgent(sessionId);
          return;
        }
        await core.ensureSession(sessionId);
      }

      if (event.type === 'session.deleted') {
        const info = (event.properties?.info ?? {}) as { id?: string };
        const sessionId = info.id ?? '';
        if (!sessionId) return;
        reportedThisTurn.delete(sessionId);
        forgetMessageState(core.forgetSession(sessionId));
      }

      if (event.type === 'server.instance.disposed') {
        core.flushAllFireAndForget();
      }

      if (event.type === 'session.compacted') {
        const props = (event.properties ?? {}) as {
          sessionID?: string;
          info?: { id?: string };
        };
        const sessionId = props.sessionID ?? props.info?.id ?? '';
        if (!sessionId) return;
        if (core.isSubAgent(sessionId)) return;
        if (!core.isKnown(sessionId)) return;
        diag(`session.compacted sessionId=${sessionId}`);
        await core.flushSessionSummary(sessionId);
      }

      if (event.type === 'message.updated') {
        const info = (event.properties as MessageUpdatedEventProps | undefined)?.info ?? {};
        const sessionId = info.sessionID ?? '';
        if (!sessionId || core.isSubAgent(sessionId)) return;
        if (!info.id || info.role !== 'assistant') return;
        assistantMessageIds.add(info.id);
      }

      if (event.type === 'message.part.updated') {
        const part = (event.properties as MessagePartUpdatedEventProps | undefined)?.part ?? {};
        // Recorded BEFORE the non-text early return below: a tool part takes that branch.
        if (part.type === 'tool' && part.sessionID) {
          core.markToolUsed(part.sessionID);
        }
        if (part.type !== 'text') return;
        const sessionId = part.sessionID ?? '';
        const messageId = part.messageID ?? '';
        if (!sessionId || !messageId || !part.id) return;
        if (core.isSubAgent(sessionId)) return;
        if (!core.isKnown(sessionId)) return;
        if (!assistantMessageIds.has(messageId)) return;

        let parts = assistantParts.get(messageId);
        if (!parts) {
          parts = new Map<string, string>();
          assistantParts.set(messageId, parts);
        }
        parts.set(part.id, part.text ?? '');

        const joined = Array.from(parts.values()).join('\n').trim();
        if (!joined) return;
        forgetMessageState(core.upsertAssistantMessage(sessionId, messageId, joined));
      }

      if (event.type === 'session.idle') {
        const props = (event.properties as SessionIdleEventProps | undefined) ?? {};
        const sessionId = props.sessionID ?? '';
        if (!sessionId) return;
        if (core.isSubAgent(sessionId)) return;
        if (!core.isKnown(sessionId)) return;
        core.scheduleIdleFlush(sessionId);
        if (!reportedThisTurn.has(sessionId)) {
          reportedThisTurn.add(sessionId);
          void core.reportTurn(sessionId);
        }
      }
    },

    'chat.message': async (input, output) => {
      if (core.isSubAgent(input.sessionID)) return;

      reportedThisTurn.delete(input.sessionID);
      core.beginTurn(input.sessionID);

      // Covers a session resumed without a fresh session.created event.
      await core.ensureSession(input.sessionID);

      const fromParts = output.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n')
        .trim();

      let content = fromParts;
      if (!content) {
        const summary = output.message.summary;
        if (summary) {
          content = `${summary.title ?? ''}\n${summary.body ?? ''}`.trim();
        }
      }

      if (!content) return;
      forgetMessageState(core.appendUserMessage(input.sessionID, content));

      const messageId = input.messageID ?? output.message.id ?? '';
      for (const text of core.nudgesForTurn(input.sessionID, content)) {
        output.parts.push(nudgePart(input.sessionID, messageId, text));
      }

      for (const hint of await core.recallHints(input.sessionID, content)) {
        output.parts.push(nudgePart(input.sessionID, messageId, hint));
      }

      // Same debounce as session.idle — avoids a second uncoordinated POST.
      core.scheduleIdleFlush(input.sessionID);
    },

    'experimental.session.compacting': async (input, output) => {
      if (input.sessionID) {
        await core.ensureSession(input.sessionID);
      }

      output.context.push(POST_COMPACT_NUDGE_CORE + (slug ? `Use project: '${slug}'. ` : ''));
    },
  };
};

// --- opencode 2.x ------------------------------------------------------------------
//
// opencode 2.x does not load the V1 shape above. It resolves a *default* export
// carrying `{ id, setup }` and drives it through the `ctx` domains. The V1 hooks
// stay exported by name because 1.x invokes every named export as a plugin
// function, so the V2 entry point is the default export and must never be named.
//
// Two V2 properties shape the adapter:
//   - There is no `chat.message` part array. Recall and session-opening nudges are
//     delivered as transient system text through the `context` hook, so they never
//     enter the user's persisted turn.
//   - A V2 system part lives for exactly one model request. The injected block is
//     therefore cached per session and re-pushed on every request until the session
//     is compacted or closed, and a cache miss rehydrates from the daemon rather
//     than sending that request without context.

type V2SystemPart = { type: string; text?: string };

type V2PromptInput = {
  readonly sessionID: string;
  readonly messageID?: string;
  prompt: { text?: string };
};

type V2ContextInput = {
  readonly sessionID: string;
  system: V2SystemPart[];
};

interface V2SessionHooks {
  readonly prompt: V2PromptInput;
  readonly context: V2ContextInput;
}

type V2EventEnvelope = {
  type?: string;
  data?: Record<string, unknown>;
  properties?: Record<string, unknown>;
};

type V2ToolExecuteBefore = { readonly sessionID?: string };

type V2PluginContext = {
  readonly app: { readonly version: string };
  readonly location: { readonly directory: string };
  readonly session: {
    hook<Name extends keyof V2SessionHooks>(
      name: Name,
      callback: (input: V2SessionHooks[Name]) => Promise<void> | void,
    ): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
  };
  readonly tool: {
    hook(
      name: 'execute.before',
      callback: (input: V2ToolExecuteBefore) => Promise<void> | void,
    ): Promise<unknown>;
  };
  readonly event: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<V2EventEnvelope>;
  };
};

interface V2Plugin {
  readonly id: string;
  readonly setup: (context: V2PluginContext) => Promise<(() => Promise<void> | void) | void>;
}

// opencode versions event names (`.1`) and may carry the payload under either
// `data` or `properties`.
function unwrapV2Event(raw: V2EventEnvelope): { type: string; data: Record<string, unknown> } {
  return {
    type: (raw.type ?? '').replace(/\.\d+$/, ''),
    data: raw.data ?? raw.properties ?? {},
  };
}

const RembricPluginV2: V2Plugin = {
  id: 'rembric.lifecycle',
  async setup(ctx) {
    const directory = ctx.location.directory;
    const slug = readRembricSlug(directory);
    const core = createSessionProtocol({
      agent: 'opencode',
      serverUrl: process.env.REMBRIC_SERVER_URL,
      apiToken: process.env.REMBRIC_API_TOKEN,
      slug,
      cwd: directory,
    });

    if (core.disabled) {
      diag(`rembric: ${core.disabledReason ?? 'disabled'}`);
      return;
    }

    const injected = new Map<string, string>();
    const lastPrompt = new Map<string, string>();
    const reported = new Set<string>();
    const belongs = new Map<string, boolean>();
    const assistantText = new Map<string, Map<number, string>>();
    const closed = { value: false };

    async function buildBlock(sessionID: string, text: string): Promise<string> {
      const lines: string[] = [];
      try {
        lines.push(...core.nudgesForTurn(sessionID, text));
      } catch {
        // A nudge failure must never break a model request.
      }
      try {
        lines.push(...(await core.recallHints(sessionID, text)));
      } catch {
        // Recall is best-effort.
      }
      return lines.filter(Boolean).join('\n');
    }

    // Resolved once per session and remembered: 2.x events carry no project scope
    // of their own, and the check runs on every context hook.
    async function belongsHere(sessionID: string): Promise<boolean> {
      const known = belongs.get(sessionID);
      if (known !== undefined) return known;
      let result: boolean;
      try {
        const session = (await ctx.session.get({ sessionID })) as
          | { location?: { directory?: string }; directory?: string }
          | undefined;
        const sessionDirectory = session?.location?.directory ?? session?.directory;
        result = sessionDirectory === undefined || sessionDirectory === directory;
      } catch {
        // An unresolvable session is not ours to report.
        result = false;
      }
      belongs.set(sessionID, result);
      return result;
    }

    await ctx.session.hook('prompt', async (input) => {
      if (closed.value) return;
      const sessionID = input.sessionID;
      if (core.isSubAgent(sessionID)) return;

      reported.delete(sessionID);
      core.beginTurn(sessionID);
      // Covers a session resumed without a fresh session.created event.
      await core.ensureSession(sessionID);

      const text = input.prompt.text ?? '';
      if (text) {
        lastPrompt.set(sessionID, text);
        core.appendUserMessage(sessionID, text);
      }

      const block = await buildBlock(sessionID, text);
      if (block) injected.set(sessionID, block);
    });

    await ctx.session.hook('context', async (input) => {
      if (closed.value) return;
      const sessionID = input.sessionID;
      if (core.isSubAgent(sessionID)) return;
      if (!(await belongsHere(sessionID))) return;

      // A resumed session (host or plugin restart) has an empty cache; rebuild it
      // from the daemon instead of sending this request without context.
      if (!injected.has(sessionID)) {
        const block = await buildBlock(sessionID, lastPrompt.get(sessionID) ?? '');
        if (block) injected.set(sessionID, block);
      }

      const block = injected.get(sessionID);
      if (block) input.system.push({ type: 'text', text: block });
    });

    await ctx.tool.hook('execute.before', (input) => {
      if (input.sessionID) core.markToolUsed(input.sessionID);
    });

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          if (closed.value) break;
          const { type, data } = unwrapV2Event(raw);

          if (type === 'session.created') {
            const sessionID = String(data.sessionID ?? '');
            if (!sessionID) continue;
            if (data.parentID) {
              core.markSubAgent(sessionID);
              continue;
            }
            if (!(await belongsHere(sessionID))) continue;
            await core.ensureSession(sessionID);
            continue;
          }

          if (type === 'session.deleted') {
            const sessionID = String(data.sessionID ?? '');
            if (!sessionID) continue;
            reported.delete(sessionID);
            injected.delete(sessionID);
            lastPrompt.delete(sessionID);
            belongs.delete(sessionID);
            for (const entry of core.forgetSession(sessionID) ?? []) {
              if (entry?.id) assistantText.delete(entry.id);
            }
            continue;
          }

          // 2.x streams assistant text as `session.text.*`, not as message parts.
          // `ended` carries the finished text for one ordinal, so accumulating by
          // ordinal is idempotent and survives retries.
          if (type === 'session.text.ended') {
            const sessionID = String(data.sessionID ?? '');
            const messageID = String(data.assistantMessageID ?? '');
            const text = String(data.text ?? '');
            if (!sessionID || !messageID || !text) continue;
            if (core.isSubAgent(sessionID) || !core.isKnown(sessionID)) continue;
            let parts = assistantText.get(messageID);
            if (!parts) {
              parts = new Map<number, string>();
              assistantText.set(messageID, parts);
            }
            parts.set(Number(data.ordinal ?? 0), text);
            const joined = Array.from(parts.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, part]) => part)
              .join('\n')
              .trim();
            if (joined) core.upsertAssistantMessage(sessionID, messageID, joined);
            continue;
          }

          if (type === 'session.compaction.ended') {
            const sessionID = String(data.sessionID ?? '');
            if (!sessionID || core.isSubAgent(sessionID) || !core.isKnown(sessionID)) continue;
            // Compaction rewrites the transcript, so the cached block is stale.
            injected.delete(sessionID);
            await core.flushSessionSummary(sessionID);
            continue;
          }

          if (type === 'session.idle' || type === 'session.execution.succeeded') {
            const sessionID = String(data.sessionID ?? '');
            if (!sessionID || core.isSubAgent(sessionID) || !core.isKnown(sessionID)) continue;
            core.scheduleIdleFlush(sessionID);
            if (!reported.has(sessionID)) {
              reported.add(sessionID);
              void core.reportTurn(sessionID);
            }
          }
        }
      } catch (error) {
        if (!closed.value) diag(`rembric: event stream ended: ${String(error).slice(0, 200)}`);
      }
    })();

    diag(`rembric: v2 plugin ready (project ${slug ?? 'unset'}, opencode ${ctx.app.version})`);

    return () => {
      closed.value = true;
      controller.abort();
      core.flushAllFireAndForget();
      injected.clear();
      lastPrompt.clear();
      reported.clear();
      belongs.clear();
      assistantText.clear();
    };
  },
};

export default RembricPluginV2;
