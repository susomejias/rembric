## 0. Tool-observation sources: all five settled in source; one corroboration outstanding

The owner made five-client symmetry a requirement of the change rather than a wish, so each client's source is settled before implementation. Every mechanism is settled and written into `design.md` D4/D4a and the per-client capabilities. **Nothing here blocks implementation.** What remains are confirmations run alongside it, and one — 0.5b — gates CLOSING the change rather than starting it.

- [x] 0.1 **Claude Code — settled.** `"type":"tool_use"` is the marker `_rembric_facts_raw_claude_code` (`apps/plugin/scripts/_transcript.sh:181`) already selects tool activity on, so the delta scan matches a marker the tree already depends on.
- [x] 0.2 **Codex CLI — settled.** The transcript is already parsed (`_transcript.sh:466,497`) and today's filter passes only `payload.type` `user_message`/`agent_message`; tool detection is one additional `select` over a file the script already opens. Confirm during implementation WHICH marker to pin — `"function_call"`, `mcp_tool_call_end`, or both — and record the choice.
- [x] 0.3 **opencode — settled.** The installed SDK enumerates the message part types and `tool` is one of them, while `plugin.ts:207` discards everything that is not `text`. Confirm the concrete `part.type` string during implementation by logging distinct values on one tool turn.
- [x] 0.4 **Pi — settled by a real run** (`pi --no-session --mode json -t ls -p …`) against pi-coding-agent 0.84.1. The mechanism and its trap are normative in `design.md` D4a and in `pi-plugin`. Two things carry forward into implementation rather than into verification: the flag MUST accumulate across `message_end` (the settled message carries no `toolCall` part and `turn_end.toolResults` is empty on that turn), and the extension's own `execute` callback MUST NOT be used, because it observes only Rembric's tools.
- [x] 0.5a **Hermes delivery — settled from upstream source, re-verified here at commit `7095e23`.** The `MemoryProvider` ABC declares `sync_turn(self, user_content, assistant_content, *, session_id="", messages=None)`; the dispatcher's `_provider_sync_accepts_messages` returns `True` for any provider declaring a `VAR_KEYWORD` parameter; our signature is `sync_turn(self, user, assistant, **kwargs)` (`__init__.py:543`, confirmed in this tree), so it qualifies unchanged. The two leading values are passed positionally, so our parameter names diverging from the ABC's cannot break — do NOT "fix" them, and do NOT narrow `**kwargs`.
- [ ] 0.5b **Hermes content — CORROBORATION, not discovery. Gates closing the change, not starting it.** The chain is traced at upstream commit `7095e23`: the tool executor appends results into the working `messages` list at seven sites, `make_tool_result_message` sets `"role": "tool"` (`agent/tool_dispatch_helpers.py:562`), `finalize_turn` carries `messages` as a first-class parameter, and the runtime forwards it into `sync_all`. So implement against the role condition now. Before the change is closed, against a running Hermes ≥ 2026.5.29, on ONE turn that invoked a tool, dump every `role` present in `kwargs["messages"]`. Record whether any `assistant` message carries a non-empty `tool_calls` while you are there — that half is the one clause with no trace behind it — but its absence is not a failure: drop the clause and say so. Only a run that shows NO `role: "tool"` on a tool turn contradicts the trace, and that outcome takes the unconditional fail-open branch and amends `hermes-agent-plugin` in the same commit.
- [ ] 0.6 Record 0.2's pinned Codex marker, 0.3's concrete opencode part type and 0.5b's outcome in the PR description, and update `design.md`'s D4 table if any of them differs from what is written there. A client whose mechanism changes gets its capability amended in THIS change, not deferred.
- [ ] 0.7 Optional, and labelled as the one check nobody has run: load a throwaway extension with `pi -e` that subscribes to `tool_execution_end` and confirm delivery. This is not required to land — `design.md` D4a rejects those five events on evidence grade and ships the `message_end` route instead — but running it is what would license a later switch to the simpler source.

