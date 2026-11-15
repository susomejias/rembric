## 1. Live probes (gate client work; each records its observed payload in design.md before the matching client task starts)

- [ ] 1.1 **Operator-assisted.** Claude Code ≥ 2.1.271 in auto mode: register a temporary hook that dumps stdin for `SubagentStop` and for `PreToolUse` matched on `SubagentHandback`, then delegate one foreground, one background and one forked subagent. Record whether each event fires, whether `session_id` equals the parent session's id in both events, and what `last_assistant_message` holds when a hand-back happened. Repeat once outside auto mode. If any `session_id` is the subagent's, amend design Decision 7 before task 4.
- [ ] 1.2 **Operator-assisted.** Codex ≥ `rust-v0.133.0`: dump `SubagentStop` stdin for one spawned subagent and confirm `session_id` is the parent's. On one Codex release older than 0.133.0, confirm a `hooks.codex.json` declaring `SubagentStop` still loads (unknown event ignored, not rejected).
- [ ] 1.3 opencode: on 2.3.x, log the raw `session.inbox.enqueued` event the plugin's `ctx.event.subscribe` stream yields for one subagent (field path of `item`, `sessionID`, `metadata`), and capture the exact trailing "background work still running" block format from a child that leaves work running. On 1.x, log `tool.execute.after` for `task` (input fields, `output.output`).
- [ ] 1.4 Pi: with gentle-pi and with pi-subagents installed, log `tool_execution_end` for each recognised tool and `message_end` for `gentle-agents.message` / `subagent-notify` (where `customType` and the text live). Read the Pi example extension's `truncateModelOutput` and record which end it keeps.
- [ ] 1.5 Hermes ≥ v2026.8.3: confirm a callback registered through the provider plugin's `register(ctx)` → `ctx.register_hook("subagent_stop", …)` is invoked once per child with `parent_session_id`, `child_session_id`, `child_role`, `child_summary`, and record which thread it runs on.

## 2. Shared core capture function (`mcp-api`)

- [ ] 2.1 RED: in `packages/core`, tests for `captureKeyLearnings` that pin: items extracted exactly as `parseKeyLearnings` does today (move its existing tests from `packages/mcp/src/observability-tools.test.ts`); same-session exact duplicate skipped and counted; per-session (another session saves again); no session → no skip; `reason` when every item is skipped; two concurrent captures of one text insert once. Observe them fail.
- [ ] 2.2 Move `parseKeyLearnings` to `packages/core/src/services/capture-learnings.ts`. Add the scoped repository read (requires `Scope`, served by `memory_session_idx`) in `packages/db/src/repositories/memory-repository.ts`. Implement `captureKeyLearnings` with the duplicate check and insert in one transaction. Export it from `packages/core/src/index.ts`. 2.1 goes GREEN.
- [ ] 2.3 `handleCapturePassive` delegates to `captureKeyLearnings` and adds `skipped` to `capturePassiveOutput`. Run the mcp-api scenarios ("Capturing the same text twice…", "The skip is per session") through the MCP transport, not the handler, so the zod schema is exercised. The existing `memory.capture_passive` tests and `apps/web/src/test/secret-redaction-sweep.test.ts` stay green.
- [ ] 2.4 Move the candidate (`perSaveMax`) and `embedNow` wiring out of `apps/web/src/lib/mcp-server.ts` into one factory used by both the MCP server and the route. `apps/web/src/test/invariants.test.ts` stays green (data-access confinement, server-context single instance, tool-handler module layout).
- [ ] 2.5 Mutation check with `scripts/mutate.mjs`: weaken the duplicate condition (drop the session filter; drop the active-status filter; move the check outside the transaction) one at a time. Each mutation must turn a named 2.1 test red. Record the runs in this file.

## 3. HTTP route (`http-api`)

- [ ] 3.1 RED: tests for `parseSessionLearnings` in `apps/web/src/lib/validation.ts` covering `report` missing, empty, non-string; `agentType` empty, over 120 characters, non-string; and unknown properties ignored.
- [ ] 3.2 RED → GREEN: `apps/web/src/app/api/[slug]/sessions/[id]/learnings/route.ts` following the sibling session-route sequence, with every other method answering `methodFallback`. Add tests in `apps/web/src/test/api-router.test.ts` for each `http-api` scenario: saved into the parent with tags, `source.agent = 'subagent'` and embeddings present; no-op; second post skipped; 120,000-character report; another token `404`; read-only `403`; invalid `400`; `agentType` normalizing to nothing.
- [ ] 3.3 Mutation check: remove the trailing-50,000 slice; remove the server-assigned `subagent-learning` tag; skip `rejectIfDeleted`. Each mutation must turn a 3.2 test red.
- [ ] 3.4 Add the route to `apps/web/src/app/api/README.md`'s route table.

