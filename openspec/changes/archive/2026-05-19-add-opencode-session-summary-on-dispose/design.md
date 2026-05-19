## Context

`add-opencode-plugin` (archived 2026-05-19) shipped an opencode plugin with two event handlers — `event` (dispatching `session.created` / `session.deleted`) and `experimental.session.compacting`. The plugin POSTs `/api/<slug>/sessions` on session creation but never POSTs `/summary` or `/end` during the session's lifetime. Decision 5 of that change's design.md justified this:

> opencode has no event that fires reliably when the user quits or the session is closed. `session.deleted` fires only on explicit user delete from the UI; `session.idle` may fire multiple times during a session whenever the agent is waiting. There is no `Stop` or `SessionEnd` analogue. […] Session closure relies on the agent voluntarily calling `memory.session_summary({summary, title})` before declaring work done.

That decision was made against the documented event surface at `opencode.ai/docs/plugins/`. The published list ends at `session.idle` and `session.deleted` for session-related events. After landing v1, end-user feedback ("at close, no summary lands like Claude/Codex") triggered a deeper investigation.

The investigation surfaced an undocumented but extant event: `server.instance.disposed`. Discovery path:

1. `strings $(which opencode) | grep -oE '"server\.[a-z][a-z._]*"' | sort -u` returned `"server.address"`, `"server.connected"`, `"server.heapsnapshot"`, `"server.heartbeat"`, `"server.instance.disposed"`, `"server.port"`, `"server.switch"`, `"server.sync"`. Only `"server.connected"` is documented.
2. A sniffer plugin subscribing to a broad event list (including `"server.instance.disposed"` as a top-level key AND via the generic `event` dispatcher) was installed at `~/.config/opencode/plugins/__sniff.ts`. Running `opencode mcp list` produced exactly one [SNIFF] line: `event.type=server.instance.disposed`. No top-level-keyed `server.instance.disposed` handler fired — the event reaches plugins via the dispatcher only.
3. This means `server.instance.disposed` is the closest functional equivalent to Claude Code's `SessionEnd` for opencode purposes: it fires when opencode tears down its server instance (i.e. when the user closes opencode).

The behaviour the user expects (and Claude/Codex deliver) is "at close, the session row in the dashboard has a transcript summary." With `server.instance.disposed` available, we can deliver it.

## Goals / Non-Goals

**Goals:**

- Make the opencode plugin POST `/api/<slug>/sessions/<id>/summary` at close time for every known top-level session, with a transcript reconstructed from per-session message accumulation.
- Match Claude Code / Codex CLI's user-visible behaviour: closing opencode leaves the dashboard's session row with a non-null `summary`.
- Document the undocumented `server.instance.disposed` event in the plugin development skill's per-client gotchas reference so future-us (or any contributor) doesn't lose track of its provenance.
- Run a verification spike BEFORE writing implementation code, confirming (a) async handlers are awaited at dispose time and (b) the SDK client is still usable. The spike's outcome is recorded as a `// dispose-spike-result:` comment in `plugin.ts`.

**Non-Goals:**

- Auto-closing the session with `/end` (status `'ended'`). The plugin still relies on `memory.session_summary({final:true})` (agent-driven) or `abandonStale` to terminate. The dispose-flush only writes the summary; it does NOT transition status. This mirrors Codex's per-turn `/summary` behaviour exactly and stays consistent with the existing `plugin-session-protocol` spec.
- Persistent transcript storage across opencode launches. The accumulator is in-memory only; an opencode hard crash before `server.instance.disposed` fires loses the transcript. Documented as a known limitation; same risk Claude/Codex carry today.
- A new opencode-specific HTTP endpoint. The change uses the existing `POST /:slug/sessions/:id/summary` route in `src/server/api-router.ts`, with `final:false` body (same shape Codex uses today).
- System-prompt injection. The existing `add-opencode-plugin::Decision 8` rationale stands — we still rely on MCP `initialize.instructions` for protocol delivery.

## Decisions

### Decision 1: Hook `server.instance.disposed` via the generic `event` dispatcher

