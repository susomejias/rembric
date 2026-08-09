// The single JS/TS implementation of the cross-client session protocol; the
// bash and Python clients keep their own, held in agreement by the shared
// fixtures in `apps/plugin/test/`. Enforced by apps/server/src/test/invariants.test.ts.
//
// Each client's install.sh rewrites the relative dev-time import of this file
// to its installed path under ~/.config/rembric/bin/ while copying.

export const POST_TIMEOUT_MS = 3000;
const IDLE_DEBOUNCE_MS = 500;
export const MAX_TRANSCRIPT_CHARS = 19_500;
const MAX_ENTRY_CHARS = 2000;
const MAX_ENTRIES_PER_SESSION = 200;
const MAX_TITLE_CHARS = 100;

export const RECALL_REGEX = /remember|recall|acuérdate|qué hicimos|what did we do/i;
export const RECALL_NUDGE =
  'rembric: User intent: recall. Call memory.search with the user keywords before responding.';
export const FIRST_PROMPT_NUDGE =
  'rembric: New session — call memory.context with focus set to this prompt before responding, to surface relevant prior work.';
export const SAVE_NUDGE_EVERY = 5;
export const SAVE_NUDGE =
  'rembric: if recent work produced a decision, fix, or discovery, you MUST call memory.save now (title ≤100 + content).';
export const SUMMARY_NUDGE_EVERY = 10;
export const SUMMARY_NUDGE =
  'rembric: did real work happen this turn? You MUST call memory.session_summary({title, summary}) now — title ≤100 chars (the work, not cwd); summary: Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files. Nothing memorable? Skip.';
export const SESSION_ID_NUDGE_TEMPLATE =
  'rembric: sessionId="{{SESSION_ID}}" — pass it explicitly to memory.save/memory.session_summary/memory.save_prompt now, to guarantee correct attachment; never guess a different one.';

// `memory` and `project` are the server's two tool namespaces; a dotted word
// outside them is prose or a filename and must be left alone. The Pi client's
// test asserts this list still covers every tool the server publishes.
const DOTTED_TOOL_NAME = /\b(memory|project)\.([a-z][a-z0-9_]*)/g;

export function underscoreToolNames(text) {
  return text.replace(DOTTED_TOOL_NAME, '$1_$2');
}

/** Read per use, not once: an override set after this module loads still wins. */
function idleDebounceMs() {
  return Number(process.env.REMBRIC_IDLE_DEBOUNCE_MS ?? IDLE_DEBOUNCE_MS);
}

export function diag(line) {
  process.stderr.write(`[rembric] ${line}\n`);
}

// An unclosed <private> redacts through end-of-text: fail closed for a privacy
// marker, which also covers a closing tag cut off by the per-entry truncation
// the call sites apply before this.
export function stripPrivateTags(text) {
  if (!text) return '';
  return text
    .replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]')
    .replace(/<private>[\s\S]*$/i, '[REDACTED]');
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}

