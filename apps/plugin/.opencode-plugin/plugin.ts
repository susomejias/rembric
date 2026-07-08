// x-release-please-start-version
// @rembric-plugin-version 0.16.1
// x-release-please-end
// cwd-spike-result: plan-a
// dispose-spike-result: fire-and-forget
//
// Rembric plugin for opencode (https://opencode.ai).
//
// Distributed as a single .ts file via plugin/.opencode-plugin/install.sh,
// which copies this file to ~/.config/opencode/plugins/rembric.ts, the
// shared bridge to ~/.config/rembric/bin/rembric-bridge.mjs, and the
// shared dotenv lib to ~/.config/rembric/bin/rembric-dotenv.mjs.
//
// Session lifecycle:
//   - session.created → POST /api/<slug>/sessions  (idempotent register)
//   - chat.message    → accumulate user turn in sessionMessages
//   - message.updated → accumulate/upsert assistant turn (by message.id)
//   - session.idle    → debounced (500ms) flush via POST /summary  ← PRIMARY
//   - server.instance.disposed → fire-and-forget POST /summary  ← BEST-EFFORT
//   - session.deleted → clean in-memory state
//
// Why two flush paths? opencode kills the subprocess on
// server.instance.disposed BEFORE async handlers complete (spike verified
// 2026-05-19 — see design.md::Decision 4 resolved). The per-turn flush
// keeps the server's summary current at all times; the dispose call is a
// last-chance opportunity that may or may not land. Worst case: at-most-
// one-turn lag between in-memory state and dashboard.
//
// Slug-resolution helpers (`parseDotenv`, `readRembricSlug`, `SLUG_RE`)
// live in `rembric-dotenv.mjs`, imported below. install.sh rewrites the
// relative dev-time path to the absolute installed path before copying.
//
// ONLY `RembricPlugin` is exported. opencode iterates every named export
// of a plugin module and invokes each with the plugin ctx — exporting
// helpers would crash on load.

import { readRembricSlug } from '../bin/rembric-dotenv.mjs';

const POST_TIMEOUT_MS = 3000;
const IDLE_DEBOUNCE_MS = 500;
const MAX_TRANSCRIPT_CHARS = 19_500;
const MAX_ENTRY_CHARS = 2000;
const MAX_ENTRIES_PER_SESSION = 200;
const MAX_TITLE_CHARS = 100;
const RECALL_REGEX = /remember|recall|acuérdate|qué hicimos|what did we do/i;
const RECALL_NUDGE =
  'rembric: User intent: recall. Call memory.search with the user keywords before responding.';

type EventInput = {
  event: {
    type: string;
    properties?: Record<string, unknown>;
  };
};

type ChatMessageInput = { sessionID: string };
type ChatMessageOutput = {
  parts: Array<{ type: string; text?: string }>;
  message: { summary?: { title?: string; body?: string } };
};

type MessageUpdatedInput = { sessionID: string };
type MessageUpdatedOutput = {
  message: {
    id: string;
    role?: string;
    parts?: Array<{ type: string; text?: string }>;
  };
};

type SessionIdleInput = { sessionID: string };

type CompactingInput = { sessionID?: string };
type CompactingOutput = { context: string[] };

type PluginContext = { directory: string };

type TranscriptEntry = { role: 'user' | 'assistant'; text: string; id?: string };