The sniffer confirmed `server.instance.disposed` does NOT register as a top-level keyed handler — it reaches plugins via the `event: async ({ event }) => …` dispatcher only. Implementation:

```ts
event: async ({ event }) => {
  if (event.type === 'session.created') {
    /* existing */
  }
  if (event.type === 'session.deleted') {
    /* existing */
  }
  if (event.type === 'server.instance.disposed') {
    await flushAllSessions();
  }
};
```

`flushAllSessions()` iterates the closure-scoped `knownSessions` Set and POSTs `/summary` for each. The handler is async; the spike must confirm opencode awaits the promise before terminating (Decision 4).

Alternatives considered:

- **Top-level `"server.instance.disposed": async (input) => …` key** (mirroring `"chat.message"`): rejected. Sniffer test showed this does NOT fire (only the generic `event` dispatcher did). Opencode's event-routing is inconsistent across event names; the documented `chat.message` is top-level, the documented `session.created` is dispatcher-only, the undocumented `server.instance.disposed` is dispatcher-only. We adopt the working shape (dispatcher) rather than the cleaner-looking shape (top-level).
- **Periodic timer flush** (no event hook, just `setInterval`): rejected. Wakes the event loop continuously even when nothing's happening; race with opencode's own shutdown is ambiguous. The dispose event is the right trigger.

### Decision 2: Reconstruct transcript via in-memory accumulator, not via the SDK at flush time

Two ways to assemble the transcript at dispose time:

- **(a) Accumulate as we go**: subscribe to `chat.message` (user turns) and `message.updated` (assistant turns). Maintain `Map<sessionID, Array<{role, text}>>`. At dispose time, format the array into a transcript.
- **(b) Fetch from SDK at flush time**: call `ctx.client.session.messages.list({path: {id: sessionID}})` inside the dispose handler.

Method (b) is cleaner if the SDK is still functional at dispose time. Method (a) is robust regardless — the data is in our own memory, not gated on opencode's server state.

The cwd spike that discovered `server.instance.disposed` showed it fires AFTER opencode has begun teardown. The SDK client's HTTP base URL is `app.server.unreachable` at that point (visible in the strings dump). Calling SDK methods would likely return errors or hang. Method (a) avoids the race entirely.

Decision: (a). The plugin maintains `sessionMessages: Map<string, Array<{role: 'user'|'assistant', text: string}>>` populated by:

- `chat.message` handler — append `{role:'user', text: <joined parts>}` (the same extraction logic the current `chat.message` would-have-used in v1).
- `message.updated` handler — if `output.message.role === 'assistant'`, replace the assistant entry at `output.message.id` (or append if first seen); preserving message order via insertion position.

Sub-agent sessions remain excluded — both handlers check `subAgentSessions` first, same pattern as `tool.execute.after` in the existing v1.

Alternatives considered:

- **SDK-only fetch at flush time**: rejected per the teardown-race rationale above.
- **Hybrid (accumulate, fallback to SDK if accumulator is empty)**: rejected. Adds complexity for no real-world benefit — if accumulation didn't capture anything, SDK fetch during teardown is unlikely to succeed.

### Decision 3: POST `/summary` with `final:false`, NOT `/end`

The HTTP API at `src/server/api-router.ts` exposes:

- `POST /:slug/sessions/:id/summary` (body `{summary, title?, final?}`) — writes summary/title without transitioning status.
- `POST /:slug/sessions/:id/end` (body `{summary?, title?, final?}`) — sets `ended_at`, transitions to `status='ended'`.

The dispose-flush MUST use `/summary`, NOT `/end`. Reasons:

1. **Status semantics**. The session might actually still be valid in opencode's session DB after the user closed the TUI (e.g. user could `opencode --continue <id>` the next day). Marking it `'ended'` from the plugin commits to a finality the user may not have intended.
2. **Final-flag locking**. If the agent already called `memory.session_summary({final:true})` mid-session, the server's `summary_final = true` flag makes our `final:false` write a no-op (per the existing precedence rule in `plugin-session-protocol::Write precedence for summary and title MUST be expressed via a final:boolean flag`). That's exactly the behaviour we want — cooperating-agent summaries win over fallback transcripts.
3. **Symmetry with Codex**. Codex's per-turn `Stop` POSTs to `/summary` with `final:false`. The session stays `'active'` until `abandonStale` flips it to `'abandoned'`. Adopting the same pattern means opencode sessions behave identically in dashboard/consolidation terms.

Alternatives considered:

- **POST `/end` on dispose**: rejected per points 1 and 3 above. Would create an opencode-only divergence in session lifecycle that we'd have to maintain in `plugin-session-protocol` spec.
- **POST `/end` with a `--keep-active` flag**: rejected. Doesn't exist in the API; adding it for one client violates the don't-overcommit-spec-to-non-existent-endpoints rule we wrote in the skill.

### Decision 4 (resolved): SPIKE OUTCOME — fire-and-forget, pivot to per-turn flush

**Spike result, recorded 2026-05-19**: opencode does NOT await async handlers registered for `server.instance.disposed`. Two test variants confirmed:

1. Handler with `await new Promise(r=>setTimeout(r, 3000))` then `await fetch(...)`. Result: `[SNIFF-DISPOSE-START]` stderr marker fired, `[SNIFF-DISPOSE-END]` NEVER fired, NO row in `data-dev/data.db`. Process killed before the 3-second sleep completed.
2. Handler without any delay, just `await fetch(...)` immediately. Result: same — `[START]` marker fired, `[END]` never, NO row in DB. Even instant fetches don't survive the teardown.

Conclusion: relying on `server.instance.disposed` as the primary flush mechanism is unworkable. The HTTP POST has no chance to land.

**Pivot to a Codex-style per-turn pattern.** Instead of one flush at close, the plugin flushes after every "turn finished" event during the session lifetime. By the time opencode exits, the most recent flush already wrote the latest transcript to the server. Worst case the user loses the LAST turn's content (which they may not even have completed before closing).

The "turn finished" event in opencode is `session.idle` — documented as "Fires when session becomes inactive." This fires once per agent turn (after the assistant finishes responding and before the next user prompt). Mirrors Codex's `Stop` hook semantics exactly.

**Final design after spike pivot**:

- **`session.idle` handler (PRIMARY)**: debounced 500ms (collapse rapid-fire idle events), POSTs `/api/<slug>/sessions/<id>/summary` with the running transcript. This is the principal mechanism — by the time opencode exits, the summary is already current.
- **`server.instance.disposed` handler (BEST-EFFORT SECONDARY)**: fire-and-forget `fetch(...)` (NO `await`), assumes the request may not land. Provides last-chance coverage for the edge case where the user closes within the 500ms idle-debounce window after a turn finished. Documented as expected-to-often-fail; the user-facing impact is at-most-one-turn data loss in the worst case.

The spike-result comment in `plugin.ts` reads `// dispose-spike-result: fire-and-forget` per the spec requirement; the periodic-flush behaviour is described in a comment block above the `session.idle` handler.

Alternatives considered (after pivot):

- **Drop the dispose-flush entirely**: rejected. A free best-effort fetch costs us nothing — opencode might happen to flush its socket buffer to the kernel before SIGKILL'ing the subprocess. Even a low-probability success is positive.
- **Replace fetch with `node:http.request` synchronous send**: rejected. `node:http.request` is still asynchronous (callback or `'end'` event); there's no truly synchronous HTTP path in Node short of forking a subprocess. The fork-detach approach adds complexity (~50 LOC, separate flush script that survives parent kill) for marginal benefit over the per-turn flush.
- **Subprocess-detach flush**: rejected (see above).
- **Synchronous `XMLHttpRequest`-style via Bun**: rejected. Bun has no documented sync HTTP API; even if added, would still subject to the same SIGKILL race.

### Decision 4b (deferred → original): SPIKE BEFORE CODE — verify async-handler awaiting

