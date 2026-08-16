## Context

The summary reminder is a turn counter with five copies of its constant and three independent counter mechanisms behind it. The counter answers "how many prompts have there been", which is not the question. The question is "has anything happened since the summary was last written", and no participant can answer it today: no row records when a summary was written, and the client that could see the work does not know what is stored.

Two measurements taken on this tree frame the whole design (both reproduced by driving the real scripts through real per-session counter files; both recorded in `proposal.md`):

- A 20-turn conversation with **no tool use at all** receives five reminders, 1880 bytes, from `prompt-nudge.sh`, which never opens the transcript.
- The one transcript-aware surface, `stop-nudge.sh`, emits 1044 bytes at turn 10 under Claude Code and `{}` under Codex CLI on an equivalent work-bearing transcript, because `_rembric_facts_raw_codex_cli` does not exist. The three in-process clients have no equivalent surface at all and receive only the core's delta-voice `SUMMARY_NUDGE`.

Two constraints shape everything below. First, this change lands **on top of** `refine-session-summary-writes`, which makes an absent `##` section mean "unchanged" and therefore makes partial writes the intended use; this change consumes that contract and does not restate it. Second, the published byte budgets in `claude-code-plugin` are asserted per line against `apps/plugin/test/nudge-fixtures.json`, and the notice this change introduces is the first model-facing string that has no fixture — it is composed on the server, per session, from stored state.

## Goals / Non-Goals

**Goals:**

- A reminder fires only after work has happened and only once per floor, on all five clients, from one implementation.
- The client holds no cadence, no counter and no nudge text — it observes one turn, reports it, and prints what it is handed.
- The reminder tells the model what is currently stored, in a form that cannot be read as a length target.
- Every byte figure is measured rather than argued, and a cap moves only where the arithmetic forces it. Two do — the reminder relocates from an uncapped channel onto a capped one (D6a) — and the total cost across both channels still falls.

**Non-Goals:**

- The write contract. `refine-session-summary-writes` owns the section-wise merge, the heading-less rejection and the second cap check; nothing here re-specifies them.
- `session_summary_versions`. A later change retires it, and no argument below rests on its existence.
- Any LLM, any similarity check, any relevance scoring of the turn.
- Any mandatory read before writing. The notice's inventory is not a substitute for `memory.session_get` and does not oblige a read.
- Retiring the shared transcript accumulator. See D11.

## Decisions

### D1. The gate is three timestamps on the row, not process state

`last_work_at`, `last_summary_at`, `last_nudge_at`, all nullable, all on `sessions`. Firing condition:

```
last_work_at IS NOT NULL
AND (last_summary_at IS NULL OR last_work_at > last_summary_at)
AND now - COALESCE(last_nudge_at, started_at) >= NUDGE_FLOOR_MS
```

NULL semantics are spelled out because they decide the first firing of every session: a NULL `last_summary_at` means "never written" and satisfies the second clause; a NULL `last_work_at` means "no work reported" and fails the first; a NULL `last_nudge_at` measures the floor from `started_at`, so the earliest a notice can fire is one floor after the session began.

Rejected: keeping `last_work_at` and `last_nudge_at` in a process-local `Map` and persisting only `last_summary_at`. It costs nothing in the happy path, but it makes the gate a function of process uptime — a server restart re-arms the floor and drops the work flag, so the observable behaviour of a nudge depends on when the operator last upgraded. Three columns are one `ALTER TABLE`, and they ride on the `UPDATE` the ping already performs for `last_activity_at`, so persistence costs no additional statement.

Rejected: deriving `last_summary_at` from `session_summary_versions.created_at`. It is wrong twice — a byte-identical re-write appends no version row (published behaviour), and a later change retires the table.

`last_summary_at` is written at the SAME single precedence site that writes `summary`, which `sessions` already requires to be one place ("**One site.** The append SHALL be emitted from the same single place that folds per-field `final` precedence into an update `set`"). A second site is how the column and the summary come to disagree.