type PluginReturn = {
  event?: (input: EventInput) => Promise<void>;
  'chat.message'?: (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
  'message.updated'?: (input: MessageUpdatedInput, output: MessageUpdatedOutput) => Promise<void>;
  'session.idle'?: (input: SessionIdleInput) => Promise<void>;
  'experimental.session.compacting'?: (
    input: CompactingInput,
    output: CompactingOutput,
  ) => Promise<void>;
};

type Plugin = (ctx: PluginContext) => Promise<PluginReturn>;

function diag(line: string): void {
  process.stderr.write(`[rembric] ${line}\n`);
}

// Mirrors rembric_redact_private in scripts/_transcript.sh and
// _redact_private in .hermes-plugin/__init__.py; the shared fixtures in
// ../test/redaction-fixtures.json keep the three implementations in
// lock-step. An unclosed <private> redacts through end-of-text: fail
// closed for a privacy marker (also covers a closing tag cut off by the
// per-entry truncation applied before this at the call sites).
function stripPrivateTags(text: string): string {
  if (!text) return '';
  return text
    .replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]')
    .replace(/<private>[\s\S]*$/i, '[REDACTED]');
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}

export const RembricPlugin: Plugin = async (ctx) => {
  const serverUrl = process.env.REMBRIC_SERVER_URL;
  const apiToken = process.env.REMBRIC_API_TOKEN;
  const slug = readRembricSlug(ctx.directory);

  const disabled = !serverUrl || !apiToken;
  if (disabled) {
    diag('REMBRIC_SERVER_URL or REMBRIC_API_TOKEN missing; plugin disabled');
  }

  const knownSessions = new Set<string>();
  const subAgentSessions = new Set<string>();
  const sessionMessages = new Map<string, TranscriptEntry[]>();
  const pendingFlush = new Map<string, ReturnType<typeof setTimeout>>();

  const baseUrl = serverUrl ? serverUrl.replace(/\/$/, '') : '';

  async function rembricPost(path: string, body: unknown): Promise<void> {
    if (disabled || !slug) return;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        diag(`POST ${path} ${res.status}`);
      }
    } catch (err) {
      diag(`POST ${path} ${(err as Error).message ?? 'error'}`);
    }
  }

  async function ensureSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (subAgentSessions.has(sessionId)) return;
    if (knownSessions.has(sessionId)) return;
    knownSessions.add(sessionId);

    const body: Record<string, unknown> = {
      id: sessionId,
      agent: 'opencode',
    };
    if (ctx.directory) body.cwd = ctx.directory;

    await rembricPost(`/api/${slug}/sessions`, body);
  }

  function appendUserMessage(sessionId: string, rawText: string): void {
    const text = stripPrivateTags(truncate(rawText, MAX_ENTRY_CHARS));
    if (!text) return;
    let arr = sessionMessages.get(sessionId);
    if (!arr) {
      arr = [];
      sessionMessages.set(sessionId, arr);
    }
    arr.push({ role: 'user', text });
    while (arr.length > MAX_ENTRIES_PER_SESSION) arr.shift();
  }

  function upsertAssistantMessage(sessionId: string, messageId: string, rawText: string): void {
    const text = stripPrivateTags(truncate(rawText, MAX_ENTRY_CHARS));
    if (!text) return;
    let arr = sessionMessages.get(sessionId);
    if (!arr) {
      arr = [];
      sessionMessages.set(sessionId, arr);
    }
    const existing = arr.findIndex((e) => e.role === 'assistant' && e.id === messageId);
    if (existing >= 0) {
      arr[existing] = { role: 'assistant', text, id: messageId };
    } else {
      arr.push({ role: 'assistant', text, id: messageId });
      while (arr.length > MAX_ENTRIES_PER_SESSION) arr.shift();
    }
  }

  function formatTranscript(sessionId: string): string {
    const arr = sessionMessages.get(sessionId) ?? [];
    const body = arr.map((e) => `${e.role}: ${e.text}`).join('\n\n');
    if (body.length <= MAX_TRANSCRIPT_CHARS) return body;
    return body.slice(body.length - MAX_TRANSCRIPT_CHARS);
  }

  function deriveTitle(sessionId: string): string | undefined {
    const arr = sessionMessages.get(sessionId) ?? [];
    const firstUser = arr.find((e) => e.role === 'user');
    if (!firstUser) return undefined;
    return firstUser.text.slice(0, MAX_TITLE_CHARS);
  }

  function buildSummaryBody(sessionId: string): {
    summary: string;
    title?: string;
    final: false;
  } | null {
    const summary = formatTranscript(sessionId);
    if (!summary) return null;
    const title = deriveTitle(sessionId);
    const body: { summary: string; title?: string; final: false } = { summary, final: false };
    if (title) body.title = title;
    return body;
  }

  async function flushSessionSummary(sessionId: string): Promise<void> {
    if (subAgentSessions.has(sessionId)) return;
    if (!knownSessions.has(sessionId)) return;
    const body = buildSummaryBody(sessionId);
    if (!body) return;
    await rembricPost(`/api/${slug}/sessions/${sessionId}/summary`, body);
  }

  function scheduleIdleFlush(sessionId: string): void {
    const prev = pendingFlush.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      pendingFlush.delete(sessionId);
      void flushSessionSummary(sessionId);
    }, IDLE_DEBOUNCE_MS);
    pendingFlush.set(sessionId, timer);
  }

  function disposeFlushFireAndForget(): void {
    // server.instance.disposed is fire-and-forget: opencode kills the
    // subprocess before async handlers complete (verified spike, design.md::
    // Decision 4 resolved). We dispatch fetches without awaiting and hope
    // the kernel flushes the TCP packets before SIGKILL. Per-turn
    // session.idle flush is the primary mechanism — this is a last-chance.
    if (disabled || !slug) return;
    for (const sessionId of knownSessions) {
      if (subAgentSessions.has(sessionId)) continue;
      const body = buildSummaryBody(sessionId);
      if (!body) continue;
      diag(`dispose-flush sessionId=${sessionId} (fire-and-forget)`);
      void fetch(`${baseUrl}/api/${slug}/sessions/${sessionId}/summary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }).catch(() => {
        // expected — process likely already dying
      });
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
          subAgentSessions.add(sessionId);
          return;
        }
        await ensureSession(sessionId);
      }

      if (event.type === 'session.deleted') {
        const info = (event.properties?.info ?? {}) as { id?: string };
        const sessionId = info.id ?? '';
        if (!sessionId) return;
        knownSessions.delete(sessionId);
        subAgentSessions.delete(sessionId);
        sessionMessages.delete(sessionId);
        const pending = pendingFlush.get(sessionId);
        if (pending) {
          clearTimeout(pending);
          pendingFlush.delete(sessionId);
        }
      }

      if (event.type === 'server.instance.disposed') {
        disposeFlushFireAndForget();
      }

      if (event.type === 'session.compacted') {
        const props = (event.properties ?? {}) as {
          sessionID?: string;
          info?: { id?: string };
        };
        const sessionId = props.sessionID ?? props.info?.id ?? '';
        if (!sessionId) return;
        if (subAgentSessions.has(sessionId)) return;
        if (!knownSessions.has(sessionId)) return;
        diag(`session.compacted sessionId=${sessionId}`);
        await flushSessionSummary(sessionId);
      }
    },

    'chat.message': async (input, output) => {
      if (subAgentSessions.has(input.sessionID)) return;

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
      appendUserMessage(input.sessionID, content);

      if (RECALL_REGEX.test(content)) {
        output.parts.push({ type: 'text', text: RECALL_NUDGE });
      }
    },

    'message.updated': async (input, output) => {
      if (subAgentSessions.has(input.sessionID)) return;
      if (output.message.role !== 'assistant') return;
      if (!output.message.id) return;

      const text = (output.message.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n')
        .trim();

      if (!text) return;
      upsertAssistantMessage(input.sessionID, output.message.id, text);
    },

    'session.idle': async (input) => {
      if (subAgentSessions.has(input.sessionID)) return;
      if (!knownSessions.has(input.sessionID)) return;
      scheduleIdleFlush(input.sessionID);
    },

    'experimental.session.compacting': async (input, output) => {
      if (input.sessionID) {
        await ensureSession(input.sessionID);
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