export function createSessionProtocol({ agent, serverUrl, apiToken, slug, cwd }) {
  // No default: `sessions.agent` is append-only with no repair verb, so a
  // defaulted value misattributes a miswired client's sessions forever.
  if (!agent) {
    throw new Error('rembric-plugin-core: createSessionProtocol requires an `agent`');
  }

  const disabledReason =
    !serverUrl || !apiToken
      ? 'REMBRIC_SERVER_URL or REMBRIC_API_TOKEN missing'
      : !slug
        ? `no PROJECT_SLUG in ${cwd ?? '.'}/.rembric`
        : null;
  const disabled = disabledReason !== null;
  if (disabledReason) {
    diag(`${disabledReason}; plugin disabled`);
  }

  const baseUrl = serverUrl ? serverUrl.replace(/\/$/, '') : '';

  const knownSessions = new Set();
  const subAgentSessions = new Set();
  const sessionMessages = new Map();
  const pendingFlush = new Map();
  const userTurnCounts = new Map();

  async function rembricPost(path, body) {
    if (disabled) return;
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
        const detail = await res.text().catch(() => '');
        diag(`POST ${path} ${res.status} body=${detail}`);
      }
    } catch (err) {
      diag(`POST ${path} ${err?.message ?? 'error'}`);
    }
  }

  function isSubAgent(sessionId) {
    return subAgentSessions.has(sessionId);
  }

  function markSubAgent(sessionId) {
    subAgentSessions.add(sessionId);
  }

  function isKnown(sessionId) {
    return knownSessions.has(sessionId);
  }

  async function ensureSession(sessionId) {
    if (!sessionId) return;
    if (subAgentSessions.has(sessionId)) return;
    if (knownSessions.has(sessionId)) return;
    knownSessions.add(sessionId);

    const body = { id: sessionId, agent };
    if (cwd) body.cwd = cwd;

    await rembricPost(`/api/${slug}/sessions`, body);
  }

  function nudgesForTurn(sessionId, prompt) {
    const turn = (userTurnCounts.get(sessionId) ?? 0) + 1;
    userTurnCounts.set(sessionId, turn);

    const lines = [];
    if (turn === 1) lines.push(FIRST_PROMPT_NUDGE);
    if (RECALL_REGEX.test(prompt)) lines.push(RECALL_NUDGE);

    const saveFires = turn % SAVE_NUDGE_EVERY === 0;
    const summaryFires = turn === 1 || turn % SUMMARY_NUDGE_EVERY === 0;
    if (saveFires || summaryFires) {
      lines.push(SESSION_ID_NUDGE_TEMPLATE.replace('{{SESSION_ID}}', sessionId));
    }
    if (saveFires) lines.push(SAVE_NUDGE);
    if (summaryFires) lines.push(SUMMARY_NUDGE);
    return lines;
  }

  function entriesFor(sessionId) {
    let arr = sessionMessages.get(sessionId);
    if (!arr) {
      arr = [];
      sessionMessages.set(sessionId, arr);
    }
    return arr;
  }

  // Returns what the per-session cap pushed out: a client keying per-message
  // state off these entries can only bound it if told which ones left.
  function pushEntry(sessionId, entry) {
    const arr = entriesFor(sessionId);
    arr.push(entry);
    const evicted = [];
    while (arr.length > MAX_ENTRIES_PER_SESSION) evicted.push(arr.shift());
    return evicted;
  }

  function appendUserMessage(sessionId, rawText) {
    const text = stripPrivateTags(truncate(rawText, MAX_ENTRY_CHARS));
    if (!text) return [];
    return pushEntry(sessionId, { role: 'user', text });
  }

  function appendAssistantMessage(sessionId, rawText) {
    const text = stripPrivateTags(truncate(rawText, MAX_ENTRY_CHARS));
    if (!text) return [];
    return pushEntry(sessionId, { role: 'assistant', text });
  }

  function upsertAssistantMessage(sessionId, messageId, rawText) {
    const text = stripPrivateTags(truncate(rawText, MAX_ENTRY_CHARS));
    if (!text) return [];
    const arr = entriesFor(sessionId);
    const existing = arr.findIndex((e) => e.role === 'assistant' && e.id === messageId);
    if (existing >= 0) {
      arr[existing] = { role: 'assistant', text, id: messageId };
      return [];
    }
    return pushEntry(sessionId, { role: 'assistant', text, id: messageId });
  }

  function formatTranscript(sessionId) {
    const arr = sessionMessages.get(sessionId) ?? [];
    const body = arr.map((e) => `${e.role}: ${e.text}`).join('\n\n');
    if (body.length <= MAX_TRANSCRIPT_CHARS) return body;
    return body.slice(body.length - MAX_TRANSCRIPT_CHARS);
  }

  function deriveTitle(sessionId) {
    const arr = sessionMessages.get(sessionId) ?? [];
    const firstUser = arr.find((e) => e.role === 'user');
    if (!firstUser) return undefined;
    return firstUser.text.slice(0, MAX_TITLE_CHARS);
  }

  function buildSummaryBody(sessionId) {
    const summary = formatTranscript(sessionId);
    if (!summary) return null;
    const title = deriveTitle(sessionId);
    const body = { summary, final: false };
    if (title) body.title = title;
    return body;
  }

  async function flushSessionSummary(sessionId) {
    if (subAgentSessions.has(sessionId)) return;
    if (!knownSessions.has(sessionId)) return;
    const body = buildSummaryBody(sessionId);
    if (!body) return;
    await rembricPost(`/api/${slug}/sessions/${sessionId}/summary`, body);
  }

  // `{}` rather than a skip on an empty accumulator: a session with no turns
  // must still reach `ended`. One request, never `/summary` then `/end` — each
  // is bounded by POST_TIMEOUT_MS, so a pair doubles a quitting user's wait.
  async function endSession(sessionId) {
    if (subAgentSessions.has(sessionId)) return;
    if (!knownSessions.has(sessionId)) return;
    await rembricPost(`/api/${slug}/sessions/${sessionId}/end`, buildSummaryBody(sessionId) ?? {});
  }

  function scheduleIdleFlush(sessionId) {
    const prev = pendingFlush.get(sessionId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      pendingFlush.delete(sessionId);
      void flushSessionSummary(sessionId);
    }, idleDebounceMs());
    pendingFlush.set(sessionId, timer);
  }

  // For a host that kills the process before async handlers settle (opencode's
  // server.instance.disposed): no await and no AbortSignal, so landing is a
  // race. A host that awaits its shutdown handler must use flushSessionSummary.
  function flushAllFireAndForget() {
    if (disabled) return;
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

  // Returns the entries it dropped, for the same reason pushEntry does.
  function forgetSession(sessionId) {
    knownSessions.delete(sessionId);
    subAgentSessions.delete(sessionId);
    userTurnCounts.delete(sessionId);
    const entries = sessionMessages.get(sessionId) ?? [];
    sessionMessages.delete(sessionId);
    const pending = pendingFlush.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      pendingFlush.delete(sessionId);
    }
    return entries;
  }

  return {
    disabled,
    disabledReason,
    baseUrl,
    isSubAgent,
    markSubAgent,
    isKnown,
    ensureSession,
    nudgesForTurn,
    appendUserMessage,
    appendAssistantMessage,
    upsertAssistantMessage,
    flushSessionSummary,
    endSession,
    scheduleIdleFlush,
    flushAllFireAndForget,
    forgetSession,
  };
}