## 4. Claude Code + Codex (`claude-code-plugin`, `codex-distribution`)

- [ ] 4.1 RED: `apps/plugin/test/` tests that run `subagent-report.sh` against a stub server, covering each `claude-code-plugin` subagent-report scenario: hand-back forwarded; `SubagentStop` forwarded; empty `agent_type` ignored; no phrase, no request; private span stripped; failure gives one stderr line and exit `0`. Add the Codex variants: stdout is exactly `{}` on forward, skip and failure. Build the stdin fixtures from the task 1.1 and 1.2 payloads.
- [ ] 4.2 Add `rembric_subagent_report` to `apps/plugin/scripts/_api.sh`. It reuses the existing JSON field readers, `rembric_json_escape`, the private-span helper and the POST budget override. Add `apps/plugin/scripts/subagent-report.sh <agent>`. 4.1 goes GREEN. `sh -n` is clean, and the jq and awk fallback paths give the same body.
- [ ] 4.3 Manifests: in `hooks.json`, add a `PreToolUse` group with matcher `SubagentHandback` and a matcher-less `SubagentStop` group, both `async: true`. In `hooks.codex.json`, add a matcher-less `SubagentStop` with `timeout: 3`. Update `apps/plugin/test/hook-manifests.test.ts`: Claude 8 events / 12 handlers, Codex 8 / 11, the exact invocation lists, and no `PostToolUse` in either.
- [ ] 4.4 **Operator e2e** (`rembric-plugin-development` e2e walkthrough) against a local dev server: one Claude Code auto-mode delegation and one Codex delegation whose report ends in `## Key Learnings`. Confirm the memories land on the parent session with `source.agent = subagent`, and that the second (duplicate) signal is skipped.

## 5. Shared JS core + opencode + Pi (`plugin-session-protocol`, `opencode-plugin`, `pi-plugin`)

- [ ] 5.1 RED → GREEN: `postSubagentReport(parentSessionId, report, agentType)` in `apps/plugin/bin/rembric-plugin-core.mjs`, with the pre-filter, `stripPrivateTags`, the 2-second POST and one `diag` line on failure, exported from the protocol object. Unit tests for the pre-filter, redaction and failure. The invariant "JS/TS plugin clients share one helper implementation" stays green.
- [ ] 5.2 opencode: in the 2.x export, an inbox-event handler: unwrap `<subagent>`, strip the trailing block recorded in 1.3, skip subagent-marked parents. In the 1.x export, `tool.execute.after` for `task`, reading `<task_result>`. Write a test per `opencode-plugin` scenario. Add a test asserting the observed tool output is unchanged.
- [ ] 5.3 Pi: the recognised-surface table, plus `tool_execution_end` and `message_end` handlers, with the child guard. Write a test per `pi-plugin` scenario. Add a test that an unrecognised tool makes no request.

## 6. Hermes (`hermes-agent-plugin`)

- [ ] 6.1 RED → GREEN: `subagent_stop` registration in `register(ctx)`. The callback dispatches through the same thread-spawn path as `sync_turn`, with the captured binding. Add pytest cases per `hermes-agent-plugin` scenario: forwarded from a worker; returns before the request completes; empty summary ignored; unreachable server returns normally with one safe diagnostic.

## 7. Docs and closure

- [ ] 7.1 Add one line each to `docs/agents.md` and each client README (`apps/plugin/.claude-plugin/`, `.codex-plugin/`, `.opencode-plugin/`, `.pi-plugin/`, `.hermes-plugin/`) on automatic capture of subagent `## Key Learnings`. Name the minimum host versions: Claude Code 2.1.271 for auto-mode hand-back (`SubagentStop` before that), Codex `rust-v0.133.0`, opencode 2.x or 1.x `task`, Hermes v2026.8.3, and the recognised Pi packages.
- [ ] 7.2 Update the `memory.capture_passive` tool description in `packages/mcp/src/server.ts` to mention `skipped`. Keep the description lock-step test green.
- [ ] 7.3 `openspec validate capture-subagent-learnings --strict`, `pnpm run typecheck`, `pnpm run lint` and `pnpm test` all clean. Record the outputs here.
- [ ] 7.4 **Operator e2e** for opencode, Pi and Hermes against a local dev server, one delegation each. Same checks as 4.4.
