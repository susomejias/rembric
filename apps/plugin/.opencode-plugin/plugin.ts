// x-release-please-start-version
// @rembric-plugin-version 0.24.0
// x-release-please-end
// cwd-spike-result: plan-a
// dispose-spike-result: fire-and-forget
//
// Rembric plugin for opencode (https://opencode.ai).
//
// Distributed as a single .ts file via plugin/.opencode-plugin/install.sh,
// which copies this file to ~/.config/opencode/plugins/rembric.ts, the
// shared bridge to ~/.config/rembric/bin/rembric-bridge.mjs, and the two
// shared libs (rembric-dotenv.mjs, rembric-plugin-core.mjs) to
// ~/.config/rembric/bin/.
//
// Session lifecycle:
//   - session.created      → POST /api/<slug>/sessions  (idempotent register)
//   - chat.message         → accumulate user turn; also arms the debounced
//                            flush session.idle uses (below)
//   - message.updated      → record which message ids are the assistant's
//   - message.part.updated → accumulate/upsert assistant turn text, keyed by
//                            part.messageID (see note below)
//   - session.idle         → debounced (500ms) flush via POST /summary  ← PRIMARY
//   - server.instance.disposed → fire-and-forget POST /summary  ← BEST-EFFORT
//   - session.deleted      → clean in-memory state
//
// message.updated, message.part.updated, and session.idle are Event union
// members, dispatched via the `event` hook — NOT top-level Hooks keys
// (opencode never invokes those).
//
// message.updated's `properties.info` (a Message = UserMessage |
// AssistantMessage in @opencode-ai/sdk) carries NO `parts` field — only
// metadata (id, role, cost, tokens...). Assistant TEXT only ever arrives via
// message.part.updated's `properties.part`, keyed by `part.messageID`. An
// earlier version read `info.parts` (never existed) and silently captured
// zero assistant text forever; confirmed against the real installed
// @opencode-ai/sdk@1.17.18 types after a live session showed user-only
// transcripts.
//
// Why two flush paths? opencode kills the subprocess on
// server.instance.disposed BEFORE async handlers complete (spike verified
// 2026-05-19 — see design.md::Decision 4 resolved). The per-turn flush
// keeps the server's summary current at all times; the dispose call is a
// last-chance opportunity that may or may not land. Worst case: at-most-
// one-turn lag between in-memory state and dashboard.
//
// Slug-resolution helpers (`parseDotenv`, `readRembricSlug`, `SLUG_RE`)
// live in `rembric-dotenv.mjs`; the nudge texts, redaction, transcript
// accumulator and flush helpers shared with every other JS/TS client live
// in `rembric-plugin-core.mjs`. install.sh rewrites BOTH relative dev-time
// paths to their absolute installed paths before copying.
//
// ONLY `RembricPlugin` is exported. opencode iterates every named export
// of a plugin module and invokes each with the plugin ctx — exporting
// helpers would crash on load.

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
// message. A bare `{ type: 'text', text }` fails that validation and takes
// down the whole turn with a hard server error — confirmed live: `opencode
// run` crashed on turn 1 (the unconditional SUMMARY_NUDGE) with
// `EventV2.InvalidDurableEvent: Expected string aggregate field sessionID`,
// and a `--pure` (no plugins) run of the same message succeeded cleanly.
function nudgePart(
  sessionId: string,
  messageId: string,
  text: string,
): { id: string; sessionID: string; messageID: string; type: 'text'; text: string } {
  // opencode's own id scheme prefixes every entity type (ses_, msg_, prt_...)
  // and validates the prefix on write — confirmed live: a bare crypto.randomUUID()
  // (no prefix) was rejected with `SchemaError: Expected a string starting with "prt"`.
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

  // Both maps are keyed by assistant message id, so they can only stay bounded
  // if every way an entry leaves the transcript feeds them: session.deleted
  // (forgetSession) and the per-session entry cap (the appends' return value).
  // Without the second, a session past the cap grew both maps without limit.
  // Typed structurally so no extra import of the core's types is needed.
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