The implementation is async (the dispose handler awaits an HTTP POST). If opencode does NOT await the handler's promise before terminating the process, the POST gets killed mid-flight and the summary never lands. This is a load-bearing assumption.

Pre-implementation spike steps (recorded in tasks.md phase 0):

1. Install a sniffer plugin that subscribes to the `event` dispatcher.
2. In the `server.instance.disposed` branch, perform a known-slow operation (e.g. `await new Promise(r => setTimeout(r, 3000))` followed by `fetch('http://localhost:NNNN/log', {method:'POST', body: 'DISPOSE_FLUSH_OK'})` against a small local HTTP listener).
3. Close opencode.
4. Inspect the local HTTP listener's log. If `DISPOSE_FLUSH_OK` arrived, opencode awaits async handlers. If absent, it fires-and-forgets.

The result determines the plugin design:

- **Awaits async**: the natural async POST works. Single line of behavior: `await rembricPost(...)`.
- **Fires-and-forgets**: the plugin must either (a) use `fetch` without `await` (no back-pressure, but the kernel may still send the packet before the process dies), or (b) drop to a synchronous HTTP call (`require('node:http').request` with the response ignored). Neither is great; pick whichever the spike shows still produces a successful POST observed at the server.

The spike outcome is recorded as `// dispose-spike-result: awaits-async-handlers` OR `// dispose-spike-result: fire-and-forget` in `plugin.ts`.

Alternatives considered:

- **Ship without the spike and find out post-merge**: rejected. The "no spike" mode produced silent feature-doesn't-work outcomes during `add-opencode-plugin` (the spec overcommitted to non-existent endpoints). Spike-before-code is now the project's standing rule for new opencode behaviour (`rembric-plugin-development` skill, "spike-before-code pattern for new clients").

### Decision 5: Re-register `chat.message` and `message.updated`

The current v1 spec explicitly states (`opencode-plugin::Event handler set`):

> The plugin SHALL NOT register `"chat.message"` or `"tool.execute.after"` in v1. Passive prompt and observation capture require corresponding server-side endpoints (`/api/<slug>/prompts/passive`, `/api/<slug>/observations/passive`) that do not yet exist on Rembric's HTTP API.

This change MODIFIES that requirement. `chat.message` and `message.updated` are re-introduced, but NOT for POSTing to non-existent endpoints. Their sole purpose is in-memory transcript accumulation. No HTTP POSTs from these handlers — they only mutate the closure-scoped `sessionMessages` Map. The original "don't overcommit to non-existent endpoints" rule is honoured: there's nothing to POST until dispose-flush.

`tool.execute.after` remains UNREGISTERED. Tool-execute counting isn't needed for the dispose-flush — it was originally tied to the same non-existent `/observations/passive` endpoint. Deferred to a separate change if useful.

Alternatives considered:

- **Use only `message.updated` and derive user prompts from it too**: rejected. `message.updated` is fired for both user and assistant messages, but the role discriminator is on `output.message.role`. We could filter there, but `chat.message` provides a cleaner, type-discriminated user-message signal that's stable across opencode versions. Two handlers is fine — the cost is ~10 lines.
- **Hook `session.idle` for periodic flush in addition to dispose**: see Non-Goals — deferred to a follow-up. Dispose flush is the must-have; periodic mid-session flush is defensive belt-and-suspenders for crash scenarios.

## Risks / Trade-offs