### D2. The floor is 25 minutes, one exported constant, and it is a floor rather than a period

`NUDGE_FLOOR_MS = 25 * 60_000`. It is a _minimum interval_, not a schedule: nothing fires without new work, so a session that works continuously for three hours receives at most seven notices and a session that chats for three hours receives none.

25 minutes sits below the interval at which a working session compacts (the moment the stored summary matters most) and above the span of a single sub-task, so a notice does not interrupt one. The number is a starting value, deliberately at the top of the 20-30 minute band the owner named, and the applier records the observed firing count from the Docker smoke rather than asserting the model of use.

Rejected: making it operator-configurable. A configurable cadence is a fifth place for the number to live, and the failure this change fixes is that the number lived in five places.

### D3. The ping is at the END of the turn and the print is at the START of the next

The client reports the turn it just finished. Putting the request at the start of a turn would place an HTTP round trip on the path where the user has just pressed enter, and would report a turn that has not happened yet.

The consequence is that the notice is always one turn late, and that is why the session opening stays local (D7): a one-turn session would otherwise receive nothing.

The client caches the returned lines and prints them on its next start-of-turn surface: `prompt-nudge.sh` stdout for the shell clients, `chat.message` parts for opencode, `before_agent_start` for Pi, `prefetch()` for Hermes. **A ping that returns no lines SHALL NOT clear a non-empty cache.** Without that rule a second Stop on the same turn — a continuation triggered by an unrelated hook — would ping again, get "floor not elapsed", and overwrite a pending notice with nothing.

### D4. `usedTools` is what the client OBSERVED, and fail-open is the named default

The field is named for the observation, not for the interpretation: the client reports whether it saw a tool invocation in the turn; the server decides that this constitutes work. Keeping the two apart is what lets a later change alter the interpretation without touching five clients.

**All five clients can produce the boolean.** The owner made this an explicit requirement of the change rather than an implementation detail, so the evidence for each is recorded here with its grade, and "grade" means what was actually done, not how confident the reading feels. Four mechanisms are verified end to end; Hermes's DELIVERY is verified from upstream source and only its runtime CONTENT is unmeasured.

| client      | source                                                                                                            | evidence grade                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | host JSONL, bytes appended since the previous report, matched against `"type":"tool_use"`                         | **verified** — that marker is what `_rembric_facts_raw_claude_code` (`apps/plugin/scripts/_transcript.sh:181`) already selects tool activity on                                                                          |
| Codex CLI   | same delta scan, matched against `"function_call"` / `mcp_tool_call`                                              | **verified** — the transcript is already parsed (`_transcript.sh:466,497`) and today's filter passes only `payload.type` `user_message`/`agent_message`, so tool detection is one more `select` over a file already open |
| opencode    | per-session flag set in `message.part.updated` when `part.type` is not `text`                                     | **verified** — the installed SDK enumerates the part types and `tool` is one of them, while `plugin.ts:207` discards everything that is not `text`                                                                       |
| Pi          | per-session flag ACCUMULATED across `message_end` (see D4a)                                                       | **verified by a real run** (`pi --no-session --mode json -t ls -p …`) plus the 0.84.1 type declarations                                                                                                                  |
| Hermes      | the `messages` kwarg of `sync_turn` — role outside `{user, assistant, system}` OR an assistant `tool_calls` field | **code path traced end to end in upstream source at a pinned commit; not observed at runtime** — see the split below                                                                                                     |

**Hermes's chain was traced in the upstream tree rather than read off a documentation site, and it holds at every link.** Verified against `NousResearch/hermes-agent` at commit `7095e23` (2026-08-16), each reference re-checked here rather than relayed:

1. `agent/tool_executor.py` appends tool-result messages into the working `messages` list at **seven** sites — `:996`, `:1715`, `:1808`, `:1847`, `:1889`, `:2521`, `:2588` — via `make_tool_result_message(...)` and `tool_message`.
2. `make_tool_result_message` sets `"role": "tool"` literally (`agent/tool_dispatch_helpers.py:562`).
3. `agent/turn_finalizer.py:120` takes `messages` as a first-class parameter of `finalize_turn`, distinct from `conversation_history`, and passes it on at `:779`.
4. `run_agent.py:4357-4363` builds `sync_kwargs` and forwards `messages` when non-`None`; `agent/codex_runtime.py:898` is an equivalent second invoker.
5. `agent/memory_manager.py:712-718` calls `provider.sync_turn(user_content, assistant_content, session_id=..., messages=...)`, gated by `_provider_sync_accepts_messages` (`:664-673`), which returns `True` for any provider declaring a `VAR_KEYWORD` parameter. Ours is `sync_turn(self, user, assistant, **kwargs)` (`apps/plugin/.hermes-plugin/__init__.py:543`), so it qualifies unchanged. That inspection exists because most sibling providers in the same repo still declare the older signature.

**What this buys is a change of KIND, not just of confidence.** `messages` is not a list assembled for memory's benefit — it is the agent loop's own working list, the one the tool executor writes results into. So "the list contains tool results" stops being the project's claim about its contract and becomes a consequence of the path. The role half of our condition is traced to the literal `"role": "tool"`.

**The limit, stated exactly and not rounded.** The `tool_calls` field on the assistant message was NOT traced to its append; searching for it independently did not find one either. That half still rests on the ABC docstring ("including any assistant tool calls and tool results"). Operationally it costs nothing — a turn that used tools produces results, so the role condition alone decides the boolean — and the two-condition rule stays, because it is the correct rule for the OpenAI shape and its untraced half is defensive rather than load-bearing.

There is deliberately no risk here about our parameter names differing from the ABC's. The call site passes the two leading values POSITIONALLY, so `user`/`assistant` versus `user_content`/`assistant_content` cannot break. It is recorded as a non-risk so a later reader does not rediscover the mismatch and treat it as one.

**One consequence the trace turned up that no one was looking for: Hermes does not report an interrupted turn at all.** `_sync_external_memory_for_turn` returns before `sync_all` when `interrupted` is true (`run_agent.py:4345-4346`), and again when the flattened user or response text is empty (`:4347-4348`, `:4354-4355`). Our report rides on `sync_turn`, so on those turns there is no report — which means no `usedTools`, no notice, and, more importantly, **no `last_activity_at` stamp**. It is recorded in `hermes-agent-plugin` as a named per-client deviation from "exactly one report per finished turn" rather than left to be found when a heavily-interrupted Hermes session is retired by the stale-active sweep.

**Hermes carries two corrections that a role-only reading would have got wrong**, and they are worth stating here rather than only in its capability. First, in the OpenAI message shape a tool CALL lives in the `tool_calls` field of an `assistant` message and the RESULT is a separate `role: "tool"` message, so testing roles alone detects results and misses a call that produced no result. Second, the kwarg exists only on Hermes ≥ 2026.5.29; below that the provider's own fallback (`apps/plugin/.hermes-plugin/__init__.py:552-557`) synthesises the list as exactly one `user` and one `assistant` message, where both conditions are unsatisfiable **by construction**. That is why the absent-kwarg branch reports `true`: not out of caution, but because a `false` there would assert "no tool ran" from evidence that could never have shown one.

**A client that cannot observe tool invocation SHALL send `true`.** Fail-open costs at most one notice per floor on a session with no work; fail-closed disables the feature entirely on that client, silently, which is precisely the asymmetry the current design produced. The inability SHALL be named in the client's own spec, so it is a recorded gap rather than an undiscovered one.

### D4a. Pi's observation must be accumulated across the turn, and a single-event reading is always wrong

Pi's trap deserves its own decision because the obvious implementation — read the message the turn settled on — returns `false` for every turn that used tools.

