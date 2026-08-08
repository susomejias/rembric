// x-release-please-start-version
// @rembric-plugin-version 0.25.1
// x-release-please-end
// cwd-spike-result: plan-a
// dispose-spike-result: fire-and-forget
//
// Rembric plugin for opencode (https://opencode.ai). install.sh rewrites both
// relative dev-time import paths below to their installed paths while copying.
//
// message.updated, message.part.updated and session.idle dispatch via the
// `event` hook, never as top-level Hooks keys. Assistant text arrives only via
// message.part.updated's `properties.part` — `message.updated` carries no `parts`.
//
// ONLY `RembricPlugin` is exported: opencode invokes every named export of a
// plugin module with the plugin ctx, so a helper export crashes on load.

import { readRembricSlug } from '../bin/rembric-dotenv.mjs';
import { createSessionProtocol, diag } from '../bin/rembric-plugin-core.mjs';

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

type PluginReturn = {
  event?: (input: EventInput) => Promise<void>;
  'chat.message'?: (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
  'experimental.session.compacting'?: (
    input: CompactingInput,
    output: CompactingOutput,
  ) => Promise<void>;
};

type Plugin = (ctx: PluginContext) => Promise<PluginReturn>;

// opencode validates every pushed part against the real TextPart schema
// (id/sessionID/messageID all required) before persisting the outgoing user
// message; a bare `{ type: 'text', text }` fails it and takes down the turn.
function nudgePart(
  sessionId: string,
  messageId: string,
  text: string,
): { id: string; sessionID: string; messageID: string; type: 'text'; text: string } {
  // opencode validates the entity-type id prefix on write, so a bare UUID is
  // rejected.
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

  // Both maps are keyed by assistant message id, so they stay bounded only if
  // every way an entry leaves the transcript feeds this: session.deleted
  // (forgetSession) and the per-session cap (the appends' return value).
  function forgetMessageState(entries: ReadonlyArray<{ id?: string }>): void {
    for (const entry of entries) {
      if (!entry.id) continue;
      assistantMessageIds.delete(entry.id);
      assistantParts.delete(entry.id);
    }
  }

  return {
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
      }
    },

    'chat.message': async (input, output) => {
      if (core.isSubAgent(input.sessionID)) return;

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

      // Same debounce as session.idle — avoids a second uncoordinated POST.
      core.scheduleIdleFlush(input.sessionID);
    },

    'experimental.session.compacting': async (input, output) => {
      if (input.sessionID) {
        await core.ensureSession(input.sessionID);
      }

      output.context.push(
        'CRITICAL INSTRUCTION FOR THE POST-COMPACTION AGENT:\n' +
          'You have Rembric persistent memory available via MCP tools. As your FIRST action, ' +
          `call \`memory.session_summary\` with the content of the compacted summary above. ` +
          (slug ? `Use project: '${slug}'. ` : '') +
          'This preserves what was accomplished before compaction. ' +
          'Without this step, everything done before compaction is lost from memory. ' +
          'If the compacted summary lacks specific detail you need (exact file paths, prior decisions, concrete error messages), call `memory.context` before responding.',
      );
    },
  };
};