## 1. Server: schema, gate and notice (no client changes yet)

- [x] 1.1 Add `last_work_at`, `last_summary_at`, `last_nudge_at` to `apps/server/src/db/schema/agent-sessions.ts` as nullable `timestamp_ms`, and a migration under `apps/server/src/db/migrations/` using three plain `ALTER TABLE sessions ADD COLUMN` statements. No `CHECK`, no `NOT NULL`, no rebuild.
- [x] 1.2 Add a migration test alongside the existing `migrations-00NN.test.ts` files proving a POPULATED `sessions` table (curated summaries, a terminal row, a soft-deleted row) survives verbatim with all three columns NULL, and that `PRAGMA foreign_key_check` reports nothing.
- [x] 1.3 Add `NUDGE_FLOOR_MS = 25 * 60_000` as a single exported constant next to `TRANSPORT_STALENESS_MS` in `apps/server/src/services/agent-sessions.ts`. Assert in a test that it is the only floor constant in the server tree.
- [x] 1.4 Write `last_summary_at` at the SAME precedence site that writes `summary` — the one `sessions` names under **One site** — on exactly those writes that store a `final: true` summary. Prove by test that a `final: false` write and a precedence-discarded write both leave it untouched.
- [x] 1.5 Enforce monotonicity: no write may move any of the three backwards, and `resume` must leave all three alone. One test per clause.
- [x] 1.6 Create `apps/server/src/services/session-nudge.ts` — a pure function taking the row plus `now` and returning either `null` or the composed lines. No SQL, no clock of its own, no repository. Co-located test.
- [x] 1.7 Implement the notice composition per the `session-nudges` requirement: directive, explicit permission not to call, inventory with "current sizes, not targets" and a closing "N used of 10000 available". Interpolate `SUMMARY_SECTIONS` from `apps/server/src/mcp/summary-rubric.ts` for the no-stored-sections branch; do not restate the headings.
- [x] 1.8 Implement the 640-byte elision: stored order, heading names truncated at 32 characters, tail replaced with a count. Test at the boundary — a stored summary with forty 100-character headings must compose to ≤640 bytes AND still contain the `## Goal` entry.
- [x] 1.9 Add the repository read the inventory needs (section names and body sizes, plus the live title) under `apps/server/src/db/repositories/agent-sessions-repository.ts`, scoped, with no `admin*` prefix. Reuse the section parser `refine-session-summary-writes` added at `apps/server/src/services/summary-sections.ts` rather than writing a second one.
- [x] 1.10 Add the ping service method: stamp `last_activity_at` always, `last_work_at` when `usedTools`, `title` under `final:false` precedence when present, then evaluate the gate and stamp `last_nudge_at` only when it fires. All in one service call.

## 2. Server: the HTTP route

- [x] 2.1 Add `POST /:slug/sessions/:id/turn` to `apps/server/src/server/api-router.ts`, reusing `authMiddleware`, the project-slug resolution and `rejectIfDeleted` from the three sibling session routes. A strict zod schema with `usedTools` REQUIRED.
- [x] 2.2 Respond `{ ok, sessionId, lines: string[] }` with `lines: []` — never `null`, never an omitted key — when the gate does not fire.
- [x] 2.3 Hard-cut an over-long `title` rather than rejecting it, matching the `/summary` route's treatment; reject a missing `usedTools` with `invalid_input`.
- [x] 2.4 Prove a report against a terminal row succeeds, returns `lines: []`, and changes neither `status` nor `ended_at`.
- [x] 2.5 Prove the report keeps a live session out of the stale-active sweep, WITH the control: an otherwise-identical session that stops reporting is retired by the same pass.

## 3. Prove every new server guard is covered (mutation, not inspection)

Run each with `node scripts/mutate.mjs --file <path> --spec <test path> --mutation '<find>' --with '<replace>'`. A mutation that reddens NOTHING is the finding: write the missing test before moving on.

