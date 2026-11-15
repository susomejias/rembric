## 1. Host probes

The client work was built from the documented payloads and from upstream source. 1.3–1.5 were verified against source; 1.1 and 1.2 stay operator gates before merge, and a payload they contradict reopens the matching group 4 task.

- [ ] 1.1 **Operator-assisted.** Claude Code ≥ 2.1.271 in auto mode: register a temporary hook that dumps stdin for `SubagentStop` and for `PreToolUse` matched on `SubagentHandback`, then delegate one foreground, one background and one forked subagent. Record whether each event fires, whether `session_id` equals the parent session's id in both events, and what `last_assistant_message` holds when a hand-back happened. Repeat once outside auto mode. If any `session_id` is the subagent's, amend design Decision 7 before task 4.
- [ ] 1.2 **Operator-assisted.** Codex ≥ `rust-v0.133.0`: dump `SubagentStop` stdin for one spawned subagent and confirm `session_id` is the parent's. On one Codex release older than 0.133.0, confirm a `hooks.codex.json` declaring `SubagentStop` still loads (unknown event ignored, not rejected).
- [x] 1.3 opencode: on 2.3.x, log the raw `session.inbox.enqueued` event the plugin's `ctx.event.subscribe` stream yields for one subagent (field path of `item`, `sessionID`, `metadata`), and capture the exact trailing "background work still running" block format from a child that leaves work running.
  - Source-verified on opencode 2.3.0: the payload is under `data`; the type literal is `session.inbox.enqueued`; the still-running block is `\n\nBackground work still running:\n` (`subagent-completion.ts:37-53`). Live logging is folded into 7.4.
- [x] 1.4 Pi: with gentle-pi and with pi-subagents installed, log `tool_execution_end` for each recognised tool and `message_end` for `gentle-agents.message` / `subagent-notify` (where `customType` and the text live). Read the Pi example extension's `truncateModelOutput` and record which end it keeps.
  - Source-verified on earendil-works/pi: a custom message's `customType` and `content` are top-level on `message` (`src/core/messages.ts:46-53`). The example's `truncateModelOutput` keeps the head (`truncateHead`, `examples/extensions/subagent/index.ts:234-245`); recorded as a design risk. Live logging is folded into 7.4.
- [x] 1.5 Hermes ≥ v2026.8.3: confirm a callback registered through the provider plugin's `register(ctx)` → `ctx.register_hook("subagent_stop", …)` is invoked once per child with `parent_session_id`, `child_session_id`, `child_role`, `child_summary`, and record which thread it runs on.
  - Source-verified on hermes-agent main: `register_hook` → `_register_fallback_hook` (`plugins_ledger.py:223-234`) → `_hooks` (`plugins_dispatch.py:566-573`), and `invoke_hook` reads it (`:275-293`). `subagent_stop` is the one caller-thread hook (`plugins_dispatch.py:62`) and runs under `_parent_finalization_lock` (`delegate_tool_results.py:414,428`), which is why the POST is on a worker.

## 2. Shared core capture function (`mcp-api`)

- [x] 2.1 RED: in `packages/core`, tests for `captureKeyLearnings` that pin: items extracted exactly as `parseKeyLearnings` does today (move its existing tests from `packages/mcp/src/observability-tools.test.ts`); same-session exact duplicate skipped and counted; per-session (another session saves again); no session → no skip; `reason` when every item is skipped; two concurrent captures of one text insert once. Observe them fail.
  - 23 tests RED (functions missing) → GREEN 23/23; the repository read 2/2.
- [x] 2.2 Move `parseKeyLearnings` to `packages/core/src/services/capture-learnings.ts`. Add the scoped repository read (requires `Scope`, served by `memory_session_idx`) in `packages/db/src/repositories/memory-repository.ts`. Implement `captureKeyLearnings` with the duplicate check and insert in one transaction. Export it from `packages/core/src/index.ts`. 2.1 goes GREEN.
  - `MemoryRepository.hasActiveWithContentInSession` uses `INDEXED BY memory_session_idx` (without the hint SQLite chose `memory_scope_project_status_created_idx`). `MemoryService.saveUnlessSessionDuplicate` runs the lookup and the insert in one transaction.
