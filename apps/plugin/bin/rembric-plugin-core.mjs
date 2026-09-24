export const POST_TIMEOUT_MS = 3000;
// Turn-START path: it must resolve before the model's first token, so its budget is a fraction of the background POST timeout.
const RECALL_HINTS_TIMEOUT_MS = 200;
// The client cuts first: what never leaves the process cannot leak.
const RECALL_PROMPT_MAX_CHARS = 500;
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
export const SESSION_ID_NUDGE_TEMPLATE =
  'rembric: sessionId="{{SESSION_ID}}" — pass it explicitly to memory.save/memory.session_summary/memory.save_prompt now, to guarantee correct attachment; never guess a different one.';
export const RESUMED_READ_NUDGE =
  'rembric: this session existed before this process attached to it — call memory.session_get before your next memory.session_summary write.';
export const SESSION_OPENING_NUDGE_CORE =
  'New session — before you finish this turn, call memory.session_summary with a title and a single `## Goal` section describing what this session is for; the other five canonical headings are intentionally left out.';
export const SESSION_OPENING_NUDGE = `rembric: ${SESSION_OPENING_NUDGE_CORE}`;
export const POST_COMPACT_NUDGE_CORE =
  'Resumed from a compaction. BEFORE continuing:\n' +
  '1. Call memory.session_get to read the stored summary.\n' +
  '2. Call memory.session_summary({title, summary}) with the CURRENT COMPLETE state: sent `##` sections REPLACE their stored counterpart; omitted ones STAY.\n' +
  '   - title: ≤100 chars, not the cwd.\n' +
  '   - summary: ≤10000 chars. Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):\n## Goal\n## Accomplished\n## Decisions+why\n## Verified+how\n## Unfinished+why\n## Files\n' +
  '3. Missing detail? memory.context or memory.search.\n' +
  '4. Then continue.';

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
  if (!agent) {
    throw new Error('rembric-plugin-core: createSessionProtocol requires an `agent`');
  }

  const disabledReason =
    !serverUrl || !apiToken
      ? 'REMBRIC_SERVER_URL or REMBRIC_API_TOKEN missing'
      : slug
        ? null
        : `no PROJECT_SLUG in ${cwd ?? '.'}/.rembric`;
  const disabled = disabledReason !== null;
  if (disabledReason) {
    diag(`${disabledReason}; plugin disabled`);
  }

  const baseUrl = serverUrl ? serverUrl.replace(/\/$/, '') : '';

  const knownSessions = new Set();
  const subAgentSessions = new Set();
  const sessionMessages = new Map();
  const pendingFlush = new Map();
  const firstPromptEmitted = new Set();
  const resumedReadEmitted = new Set();
  const sessionCreated = new Map();
  const sessionOpeningEmitted = new Set();
  const pendingLines = new Map();
  const turnTitleSent = new Set();
  const toolUsedSessions = new Set();
  let processResumed = null;

  async function doPost(path, body, timeoutMs = POST_TIMEOUT_MS) {
    if (disabled) return null;
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        diag(
          `POST ${path} timeout after ${timeoutMs}ms — request abandoned, nothing sent twice; server too slow or unreachable`,
        );
      } else {
        diag(`POST ${path} ${err?.message ?? 'error'}`);
      }
      return null;
    }
  }

  async function rembricPost(path, body) {
    const res = await doPost(path, body);
    if (!res) return false;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      diag(`POST ${path} ${res.status} body=${detail}`);
      return false;
    }
    return true;
  }

  async function postSessionEnsure(path, body) {
    const res = await doPost(path, body);
    if (!res || !res.ok) return { ok: false, created: null };
    const json = await res.json().catch(() => null);
    return { ok: true, created: typeof json?.created === 'boolean' ? json.created : null };
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

    const isFirstEnsureOfProcess = processResumed === null;
    const ensure = await postSessionEnsure(`/api/${slug}/sessions`, body);
    if (isFirstEnsureOfProcess) {
      processResumed = ensure.ok && ensure.created === false;
    }
    sessionCreated.set(sessionId, ensure.ok === true && ensure.created === true);
    if (ensure.ok) await rembricPost(`/api/${slug}/sessions/${sessionId}/resume`, {});
  }

  function nudgesForTurn(sessionId, prompt) {
    const lines = [];
    const isFirstPrompt = !firstPromptEmitted.has(sessionId);
    if (isFirstPrompt) {
      firstPromptEmitted.add(sessionId);
      lines.push(FIRST_PROMPT_NUDGE);
    }
    if (RECALL_REGEX.test(prompt)) lines.push(RECALL_NUDGE);

    const pending = takePendingLines(sessionId);
    const openingDue =
      sessionCreated.get(sessionId) === true && !sessionOpeningEmitted.has(sessionId);
    const writeDirecting = pending.length > 0 || openingDue;

    if (writeDirecting) {
      lines.push(SESSION_ID_NUDGE_TEMPLATE.replace('{{SESSION_ID}}', sessionId));
    }
    if (openingDue) {
      sessionOpeningEmitted.add(sessionId);
      lines.push(SESSION_OPENING_NUDGE);
    } else if (isFirstPrompt && processResumed === true && !resumedReadEmitted.has(sessionId)) {
      resumedReadEmitted.add(sessionId);
      lines.push(RESUMED_READ_NUDGE);
    }
    for (const line of pending) lines.push(line);
    return lines;
  }

  /** Read-and-clear: a cached notice is printed exactly once. */
  function takePendingLines(sessionId) {
    const lines = pendingLines.get(sessionId);
    pendingLines.delete(sessionId);
    return lines ?? [];
  }

  function entriesFor(sessionId) {
    let arr = sessionMessages.get(sessionId);
    if (!arr) {
      arr = [];
      sessionMessages.set(sessionId, arr);
    }
    return arr;
  }

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

  function markToolUsed(sessionId) {
    if (!sessionId) return;
    toolUsedSessions.add(sessionId);
  }

  function beginTurn(sessionId) {
    toolUsedSessions.delete(sessionId);
  }

  async function reportTurn(sessionId) {
    if (subAgentSessions.has(sessionId)) return;
    if (!knownSessions.has(sessionId)) return;
    const body = { usedTools: toolUsedSessions.delete(sessionId) };
    if (!turnTitleSent.has(sessionId)) {
      const title = deriveTitle(sessionId);
      if (title) {
        body.title = title;
        turnTitleSent.add(sessionId);
      }
    }
    const res = await doPost(`/api/${slug}/sessions/${sessionId}/turn`, body);
    if (!res) return;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      diag(`POST /api/${slug}/sessions/${sessionId}/turn ${res.status} body=${detail}`);
      return;
    }
    const json = await res.json().catch(() => null);
    const lines = Array.isArray(json?.lines) ? json.lines.filter((l) => typeof l === 'string') : [];
    if (lines.length > 0) pendingLines.set(sessionId, lines);
  }

  async function recallHints(sessionId, prompt, timeoutMs = RECALL_HINTS_TIMEOUT_MS) {
    if (disabled) return [];
    if (!sessionId || !prompt) return [];
    if (subAgentSessions.has(sessionId)) return [];
    if (!knownSessions.has(sessionId)) return [];
    const redacted = stripPrivateTags(String(prompt)).slice(0, RECALL_PROMPT_MAX_CHARS);
    if (!redacted) return [];
    const res = await doPost(
      `/api/${slug}/sessions/${sessionId}/recall-hints`,
      { prompt: redacted },
      timeoutMs,
    );
    if (!res) return [];
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      diag(`POST /api/${slug}/sessions/${sessionId}/recall-hints ${res.status} body=${detail}`);
      return [];
    }
    const json = await res.json().catch(() => null);
    return Array.isArray(json?.lines) ? json.lines.filter((l) => typeof l === 'string') : [];
  }

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

  function forgetSession(sessionId) {
    knownSessions.delete(sessionId);
    subAgentSessions.delete(sessionId);
    firstPromptEmitted.delete(sessionId);
    resumedReadEmitted.delete(sessionId);
    sessionCreated.delete(sessionId);
    sessionOpeningEmitted.delete(sessionId);
    pendingLines.delete(sessionId);
    turnTitleSent.delete(sessionId);
    toolUsedSessions.delete(sessionId);
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
    markToolUsed,
    beginTurn,
    reportTurn,
    recallHints,
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