- [x] 3.1 Drop the `last_work_at IS NOT NULL` clause — the conversation-only test must go red.
- [x] 3.2 Drop the `last_work_at > last_summary_at` clause — the "summary written after the work suppresses the notice" test must go red.
- [x] 3.3 Drop the floor clause — the "not repeated inside the floor" test must go red.
- [x] 3.4 Make `COALESCE(last_nudge_at, started_at)` read `last_nudge_at` alone — the "first notice cannot fire before one floor" test must go red.
- [x] 3.5 Stamp `last_summary_at` on a `final: false` write too — the `final:false` test must go red.
- [x] 3.6 Stamp `last_work_at` unconditionally instead of on `usedTools` — the `usedTools:false` test must go red.
- [x] 3.7 Remove the 640-byte elision — the forty-heading boundary test must go red.
- [x] 3.8 Elide from the head of the stored order instead of the tail — the "`## Goal` survives elision" assertion must go red.
- [x] 3.9 Allow a timestamp to move backwards — the monotonicity test must go red.
- [x] 3.10 Make `resume` clear the three timestamps — the resume test must go red.

## 4. Shared core: report, cache, and the constants that go

- [x] 4.1 Delete `SAVE_NUDGE_EVERY`, `SUMMARY_NUDGE_EVERY`, `SAVE_NUDGE`, `SUMMARY_NUDGE` and `userTurnCounts` from `apps/plugin/bin/rembric-plugin-core.mjs`. `nudgesForTurn` keeps only the first-prompt, recall, sessionId and session-opening lines.
- [x] 4.2 Add the core's turn-report call and a per-session pending-lines cache. The cache is take-once (reading clears it) and an empty result never overwrites a non-empty cache. Declare both in `apps/plugin/bin/rembric-plugin-core.d.mts` so a client cannot pass an untyped observation.
- [x] 4.3 Do NOT touch the transcript accumulator, `flushSessionSummary`, `flushAllFireAndForget`, `scheduleIdleFlush`, `MAX_TRANSCRIPT_CHARS`, `MAX_ENTRY_CHARS`, `MAX_ENTRIES_PER_SESSION` or `deriveTitle` (design D11). Verify with `git diff` that none of them moved.
- [x] 4.4 Add the `sessionOpening` key to `apps/plugin/test/nudge-fixtures.json` (prefixed and `…Core`), and REMOVE `save`, `saveCore`, `summary`, `summaryCore` and `endOfTurnRubric`.
- [x] 4.5 Update `apps/plugin/test/nudge-fixtures.test.ts`: the removed keys are asserted absent, `sessionOpening` is asserted byte-identical across bash / shared JS-TS / Python, and the JS/TS arm still reads the shared module rather than a client file.

## 5. Shell clients