- [x] 2.3 `handleCapturePassive` delegates to `captureKeyLearnings` and adds `skipped` to `capturePassiveOutput`. Run the mcp-api scenarios ("Capturing the same text twice…", "The skip is per session") through the MCP transport, not the handler, so the zod schema is exercised. The existing `memory.capture_passive` tests and `apps/web/src/test/secret-redaction-sweep.test.ts` stay green.
  - Three MCP-transport tests RED → GREEN; `mcp-transport.test.ts` 122/122; `secret-redaction-sweep` green. `apps/web/src/test/mcp-tool-surface.test.ts` gains the `memory.capture_passive` description and `skipped` exceptions.
- [x] 2.4 Move the candidate (`perSaveMax`) and `embedNow` wiring out of `apps/web/src/lib/mcp-server.ts` into one factory used by both the MCP server and the route. `apps/web/src/test/invariants.test.ts` stays green (data-access confinement, server-context single instance, tool-handler module layout).
  - `Services.postSave` holds the candidates and `embedNow` wiring used by both surfaces. `CANDIDATES_PER_SAVE_MAX` is now read once when the services are built.
- [x] 2.5 Mutation check with `scripts/mutate.mjs`: weaken the duplicate condition (drop the session filter; drop the active-status filter; move the check outside the transaction) one at a time. Each mutation must turn a named 2.1 test red. Record the runs in this file.
  - Every mutation was caught. Session filter dropped → "skips per session…". `status = 'active'` dropped → "saves again once the earlier capture is no longer active". Lookup moved before the transaction → "runs the duplicate lookup inside the transaction that inserts the item" (only this white-box test catches it: better-sqlite3 is synchronous, so the `Promise.all` test cannot). Guard removed → 5 tests. Index hint removed → "is served by memory_session_idx".

## 3. HTTP route (`http-api`)

- [x] 3.1 RED: tests for `parseSessionLearnings` in `apps/web/src/lib/validation.ts` covering `report` missing, empty, non-string; `agentType` empty, over 120 characters, non-string; and unknown properties ignored.
  - RED (`parseSessionLearnings is not a function`) → GREEN 8/8 in `apps/web/src/lib/validation.test.ts`.
- [x] 3.2 RED → GREEN: `apps/web/src/app/api/[slug]/sessions/[id]/learnings/route.ts` following the sibling session-route sequence, with every other method answering `methodFallback`. Add tests in `apps/web/src/test/api-router.test.ts` for each `http-api` scenario: saved into the parent with tags, `source.agent = 'subagent'` and embeddings present; no-op; second post skipped; 120,000-character report; another token `404`; read-only `403`; invalid `400`; `agentType` normalizing to nothing.
  - The tests live in `apps/web/src/test/session-learnings.test.ts` (15/15) rather than `api-router.test.ts`, because the route embeds inline and needs the `FakeEmbedder` mock.
- [x] 3.3 Mutation check: remove the trailing-50,000 slice; remove the server-assigned `subagent-learning` tag; skip `rejectIfDeleted`. Each mutation must turn a 3.2 test red.
  - Trailing slice removed → "parses only the trailing 50,000 code points". Tag removed → two tests. `rejectIfDeleted` return skipped → the 404 and 409 tests.
- [x] 3.4 Add the route to `apps/web/src/app/api/README.md`'s route table.

## 4. Claude Code + Codex (`claude-code-plugin`, `codex-distribution`)

- [x] 4.1 RED: `apps/plugin/test/` tests that run `subagent-report.sh` against a stub server, covering each `claude-code-plugin` subagent-report scenario: hand-back forwarded; `SubagentStop` forwarded; empty `agent_type` ignored; no phrase, no request; private span stripped; failure gives one stderr line and exit `0`. Add the Codex variants: stdout is exactly `{}` on forward, skip and failure. Build the stdin fixtures from the task 1.1 and 1.2 payloads.
  - 27 script tests plus manifest tests. RED: 23 failed before the script existed and 10 manifest tests failed before the edits; GREEN 59/59. The fixtures come from the documented payloads (1.1/1.2 still pending).
- [x] 4.2 Add `rembric_subagent_report` to `apps/plugin/scripts/_api.sh`. It reuses the existing JSON field readers, `rembric_json_escape`, the private-span helper and the POST budget override. Add `apps/plugin/scripts/subagent-report.sh <agent>`. 4.1 goes GREEN. `sh -n` is clean, and the jq and awk fallback paths give the same body.
  - `bash -n` clean on both scripts. `sh -n _api.sh` already fails on the pre-existing process substitution in `rembric_command_paths`. jq and awk paths send identical bodies (3 cases plus a control). The 2-second cap lives in the helper (`REMBRIC_POST_MAX_TIME` default 2).