- **[Risk]** `server.instance.disposed` is fire-and-forget at the runtime level → our POST is killed mid-flight and the summary never lands. **Mitigation**: Decision 4's spike gates implementation. If fire-and-forget, the plugin falls back to a synchronous HTTP path or a best-effort `fetch` without await. Worst case: feature degrades gracefully to "no summary at close, same as v1."
- **[Risk]** `server.instance.disposed` event name changes in a future opencode release (it's undocumented). **Mitigation**: per-client-gotchas reference flags this as undocumented. An invariant test in `src/test/invariants.test.ts` SHALL check that `plugin/.opencode-plugin/plugin.ts` contains the literal string `'server.instance.disposed'` so a contributor doesn't accidentally remove it during refactors. If opencode renames it, the plugin breaks silently — operator detects via "session summary stopped landing on close"; we re-spike and update.
- **[Risk]** Transcript accumulator memory leak — `sessionMessages` grows unbounded if `session.deleted` doesn't fire to clean up. **Mitigation**: cap each session's array at 200 messages, dropping oldest (the dashboard's transcript max is 19500 chars anyway so we lose nothing visible). Cleanup on `session.deleted` is already wired in v1 (just needs to be extended to clear `sessionMessages.delete(sessionId)`).
- **[Risk]** `message.updated` fires multiple times per assistant turn (streaming token-by-token in opencode), each fire replaces the previous entry — potentially thousands of mutations per turn. **Mitigation**: idempotent replacement keyed by `output.message.id`. Cost is O(messages) per fire, acceptable for typical session sizes (<200 messages). If profiling shows this is a hot path, we debounce updates per message id.
- **[Trade-off]** Re-introducing `chat.message` re-opens the door to "but we could also POST passive prompts now" temptation. **Accepted because**: the spec is explicit — `chat.message` in this change is for in-memory accumulation ONLY. Adding HTTP POSTs requires a new OpenSpec change PLUS the server-side `/prompts/passive` endpoint. The static-grep invariant test SHALL fail the build if `chat.message` ever does HTTP work in plugin.ts.
- **[Trade-off]** The dispose-flush summary is "transcript-shaped" rather than LLM-authored. The dashboard's display is the same as Claude Code's bash-fallback or Codex's per-turn writer — a `role: content` concatenation. Operators reading the dashboard see structurally identical rows across all three clients. Cooperating agents that call `memory.session_summary({summary, title, final:true})` still beat this with their model-authored summary thanks to the `final:true` precedence rule. **Accepted because**: this matches the existing convergence-on-summary contract in `plugin-session-protocol` exactly — non-cooperating-agent path gets transcript; cooperating-agent path gets the model output.

## Migration Plan

No migration required — net-new behaviour for opencode users. Existing Claude Code, Codex CLI, and Hermes Agent users see no change.

Rollout sequence:

1. Land the OpenSpec change (proposal/design/specs/tasks merged to `main`).
2. Spike runs as task 0 of `tasks.md`. Outcome decides Plan A (`awaits-async-handlers`) vs Plan B (`fire-and-forget` mitigations).
3. Implementation PR ships the new handlers, the spike-result comment in `plugin.ts`, the per-client-gotchas update, the version bump 0.7.1 → 0.8.0, and the CHANGELOG entry.
4. End-to-end verification against the dev stack (recipe in the existing `e2e-walkthrough.md` extended for the dispose path).
5. Existing opencode users who installed via `curl … | sh` re-run the same line to pull the updated plugin.ts + bridge from `main`. No new config required — `server.instance.disposed` hooks fire automatically once the new plugin file is in place.

Rollback: revert the merge commit. Pre-v0.8.0 opencode plugin behaviour (no dispose-flush) is restored. Operators who already received the new plugin file would need to re-run their install.sh against `main` after the revert.

## Open Questions

- **Title derivation**: should the dispose-flush POST a `title` alongside the `summary`? Today the server writes a placeholder `basename(cwd) · HH:MM UTC` at session creation; if we send a real `title:` derived from the first user message, the dashboard's session-list column becomes more useful. Codex's per-turn writer does this (first assistant message, truncated). Recommend: derive title from `sessionMessages[id][0].text.slice(0, 100)` (first user prompt) and send it with `final:false`. The agent's `final:true` call still overrides if it comes. Recorded as task 4.3 in tasks.md — implement if cheap.
- **Whether to ALSO fire a periodic flush during the session**: deferred. If post-implementation testing shows `server.instance.disposed` to be reliable (Decision 4's spike + e2e), no periodic flush needed. If `disposed` proves unreliable in some scenario (opencode crash via OOM, SIGKILL, etc.), follow-up change adds `session.idle` debounced flush as defence in depth.