- [x] 5.1 Delete `apps/plugin/scripts/stop-sync.sh` and `apps/plugin/scripts/stop-nudge.sh`, and their tests `apps/plugin/test/stop-sync.test.ts` and `apps/plugin/test/stop-nudge.test.ts`.
- [x] 5.2 Add `apps/plugin/scripts/stop-report.sh <agent>`: read `stop_hook_active` FIRST and exit on `true`; scan the transcript delta from the stored offset for the per-host marker pinned in 0.1/0.2; POST `/turn`; cache the returned lines; store the new offset; emit nothing on Claude Code and `{}` on Codex.
- [x] 5.3 Add to `apps/plugin/scripts/_api.sh`: `rembric_turn_report`, `rembric_pending_write`, `rembric_pending_take`, `rembric_scan_offset`, `rembric_scan_offset_set`. Delete `rembric_turn_count_peek`. Keep `rembric_turn_count` — `prompt-search.sh` is still its caller.
- [x] 5.4 Rewrite `apps/plugin/scripts/prompt-nudge.sh`: no counter, no modulo. Take the pending lines, emit the sessionId line when any write-directing line follows, emit the session opening on a newly created session, print the server lines verbatim, and record the first user prompt (redacted, ≤100 chars) for `stop-report.sh`'s first report.
- [x] 5.5 Move the fact-extraction call into `apps/plugin/scripts/session-end.sh`, preferring facts over the raw transcript format and falling through on empty — the same three lines `stop-sync.sh` carried. Confirm by test that Codex still falls through (no `_rembric_facts_raw_codex_cli` exists) and that Claude Code's SessionEnd body now names files and failed commands.
- [x] 5.6 Update `apps/plugin/hooks/hooks.json` and `hooks.codex.json`: one `Stop` entry each, invoking `stop-report.sh` with the agent argument, no `async`. Eight handler entries per manifest.
- [x] 5.7 Update `apps/plugin/test/hook-manifests.test.ts` to the new exact sets and exact count of 8, with no containment checks.
- [x] 5.8 Update `apps/plugin/test/prompt-nudge.test.ts` and `apps/plugin/test/resumed-read.test.ts` for the counter-free script.
- [x] 5.9 Add a `stop-report.sh` test covering: the loop guard fires before any transcript read (assert the ORDER, not just the outcome); a `404` caches nothing and clears nothing; an unreachable server prints one stderr line and exits `0`; the cold-offset path scans at most 256 KB.
- [x] 5.10 `git grep -n 'NUDGE_EVERY\|_HINT_EVERY\|rembric-turnnudge\|stop-sync\|stop-nudge'` over `apps/plugin/` returns nothing.

## 6. In-process clients

- [x] 6.1 **opencode**: report on `session.idle` (outside the debounce), set the tool flag in `message.part.updated` before its non-`text` early return, print cached lines as `nudgePart` entries in `chat.message`, and evict the flag and cache in `session.deleted`.
- [x] 6.2 **Pi**: report on `agent_settled`; print in `before_agent_start` through `underscoreToolNames` and nothing else; clear the cache on `session_shutdown`.
- [x] 6.2a **Pi's flag, accumulated — the item most likely to be got wrong.** Reset it in `before_agent_start` (`index.ts:360`), set it in `message_end` (`:385`) when `role === 'toolResult'` OR `role === 'assistant'` and any content part has `type === 'toolCall'`, read and clear it in `agent_settled` (`:393`). Set it BEFORE the handler's `role !== 'assistant'` early return (`:385-391`) and before `assistantText` (`:244-253`), and change neither: `assistantText` keeps filtering to `type === 'text'` because it feeds the transcript accumulator. Do NOT read the settled message — it carries no `toolCall` part — and do NOT use `turn_end.toolResults`, which is empty on that turn.
- [x] 6.3 **Hermes**: report from `sync_turn`'s background thread alongside the existing transcript POST; delete `_SAVE_HINT_EVERY`, `_SUMMARY_HINT_EVERY`, `_SAVE_HINT`, `_SUMMARY_HINT`; inject the cached lines from `prefetch()` wrapped in `<memory-hint>`; reset the cache in `_reset_turn_state`.
- [x] 6.3a **Hermes's two-condition observation, plus the interrupted-turn deviation.** Do not add a client-side substitute for the turns the host skips (`run_agent.py:4345-4346` returns before the memory fan-out on an interrupted turn, so `sync_turn` is never called): report nothing for them and let `hermes-agent-plugin`'s published scenario carry it. Set the flag when a message's `role` is outside `{user, assistant, system}` OR an `assistant` message carries a non-empty `tool_calls`. A role-only test misses a call that produced no result message. When the kwarg is absent (Hermes < 2026.5.29, the fallback at `__init__.py:552-557`), report `true` — that synthesised list admits neither condition by construction, so a `false` there would be a silent false negative rather than an observation.
- [x] 6.4 Confirm `prefetch()` still makes no network call, and that `sync_turn`'s existing lock-and-join discipline is unchanged by the second request.
- [x] 6.5 Add one test per client asserting the printed text is BYTE-IDENTICAL to the response's `lines` (modulo Pi's `underscoreToolNames` and Hermes's `<memory-hint>` wrapper). A test asserting only "a notice appeared" does not discharge this.
- [x] 6.6 Prove the two client-side observation rules with their CONTROLS, since both fail in the direction a naive test still passes. **Pi**: drive the real three-event `message_end` sequence (assistant `stopReason: "toolUse"` with a `toolCall` part → `toolResult` → assistant `stopReason: "stop"`, text only) and assert `usedTools: true`; the control asserts that inspecting ONLY the final event yields `false`. Add the per-turn reset case: a tool turn followed by a chat turn reports `false` on the second. **Hermes**: assert `true` for an `assistant` message with `tool_calls` and NO `role: "tool"` message present, with the control showing a role-only test returns `false` on that same input.
- [x] 6.7 Mutation, on the two rules 6.6 covers. Pi: move the flag read from the accumulator to the settled message — the accumulation test must go red. Pi: drop the `before_agent_start` reset — the per-turn reset test must go red. Hermes: drop the `tool_calls` half of the condition — the call-without-result test must go red. Hermes: make the absent-kwarg branch report `false` — the fallback test must go red.

