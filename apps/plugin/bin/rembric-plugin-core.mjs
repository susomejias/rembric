// The single JS/TS implementation of the cross-client session protocol; the
// bash and Python clients keep their own, held in agreement by the shared
// fixtures in `apps/plugin/test/`. Enforced by apps/server/src/test/invariants.test.ts.
//
// Each client's install.sh rewrites the relative dev-time import of this file
// to its installed path under ~/.config/rembric/bin/ while copying.

export const POST_TIMEOUT_MS = 3000;
// The recall-hints call sits on the synchronous turn-START path: it must
// return before the model's first token, so its budget is a fraction of the
// background POST timeout. Best-effort: on expiry the client proceeds with
// no hints (`proactive-recall`, resilience requirement).
const RECALL_HINTS_TIMEOUT_MS = 200;
// Server-side extraction is also windowed, but the client cuts first: what
// never leaves the process cannot leak (`plugin-session-protocol`, D8).
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
// Sending ONE section is a legitimate write only because a `##` section a
// curated write omits keeps its stored text (`sessions`, section-wise merge).
// "before you finish this turn" is load-bearing, not "now": it defers the
// write past the user's actual work instead of asking for a summary of a
// session that has not happened yet (session-nudges, D7).
export const SESSION_OPENING_NUDGE_CORE =
  'New session — before you finish this turn, call memory.session_summary with a title and a single `## Goal` section describing what this session is for; the other five canonical headings are intentionally left out.';