Measured against pi-coding-agent 0.84.1: the LAST `message_end` of a turn, which is the one this extension's handler processes today, is the assistant message with `stopReason: "stop"` whose content is text only. The `toolCall` parts were in an EARLIER `message_end` with `stopReason: "toolUse"`, and the results arrived as separate messages with `role: "toolResult"`. `turn_end.toolResults` is empty on that final turn as well, so it is not an escape either. The shape is confirmed in the installed declarations: `AssistantMessage.content` is `(TextContent | ThinkingContent | ToolCall)[]` with `ToolCall.type === "toolCall"`; `ToolResultMessage.role === "toolResult"` is one of the three members of `Message`; `StopReason` includes both `"toolUse"` and `"stop"`.

So the design is a flag with three touch points on handlers the extension already registers: reset in `before_agent_start`, set in `message_end`, read and cleared in `agent_settled`. No new subscription.

Two existing filters discard the signal and neither is loosened to carry it. The `message_end` handler returns early unless `role === 'assistant'`, dropping every `toolResult`; and `assistantText` filters content to `type === 'text'`, dropping every `toolCall` part. `assistantText` feeds the transcript accumulator, which legitimately wants text, so the flag is set BEFORE both filters rather than by widening either.

Rejected: the five dedicated tool events (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call`, `tool_result`). They are genuinely available — all five are declared on the public extension API, `pi.on` stores any key into a handler `Map` with no whitelist, dispatch is a plain `handlers.get(event.type)` lookup, and the runner is the same one that already delivers `message_end`; there is no mode filter, and the extension emit happens before the public stream emit. They would be simpler, needing no content inspection. They are rejected on evidence grade alone: `message_end` delivery to this extension is observed in production, while the five rest on reading that code chain, and one check was NOT run — no purpose-built extension was loaded with `pi -e` to receive them. A later change may switch to `tool_execution_end` once that check exists; the accumulation rule survives the switch unchanged.

The boolean tolerates over-inclusion by construction: a stale `true` advances `last_work_at` to a moment when work HAD recently happened, so the notice remains correlated with work; under-inclusion loses a notice outright, which is why the fallback direction is `true`.

For the shell clients the delta scan is bounded rather than exact. Each ping records the transcript's byte length; the next reads only from that offset. On a cold offset (a new process) it scans at most the last 256 KB and reports `true` if the marker is present there. This is what keeps the ping off the cost curve that `stop-nudge.sh` sits on — ~0.5 s of `jq` per firing by its own comment (`stop-nudge.sh:59-60`), 790 ms measured on an 8.36 MB transcript, 22.6 s on 213 MB.

Rejected: a `PostToolUse` hook touching a marker file. It is exact and O(1) per turn, but it spawns a process on every tool call, and three published requirements enumerate the hook catalog as exactly six event types with no `PostToolUse` entry. The delta scan needs no manifest change and no per-tool-call process.

Rejected: counting Rembric's own MCP calls server-side. It is silent exactly when the session has stopped using memory tools — the case the notice exists for.

### D5. One notice, and the save reminder is folded into it rather than given its own floor

Two floors would mean two constants again. The save trigger is imprecise in a way a floor cannot fix — neither side can say what is memorable — so a second, shorter floor buys frequency at the same imprecision. Prompt saving is already obliged by `initialize.instructions` on every turn, unconditionally, which is the surface that should carry it: it is always present and costs nothing per turn.

What the notice CAN say honestly is elapsed time. Where the session has run a long stretch with no memory written, the notice names that, rather than claiming to know what was worth keeping.

### D6. The notice is composed on the server, capped at 640 UTF-8 bytes, and elides deterministically

Three parts: the directive (send only the `##` sections that moved; omitted sections keep their stored text; nothing to add means do not call), the inventory (the live title, then each stored `##` heading with its current body size), and the closing total.

The inventory's wording is contract, not style. A draft reading "Summary for this session (2 412 ch)" was read by a human as a LIMIT, and a model under length pressure would trim to it. The rendered form is therefore prefixed "current sizes, not targets" and closed "2 412 used of 10 000 available", so the only number that looks like a bound is the bound.

The cap is enforced by construction because the input is unbounded: the merge contract permits any `##` heading, so a stored summary may carry many sections with long names. The renderer walks sections in stored order, truncates each heading name at 32 characters, and replaces the tail of the list with `+k more` as soon as the next entry would exceed the cap. Deterministic, so it can be pinned by a test at the boundary rather than approximated.

Two branches, one function: with no stored sections the inventory is replaced by the canonical section list interpolated from `SUMMARY_SECTIONS`, the existing single source. That keeps the new server surface inside `invariants.test.ts::"the session-summary rubric has one source"`, whose completeness check already recognises `${SUMMARY_SECTIONS}` interpolation.

Measured on the drafts, against the current fixtures: directive 236 bytes, a representative six-section inventory 231, the pair 468; a notice turn with the sessionId line 674, inside the published ≤800 turn-1 sub-budget. The applier re-measures from the emitted string.

**The 640 is derived, not chosen, and the derivation is D6a below.**

### D6a. Two published byte caps move, and the arithmetic is stated rather than the number asserted

The reminder moves from a channel `claude-code-plugin` deliberately left uncapped onto one that is capped, so the receiving channel's numbers have to absorb what the sending channel never counted. Both new values come out of one calculation.

The worst reachable start-of-turn combination is the counter-divergence case that ceiling has always been set against, with the notice in place of the retired `save`+`summary` pair: `firstPromptRelevance` (125) + recall (90) + rendered `sessionIdTemplate` (204) + the notice + 4 newlines. Solving that against a round ceiling gives the notice **640 bytes** and the ceiling **1088** (1063 measured, rounded up for margin), against the published 960 and a measured 917 for the equivalent case today.

The ten-turn amortised budget rises 180 → 240 bytes/turn for the same reason and no other: it governed `UserPromptSubmit` alone while the reminder sat on `Stop`, so it never counted the reminder. Measured today across ten turns of a working session, `UserPromptSubmit` emits 1230 bytes (123/turn) and `Stop` a further 1044 — **227 bytes/turn across both**. Under this change the same window emits 668 plus 846 per elapsed floor: 151 bytes/turn at one, 236 at two, all on the one channel.

Rejected: keeping the 960 ceiling by squeezing the notice to ~537 bytes. A six-section inventory plus the directive measured 468 on a modest session, so 537 leaves no room for the elision rule to be anything but permanently active, and a cap that is always binding is a cap that silently determines the content.

Rejected: leaving the reminder on the `Stop` channel to avoid moving any cap. That is what makes the number look good while the model pays the same tokens — and it is unavailable anyway, because the reminder is now fetched at the end of one turn and delivered at the start of the next.

The turn-1 sub-budget (≤800) does NOT move: measured 759 with a recall keyword, against 797 today.

### D7. The session opening stays local, and its wording is the point

Gated on the `created` flag `postSessionEnsure` already returns (`rembric-plugin-core.mjs:149-154`), so it fires once, on a genuinely new session. It exists for the ONE-TURN session: the notice is a turn behind by construction (D3), so a session that ends after one turn would receive nothing at all.

It asks for a title and `## Goal` only, with the other five headings left out — which is a legitimate write precisely because the sibling change made an absent section mean "unchanged". Before that contract this instruction would have been an instruction to store a one-section document.

Its wording is **"before you finish this turn"**, never "now". "Now" makes the model write a summary of a session that has not started, which is what turn 1 produces today; "before you finish this turn" makes it do the user's work first and write as it closes.

### D8. The sessionId line stays client-composed

It could ride in the server's response — the server has the id, because the ping carried it. It does not, for two reasons: the line must also accompany the local opening, which the server knows nothing about; and `sessionIdTemplate`'s byte-identity across five clients is an existing, passing fixture assertion with no reason to move. The published trigger changes from "whenever the save or summary nudge fires" to "whenever a line directing a write is emitted, local or server-composed", which is the same rule stated over the new surfaces.

### D9. `stop-nudge.sh` becomes `stop-report.sh`, emits nothing, and keeps the loop guard for a new reason

The Stop channel stops carrying text. That removes the hazard `guard-stop-nudge-reentry` was written for at its root — `additionalContext` on `Stop` is appended to the array the host treats as `blockingErrors`, and an unguarded reminder re-fired on 141 consecutive continuations in that change's measurement. A hook that emits nothing cannot continue a turn.

The `stop_hook_active` guard nevertheless stays, and its rationale changes: it now makes the ping exactly-once-per-turn. A continuation triggered by some other hook fires `Stop` again, and a second ping would re-scan the same transcript delta and, worse, could overwrite a pending notice (D3). Keeping the guard is cheaper than making the cache and the offset marker idempotent under re-entry.

The Codex arm keeps emitting `{}`, which its host requires on `Stop`.

### D10. The facts leave the reminder and stay as the fallback, at `session-end.sh`

`sessions`'s "A session that ends without a curated summary MUST still leave grounded, checkable facts" is about the summary written when the agent never cooperated. `stop-sync.sh` was its only caller (`rembric_session_facts`), so deleting `stop-sync.sh` without moving the call would leave that requirement unimplemented.

The call therefore moves to `session-end.sh`, which is where "a session that ends without a curated summary" actually happens, and which runs once rather than every turn. Under Codex the move is a no-op today — `_rembric_facts_raw_codex_cli` does not exist, so the call returns empty and the existing transcript formatter still runs — which also keeps the move inside Codex's 1-3 second `SessionEnd` budget without any new guard.

Every function in `_transcript.sh` survives. Only two call sites move: the facts call to `session-end.sh`, and nothing else.

Rejected: deleting the facts machinery outright. The argument for deleting it from the NUDGE is sound — with partial writes the model describes only the recent stretch, which is still in its window — and it does not transfer to the fallback, where there is no model at all.

### D11. The transcript accumulator and the terminal flushes are NOT removed

Deleting them would leave a non-cooperating opencode session and a non-cooperating Pi session with `summary IS NULL`. Both are governed by published requirements grounded in measurements against real hosts: `plugin-session-protocol`'s opencode convergence rests on the `server.instance.disposed` flush of the in-memory accumulator, and its Pi convergence rests on the awaited `session_shutdown` POST of the same accumulator, measured against harness 0.84.1.

What this change removes is the PER-TURN raw sync on the shell clients (`stop-sync.sh`), whose body is re-derived from a file the host already persists and which `session-end.sh` and `pre-compact.sh` re-read anyway. `flushSessionSummary`, `flushAllFireAndForget`, `scheduleIdleFlush` and the accumulator itself are untouched.

The cost of removing `stop-sync.sh` is stated rather than assumed: a Claude Code or Codex session hard-killed between two terminal events stores no summary in Rembric, where today it would store the previous turn's transcript. The host's own transcript file survives on disk, and both hosts fire `SessionEnd` on every normal exit, so the exposed window is a hard kill.

Retiring the accumulator entirely belongs to a change that names each host's replacement transcript source — for Pi, `ctx.sessionManager.getSessionFile()` is a candidate; for opencode there is no verified one.

### D12. The provisional title moves onto the ping

`stop-sync.sh` carried the shell clients' per-turn title write (`rembric_extract_first_assistant_*`), and it is going. The ping carries an optional `title`, sent once per session, written with the existing `final:false` precedence so it is displaced by any later model-authored title exactly as today.

Its source is unified on the **first user prompt**, ≤100 characters, `<private>`-redacted before it leaves the client. Two clients already derive from the first user entry (`deriveTitle`, `rembric-plugin-core.mjs:266-271`); this aligns the other three to them rather than the reverse, because the user's first prompt says what the session is about while an assistant preamble often does not, and because every client has the prompt at turn start with no transcript parse.

For the shell clients the prompt is available at `UserPromptSubmit` and not at `Stop`, so `prompt-nudge.sh` writes it once into the same per-session marker directory the pending-lines cache uses, and `stop-report.sh` consumes and clears it.

### D13. What stays local, and why the boundary is where it is

- **Recall** is a regex over the prompt. The server does not have the prompt when it composes a notice, because that notice was decided by a ping at the end of the previous turn. Moving it would require a request per prompt on the latency-critical path — a prefetch already considered and rejected for this hook in `claude-code-plugin`.
- **The opening** is D7.
- **The resumed-read line** is gated on the ensure's `created` flag and is unchanged by this change. Its purpose partly overlaps the notice's inventory, which also tells the model something is stored; that overlap is recorded and not acted on, because the line fires at a moment the notice cannot reach (before the first floor elapses).

This is complexity moved, not removed, and saying so is part of the contract: the client keeps three local rules instead of a cadence, and the server takes the one rule that needed state neither side had.

### D14. The two published rationales this change owns are corrected, not weakened

`refine-session-summary-writes` left them by name because this change owns their text:

- `plugin-session-protocol/spec.md:720` — _"so sending the window alone stores the window alone"_ — is true after the merge only of a window carrying no `##` heading, or one carrying every stored heading. The obligation (the block must state what the write does) is unchanged; the rationale is restated in merge terms.
- `opencode-plugin/spec.md:307` carries the same sentence in the handler's own words, and `:309` argues from it: _"the shared fixture's `this REPLACES the stored value` says a thin rewrite overwrites the prior state"_. Both are corrected.

The `postCompact` fixture itself says "this REPLACES the stored value". Under the merge that is true of a full six-heading rewrite and false of a partial one, and the post-compaction moment is exactly when a model writes partially. The fixture text is corrected in this change and re-measured against its published ≤700-byte cap, as is `commands/summary.md`, which carries the same claim. Those two surfaces plus `endOfTurnRubric` (deleted here) are the set `refine-session-summary-writes` D12 deferred.

## Risks / Trade-offs

- **[Risk] The traced path is right about the source and wrong about the runtime — the list arrives shaped differently than the code reads.** Every link is now read at a pinned upstream commit, including `"role": "tool"` at its literal, so this is no longer "we do not know whether this works"; it is the residue that source reading always leaves. → Mitigation: one corroboration (0.5b) dumps the roles on a tool turn against a live Hermes; it gates CLOSING the change, not implementing it, because a wrong reading would surface as the boolean staying `false` on a tool turn, which is a missed notice bounded by the floor and not a broken host.
- **[Risk] The `tool_calls` half of the Hermes condition is the one clause with no trace behind it.** It was not followed to an append, and an independent search did not find one. → Mitigation: it is defensive rather than load-bearing — the traced role half decides the boolean on any turn that actually ran a tool — so its worst case is that an aborted call producing no result message reports `false`, one missed notice. It stays because it is the correct rule for the OpenAI shape and costs one condition.
- **[Risk] A heavily-interrupted Hermes session is retired by the stale-active sweep.** `_sync_external_memory_for_turn` returns before `sync_all` on an interrupted turn (`run_agent.py:4345-4346`), so no report is issued and `last_activity_at` is not stamped. → Mitigation: named in `hermes-agent-plugin` as a per-client deviation rather than left implicit; the window is the abandonment threshold (24h default) against a user interrupting every turn for that long, and the client's other lifecycle writes (`on_pre_compress`, `on_session_end`, the per-turn transcript POST, which sits on the same suppressed path) bound it no further — which is precisely why it is written down instead of assumed away.
- **[Risk] Pi's flag is implemented by reading the settled message instead of accumulating, and reports `false` on every tool-using turn.** This is the likely implementation error, not a host uncertainty: the mechanism is verified, but the LAST `message_end` of a turn carries no `toolCall` part and `turn_end.toolResults` is empty there. → Mitigation: D4a makes accumulation normative, `pi-plugin` carries a scenario whose CONTROL asserts that inspecting only the final event yields `false`, and the mutation phase reddens it. A test that only asserts `true` on a tool turn would pass against the broken implementation if the harness happened to settle differently, which is why the control is the load-bearing half.
- **[Risk] The shell clients' delta scan reports work from an earlier turn after a process restart.** The cold-offset path scans the last 256 KB. → Mitigation: accepted by construction — over-inclusion advances `last_work_at` to a moment work really did happen (D4), and the floor bounds the consequence to one notice.
- **[Trade-off] A hard-killed shell session loses its Rembric summary where today it would hold the previous turn's transcript.** → Accepted because the per-turn sync re-derives a body from a file the host already persists, both hosts fire `SessionEnd` on every normal exit, and the exposure is a SIGKILL — the same class of loss opencode and Pi already carry and `plugin-session-protocol` already documents as out of scope.
- **[Trade-off] With the server unreachable there are no nudges at all, where today they are 100% local (verified: neither nudge script contains `rembric_post` or `curl`).** → Accepted because with the server unreachable `memory.save` and `memory.session_summary` fail too, so the nudge would instruct the model to do something impossible. The client's existing failed-POST contract already turns the failure into one stderr diagnostic and a successful exit.
- **[Risk] A mixed-version pairing behaves differently from either matched pair.** An old client against a new server never pings, so it keeps its own counter nudges and the server never fires; a new client against an old server gets `404` on `/turn` and emits only its local lines. → Mitigation: both degrade to FEWER nudges and neither degrades the host; stated in `proposal.md` under Existing installations, and the `404` path is covered by a task.
- **[Risk] The notice's inventory is read as a length target despite the wording.** → Mitigation: the wording is contract text with its own scenario ("current sizes, not targets" present, the total rendered as "used of available"), not style advice; and the failure mode if it happens anyway is a shorter summary, not a lost section, because the merge keeps what the write omits.
- **[Risk] The 640-byte notice cap is reached and elision hides the section the model most needed to see.** → Mitigation: elision is tail-first in STORED order, and stored order is the canonical order, so `## Goal` and `## Accomplished` are never the entries dropped; a boundary test pins the elision at the cap.
- **[Risk] The `Stop` hook now performs a synchronous HTTP POST where it previously did a synchronous parse.** → Mitigation: the parse it replaces measured 790 ms on an 8.36 MB transcript and is uncapped upward until a 32 MB ceiling; the POST is bounded by `REMBRIC_POST_MAX_TIME`. The applier measures the new hook's wall clock and records both numbers, on the same instrument, rather than assuming the trade.
- **[Risk] The rubric one-source enumeration changes shape and a surface slips out of it silently.** → Mitigation: that enumeration asserts its own completeness from `git grep`, so a surface that keeps the directive but leaves the list fails the test; the task list requires running it after the plugin files are staged, which is the known caveat.

## Migration Plan

One migration adds three nullable columns to `sessions` with `ALTER TABLE … ADD COLUMN`. No table rebuild, so the `PRAGMA foreign_keys` dance and its `DROP TABLE` hazard do not apply; the runner's `foreign_key_check` gate passes trivially. No backfill and no derived-data invalidation — `memory_fts`, `memory_vec` and the three entity tables are untouched.

First boot after upgrade: every existing session reads `NULL` for all three, which the gate treats as "no work reported" and which suppresses the notice until a client pings. Rollback to a pre-change image leaves the columns present and unread. The two release tracks are independent, so server and plugin roll back separately, and both mixed pairings are the degraded-to-fewer-nudges cases above.

## Open Questions

- **Should `NUDGE_FLOOR_MS` be tuned from the smoke rather than fixed at 25 minutes?** Default taken: fix it at 25 and record the observed firing count. Revisit only with a measurement from a real session, not from an argument about session length.
- **Should the notice name the elapsed time since the last memory write when the model has saved nothing for a long stretch (D5)?** Default taken: yes, as one clause inside the 640-byte cap, dropped first by the elision rule. If the measurement shows it does not fit alongside a six-section inventory, it is cut rather than the cap raised.
- **Should `memory.session_summary` also stamp `last_work_at`?** Default taken: no. A curated write is not work in the sense the gate means — it is the response to the notice — and stamping it would keep the gate armed against its own satisfaction. Recorded because it is the first thing an implementer will reach for.