## 7. The two published rationales this change owns, plus the surfaces they describe

- [x] 7.1 Correct `plugin-session-protocol`'s post-compaction rationale — "so sending the window alone stores the window alone" — to the merge form, in the delta spec (done) and in the `postCompact`/`postCompactCore` fixture text.
- [x] 7.2 Correct `opencode-plugin`'s handler rationale at the two places that argue from `this REPLACES the stored value`, in the delta spec (done) and in the fixture the handler pushes.
- [x] 7.3 Re-measure `postCompact` and `postCompactCore` in UTF-8 bytes after the reword and record both. Baseline before the reword: 675 prefixed, 666 unprefixed, against a ≤700 published cap (`plugin-session-protocol`) and a ≤600 one for the unprefixed value (`opencode-plugin`). If the reword breaks either, cut prose — do not raise a cap.
- [x] 7.4 Correct `apps/plugin/commands/summary.md`'s "This REPLACES the stored summary" to the merge form, keeping the `10000` substring and the six canonical headings. No spec delta is needed; record in the PR that no published requirement obliged that sentence.
- [x] 7.5 Run `pnpm vitest run apps/server/src/test/invariants.test.ts` and reconcile `"the session-summary rubric has one source"`: `prompt-nudge.sh` and `stop-nudge.sh` leave the enumeration, the new server nudge module joins it via `${SUMMARY_SECTIONS}` interpolation, and the completeness `git grep` must agree — stage the plugin files first, or it will not see them.

## 8. Measurements this change must produce

Each is a number recorded in the PR description, on a named instrument. Do not mix instruments within a row.

- [x] 8.1 The emitted notice's UTF-8 byte length, for a representative six-section session and for the forty-heading boundary case. Both ≤640.
- [x] 8.2 The turn-1 total emitted bytes, with and without a recall keyword. Target ≤800 (baseline on `origin/main`: 797 with recall).
- [x] 8.3 The worst-case firing turn: first-prompt line + recall + sessionId + notice. Target ≤1088 (baseline on `origin/main` for the equivalent divergence case: 917).
- [x] 8.4 The ten-turn amortised total on a working session, at one elapsed floor and at two. Target ≤240 bytes/turn (baseline: 123 bytes/turn on `UserPromptSubmit` alone, 227 across both channels).
- [x] 8.5 The twenty-turn total on a conversation with NO tool use. Baseline measured on `origin/main`: 1880 bytes over five firing turns. Target: the turn-1 lines and nothing else.
- [x] 8.6 `stop-report.sh` wall-clock per invocation, against the same 8 MB-class transcript the deleted `stop-nudge.sh` was measured on (790 ms with a full parse, 5 ms with the guard). State whether the number is a delta scan or a cold scan; do not present one as the other.
- [ ] 8.7 The number of notices a real three-hour Docker-smoke session receives, against the count of turns in it. This is the number that says whether `NUDGE_FLOOR_MS = 25 * 60_000` is right; record it even if it is inconvenient.