- [x] 4.3 Manifests: in `hooks.json`, add a `PreToolUse` group with matcher `SubagentHandback` and a matcher-less `SubagentStop` group, both `async: true`. In `hooks.codex.json`, add a matcher-less `SubagentStop` with `timeout: 3`. Update `apps/plugin/test/hook-manifests.test.ts`: Claude 8 events / 12 handlers, Codex 8 / 11, the exact invocation lists, and no `PostToolUse` in either.
- [ ] 4.4 **Operator e2e** (`rembric-plugin-development` e2e walkthrough) against a local dev server: one Claude Code auto-mode delegation and one Codex delegation whose report ends in `## Key Learnings`. Confirm the memories land on the parent session with `source.agent = subagent`, and that the second (duplicate) signal is skipped.

## 5. Shared JS core + opencode + Pi (`plugin-session-protocol`, `opencode-plugin`, `pi-plugin`)

- [x] 5.1 RED → GREEN: `postSubagentReport(parentSessionId, report, agentType)` in `apps/plugin/bin/rembric-plugin-core.mjs`, with the pre-filter, `stripPrivateTags`, the 2-second POST and one `diag` line on failure, exported from the protocol object. Unit tests for the pre-filter, redaction and failure. The invariant "JS/TS plugin clients share one helper implementation" stays green.
  - 12 RED → 12/12 GREEN; 7 of 7 mutations caught.
- [x] 5.2 opencode: in the 2.x export, an inbox-event handler: unwrap `<subagent>`, strip the trailing block recorded in 1.3, skip subagent-marked parents. The 1.x export stays unchanged. Write a test per `opencode-plugin` scenario. Add a test asserting the observed event is unchanged.
  - 2.x only. The 1.x export stays unchanged: the published `opencode-plugin` spec keeps v1 free of tool hooks, and file-anchored recall used the same v2-only scope. 8 of 8 mutations caught.
- [x] 5.3 Pi: the recognised-surface table, plus `tool_execution_end` and `message_end` handlers, with the child guard. Write a test per `pi-plugin` scenario. Add a test that an unrecognised tool makes no request.
  - 12 RED → 13/13 GREEN; 5 of 5 mutations caught, plus the `void`→`await` mutation checked by hand.

## 6. Hermes (`hermes-agent-plugin`)

- [x] 6.1 RED → GREEN: `subagent_stop` registration in `register(ctx)`. The callback dispatches through the same thread-spawn path as `sync_turn`, with the captured binding. Add pytest cases per `hermes-agent-plugin` scenario: forwarded from a worker; returns before the request completes; empty summary ignored; unreachable server returns normally with one safe diagnostic.
  - Tests are `unittest`, not pytest: 9 RED (AttributeError) → GREEN; 12 of 12 mutations caught. Shares `_start_worker` with `sync_turn`. `test_file_recall` registration list updated; Hermes suite 149/149.

## 7. Docs and closure

- [x] 7.1 Add one line each to `docs/agents.md` and each client README (`apps/plugin/.claude-plugin/`, `.codex-plugin/`, `.opencode-plugin/`, `.pi-plugin/`, `.hermes-plugin/`) on automatic capture of subagent `## Key Learnings`. Name the minimum host versions: Claude Code 2.1.271 for auto-mode hand-back (`SubagentStop` before that), Codex `rust-v0.133.0`, opencode 2.x, Hermes v2026.8.3, and the recognised Pi packages.
  - `docs/agents.md` "Learnings from subagent reports"; `apps/plugin/README.md` (Claude Code and Codex); opencode, Pi and Hermes READMEs.
- [x] 7.2 Update the `memory.capture_passive` tool description in `packages/mcp/src/server.ts` to mention `skipped`. Keep the description lock-step test green.
- [x] 7.3 `openspec validate capture-subagent-learnings --strict`, `pnpm run typecheck`, `pnpm run lint` and `pnpm test` all clean. Record the outputs here.
  - All exit 0: typecheck, lint, format:check, check:delta-freshness, check:delta-sections, check:spec-crossrefs. `pnpm test`: db 355, mcp 417, core 1546, web 1873 passed; Hermes `unittest` 149 OK.
- [ ] 7.4 **Operator e2e** for opencode, Pi and Hermes against a local dev server, one delegation each. Same checks as 4.4.