export const SESSION_OPENING_NUDGE = `rembric: ${SESSION_OPENING_NUDGE_CORE}`;
// Unprefixed (no `rembric: `): opencode pushes this to output.context, not a
// bash-style inline nudge, so it never carries that prefix. Byte-identical
// to post-compact.sh's PROTOCOL heredoc minus that prefix — the ONE shared
// implementation of the compaction-time protocol text (plugin-session-protocol).
export const POST_COMPACT_NUDGE_CORE =
  'Resumed from a compaction. BEFORE continuing:\n' +
  '1. Call memory.session_get to read the stored summary.\n' +
  '2. Call memory.session_summary({title, summary}) with the CURRENT COMPLETE state: sent `##` sections REPLACE their stored counterpart; omitted ones STAY.\n' +
  '   - title: ≤100 chars, not the cwd.\n' +
  '   - summary: ≤10000 chars. Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):\n## Goal\n## Accomplished\n## Decisions+why\n## Verified+how\n## Unfinished+why\n## Files\n' +
  '3. Missing detail? memory.context or memory.search.\n' +
  '4. Then continue.';

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
  const firstPromptEmitted = new Set();
  const resumedReadEmitted = new Set();
  // Per-session outcome of THIS session's own ensure — independent of
  // `processResumed` below, which only ever captures the process's FIRST
  // session (see its own comment). Drives the session-opening line.
  const sessionCreated = new Map();
  const sessionOpeningEmitted = new Set();
  // The server's returned notice, cached between the end-of-turn report and
  // the next start-of-turn print. Only ever SET with a non-empty array — a
  // report that returns no lines must never clear a pending one
  // (`session-nudges`, `plugin-session-protocol`).
  const pendingLines = new Map();
  const turnTitleSent = new Set();
  // The per-turn tool-observation latch (`session-nudges`, D4a). Armed by the
  // client's own predicate through `markToolUsed`, disarmed at the turn
  // boundary by `beginTurn`, read and cleared by `reportTurn`. It lives here
  // rather than in each client because only the PREDICATE differs between
  // hosts — the latch's lifecycle is identical, and when each client owned
  // its own copy they drifted: one reset it at the turn boundary and one did
  // not, and one had to remember a second `delete` beside `forgetSession`.
  const toolUsedSessions = new Set();
  // null = not yet captured; set once, from the FIRST session-ensure of this
  // protocol's lifetime, and never overwritten by a later session's ensure.
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
      diag(`POST ${path} ${err?.message ?? 'error'}`);
      return null;
    }
  }

  /**
   * Reports delivery so a caller can skip a follow-up; never throws. Never
   * reads the response body — every /summary and /end call goes through
   * this function, and the contract in plugin-session-protocol forbids
   * reading a *summary* response to learn summary state.
   */
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

  /**
   * The ONE call site that reads a response body for the session-ensure:
   * `created` gates the resumed-read line and the session-opening line
   * (plugin-session-protocol, session-nudges). Kept separate from
   * rembricPost above so the two can never converge into one function that
   * could later be pointed at /summary or /end.
   */
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
      // An unknown outcome (failed ensure, or no `created` field) is
      // "do not advise", never "advise anyway".
      processResumed = ensure.ok && ensure.created === false;
    }
    sessionCreated.set(sessionId, ensure.ok === true && ensure.created === true);
    // Strictly after the ensure, which recreates a row the empty-session purge
    // removed; skipped when it did not land, since that failure is also a
    // resume failure.
    if (ensure.ok) await rembricPost(`/api/${slug}/sessions/${sessionId}/resume`, {});
  }

  /**
   * The lines to print at the START of a turn: the first-prompt relevance
   * line (once per session), the recall line (any turn matching the
   * keywords), the sessionId line (whenever it accompanies either the
   * session opening or a cached server notice), the session opening OR the
   * resumed-read line (mutually exclusive, each once per session), and
   * finally the server-composed notice cached by the last `reportTurn`
   * (session-nudges, plugin-session-protocol). No cadence, no counter.
   */
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

  /**
   * Arm the tool-observation latch for this session. Called from whatever
   * event the host uses to signal a tool invocation — the predicate is the
   * client's (opencode: a `tool` message part; Pi: a `toolResult` message or
   * a `toolCall` content part), the latch is not.
   */
  function markToolUsed(sessionId) {
    if (!sessionId) return;
    toolUsedSessions.add(sessionId);
  }

  /**
   * Disarm it at the START of a turn, from the host's own start-of-turn
   * surface. Required rather than redundant with the read-and-clear in
   * `reportTurn`: an observation arriving after the previous turn's report
   * would otherwise be attributed to this turn.
   */
  function beginTurn(sessionId) {
    toolUsedSessions.delete(sessionId);
  }

  /**
   * The per-turn report (`session-nudges`). Issued from each client's own
   * end-of-turn event (opencode: `session.idle`; Pi: `agent_settled`),
   * alongside — never instead of — the existing debounced transcript flush.
   * `usedTools` is read from the latch above and reported without
   * interpretation; the server owns the interpretation. The title rides
   * along at most once per session, derived from the transcript
   * accumulator's first recorded user message (already `<private>`-redacted
   * by `appendUserMessage`).
   */
  async function reportTurn(sessionId) {
    if (subAgentSessions.has(sessionId)) return;
    if (!knownSessions.has(sessionId)) return;
    // Read-and-clear below the guards, never above them: a report the guards
    // drop sends nothing, so consuming the latch there would attribute the
    // turn's tool use to no report at all and the next one would say `false`.
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
    // Never overwrite a pending, non-empty cache with an empty result — a
    // second report for the same turn must not swallow a pending notice.
    if (lines.length > 0) pendingLines.set(sessionId, lines);
  }

  /**
   * Proactive entity recall (`proactive-recall`, D1′): POST the current
   * turn's prompt to the recall-hints endpoint at turn START and return
   * the server-composed lines. Process-and-discard on the server side;
   * here the prompt is `<private>`-redacted and cut to the 500-char
   * window BEFORE it leaves the process, mirroring the title path.
   *
   * Best-effort by contract: every failure mode — disabled protocol,
   * sub-agent/unknown session, non-2xx, timeout, malformed body —
   * yields `[]` so the model's response is never blocked by recall.
   * An absent prompt skips the request outright (the spec's
   * "missing prompt omits the recall-hints call" scenario).
   */
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