## 9. Verification

- [x] 9.1 `pnpm run typecheck`
- [x] 9.2 `pnpm run lint`
- [x] 9.3 `pnpm test`
- [x] 9.4 Run the Python arm explicitly (`apps/plugin/.hermes-plugin/tests/`). A TypeScript-only run will not catch a drifted Python provider.
- [x] 9.5 `pnpm run eval` is NOT required — retrieval is untouched. Record that decision rather than skipping it silently.
- [x] 9.6 Real Docker smoke against pre-existing seeded data (`pnpm run dev:docker:up`; `chown -R 10001:10001 data-dev` first if it fails with `SQLITE_CANTOPEN`). Over HTTP and MCP, against a SEEDED session that already has a curated summary: (a) report a conversation-only turn and confirm `lines: []` and no timestamp movement beyond `last_activity_at`; (b) report a tool turn before the floor and confirm `lines: []`; (c) advance the clock past the floor, report a tool turn, and confirm the notice arrives with the seeded session's real section sizes; (d) write a partial summary via `memory.session_summary` and confirm the next work-report is silent until the floor elapses again; (e) confirm the dashboard session detail still renders.
- [x] 9.7 On the same stack, drive at least TWO real clients end-to-end per the `rembric-plugin-development` skill's e2e walkthrough, and confirm the notice text is byte-identical between them.
- [x] 9.8 Confirm on the same stack that no `memory`, `memory_fts`, `memory_vec` or entity-table row is written by any report — append-only memory is not in play here, and this proves it.
- [x] 9.9 Mixed-version check: run a NEW client against the pre-change server image and confirm the `404` path degrades to local lines only with one stderr diagnostic; run an OLD client against the new server and confirm it keeps its own counter nudges and the server fires nothing.

## 10. Deferred and rejected, recorded so they are not lost

- [x] 10.1 Record that the transcript accumulator and the terminal flushes were deliberately NOT removed (design D11), naming the two convergence requirements that rest on them, and that retiring them needs its own change identifying each host's replacement transcript source.
- [x] 10.2 Record the accepted regression: a Claude Code or Codex session hard-killed between two terminal events now stores no summary in Rembric, where it previously stored the previous turn's transcript.
- [x] 10.3 Record the two accepted defects: no nudges with the server down (verified — neither nudge script contains `rembric_post` or `curl` today), and the server's inability to know what is memorable, which degrades the save clause to elapsed time.
- [x] 10.4 Record the rejected `PostToolUse` marker-file design and why (three published requirements enumerate the hook catalog as six event types with no such entry; a process spawn per tool call).
- [x] 10.4a Record the rejected Pi `tool_execution_*` route and the reason, which is evidence grade rather than capability: all five tool events are on the public extension API, `pi.on` whitelists nothing and dispatch is a plain lookup on the same runner that delivers `message_end`, but delivery of those five to a handler was never observed — no throwaway extension was loaded with `pi -e`. Record that running that one check is what would license a later switch to the simpler source, and that the accumulation rule survives it.
- [x] 10.5 Record the three open questions from `design.md` with their defaults taken: the floor's value, the save clause's presence inside the byte bound, and whether `memory.session_summary` should stamp `last_work_at` (default: no).
- [x] 10.6 Record the pre-existing spec defect this change repairs in passing: `claude-code-plugin`'s nudge requirement carried a scenario asserting the summary nudge "SHALL emit it again on turn 10", which contradicted its own prose and the shipped `prompt-nudge.sh:48`.
- [ ] 10.7 Conventional Commits throughout; hooks never bypassed.
