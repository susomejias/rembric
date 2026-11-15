## Why

A delegated subagent's final report goes back to the parent agent, and any `## Key Learnings` items in it are saved only if the parent remembers to call `memory.capture_passive` with that text (issue #490). In practice the report is consumed and its learnings are lost when the session ends — the same "depends on the agent remembering" failure mode issue #439 recorded for `memory.save`. Every one of the five hosts now exposes the finished report to a plugin through some event, so the plugin can forward it without the agent's cooperation:

- **Claude Code** — `SubagentStop` carries `last_assistant_message` ("the text content of the subagent's final response"), and since v2.1.271 in auto mode the report is delivered through the `SubagentHandback` tool instead: "The `last_assistant_message` field then holds the subagent's closing text, if any, which is not the delivered report. The report is that call's `message` input, which a `PreToolUse` or `PostToolUse` hook matched on `SubagentHandback` receives as `tool_input.message`." (`code.claude.com/docs/en/hooks#subagentstop`).
- **Codex CLI** — `SubagentStop` (PR #22873, first stable in `rust-v0.133.0`) carries `last_assistant_message`, and "Subagent hooks use the parent session id." (`learn.chatgpt.com/docs/hooks`).
- **opencode** — 2.x delivers the report to the parent as a `session.inbox.enqueued` synthetic item with `metadata.source: "subagent"`. The legacy 1.x export stays unchanged: the published spec keeps v1 free of tool hooks, as for file-anchored recall.
- **Hermes Agent** — the general plugin hook `subagent_stop` passes `parent_session_id`, `child_session_id` and `child_summary` ("The final response the child returned to the parent"), since v2026.4.23.
- **Pi** — core has no subagent concept; the subagent extensions return the report as the result of their own tool (`subagent`, `subagent_run`, `subagent_continue`, `subagent_result`) or as a custom message (`subagent-notify`, `gentle-agents.message`), observable on `tool_execution_end` / `message_end`.

## What Changes

- **New HTTP route `POST /api/<slug>/sessions/:id/learnings`** (`http-api`). Body `{ report, agentType? }`. It runs the same `## Key Learnings` extraction and the same curation pipeline as `memory.capture_passive`, attributing every saved item to session `:id` (the parent session). No section is a `200` no-op with `saved: 0` and a `reason`. Tags are server-assigned (`subagent-learning`, plus the normalized `agentType` when supplied), because a hook cannot choose meaningful tags. Only the trailing 50,000 code points of `report` are parsed, so the learnings block — which closes a report — survives an over-long report.
- **One shared core capture function** (`mcp-api`). The extraction + save loop moves out of the MCP handler into `packages/core`, used by both the route and `memory.capture_passive`, so the two surfaces cannot drift. It also answers the issue's double-capture question: an extracted item whose redacted content equals an active memory already attached to the same session in the same scope is skipped and counted in a new `skipped` field. That makes every client's forwarding idempotent (Claude Code's two paths, opencode's at-least-once inbox delivery, opencode 2.3's one report per idle cycle) and makes a parent that also calls `memory.capture_passive` harmless.
- **Every client forwards finished subagent reports** (`plugin-session-protocol`, plus each client's own spec):
  - Claude Code: a `SubagentStop` entry and a second `PreToolUse` group matched on `SubagentHandback`, both `async`, both running one new script `subagent-report.sh`. **No `PostToolUse` entry** — the manifest test's prohibition stands.
  - Codex: one `SubagentStop` entry running the same script, printing `{}` as the host requires.
  - opencode 2.x: subscribes to `session.inbox.enqueued`.
  - Pi: `tool_execution_end` on the known subagent tool names and `message_end` on the known completion message types, attributed to the extension's own session.
  - Hermes: `subagent_stop` registered through the existing `register(ctx)` hook registration, using its explicit `parent_session_id`.
- **Post-tool observation is revisited explicitly, and narrowly** (`plugin-session-protocol`). #235 removed the `PostToolUse` _save nudge_ because it counted tool calls to decide when to inject text. Pi exposes the report only through a post-tool event, so this change permits a post-tool observer **only** when it is filtered to subagent tools by name and contributes nothing to the model's context. The Claude Code and Codex manifests still declare no `PostToolUse` entry.

Not in scope: auto-capturing anything other than a `## Key Learnings` section; a per-user opt-out (a report without the section is already a no-op); capturing subagents spawned by Pi subagent packages beyond the named ones; fixing the pre-existing gap that `/api/<slug>/sessions*` does not yet enforce the `413` body bound (`http-api`, "The authenticated HTTP surface MUST bound request body size") — this route inherits whatever that fix provides.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `http-api` — ADDED the `POST /api/<slug>/sessions/:id/learnings` requirement.
- `mcp-api` — MODIFIED "`memory.capture_passive` MUST use the same curation path as `memory.save`": one shared core capture function, same-session exact-duplicate skip, `skipped` count.
- `plugin-session-protocol` — ADDED the cross-client forwarding rule (what is forwarded, to which session, idempotence, silence, failure diagnostics) and the narrow post-tool observer rule.
- `claude-code-plugin` — MODIFIED the hook-manifest requirement (eight event types, twelve handler entries); ADDED the `subagent-report.sh` behaviour.
- `codex-distribution` — MODIFIED "Codex hook configuration and its `SessionEnd` budget" (eight event types, eleven handler entries, `SubagentStop`).
- `opencode-plugin` — ADDED subagent report forwarding for the 2.x export.
- `pi-plugin` — ADDED subagent report forwarding from the parent extension.
- `hermes-agent-plugin` — ADDED subagent report forwarding through `subagent_stop`.

## Impact

- **Invariants touched.** _Append-only_: the route only inserts memory rows; no update or delete. _Scope at the service layer_: the route resolves the project from the slug and the session through the existing token binding (`rejectIfDeleted`); the new duplicate lookup is a scoped repository read that requires `Scope`. _Fresh-context judgment_: a hook has no agent to judge with, so candidates detected at save time are recorded as pending relations and reach an agent through the existing `memory.context.pendingJudgments[]` path; the route returns only `candidatesDetected`. _topic_key_: unchanged — captured items carry no `topic_key`, exactly as `memory.capture_passive` today.
- **Server:** `packages/core/src/services/` (new `capture-learnings.ts`; `parseKeyLearnings` moves here from `packages/mcp/src/observability-tools.ts`), `packages/core/src/index.ts`, `packages/db/src/repositories/memory-repository.ts` (scoped same-session content lookup over `memory_session_idx`), `packages/mcp/src/observability-tools.ts` (handler delegates to core; `skipped` added to `capturePassiveOutput`), `apps/web/src/app/api/[slug]/sessions/[id]/learnings/route.ts` (new), `apps/web/src/lib/validation.ts` (`parseSessionLearnings`), `apps/web/src/lib/services.ts` and `apps/web/src/lib/mcp-server.ts` (the candidate/`embedNow` wiring becomes shared so the route gets the same post-save steps), `apps/web/src/app/api/README.md` (route table).
- **Plugin:** `apps/plugin/hooks/hooks.json`, `apps/plugin/hooks/hooks.codex.json`, `apps/plugin/scripts/subagent-report.sh` (new), `apps/plugin/scripts/_api.sh` (`rembric_subagent_report`), `apps/plugin/bin/rembric-plugin-core.mjs` (`postSubagentReport`), `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.pi-plugin/index.ts`, `apps/plugin/.hermes-plugin/__init__.py`, `apps/plugin/test/hook-manifests.test.ts`.
- **Docs:** `docs/agents.md` and the per-client plugin READMEs gain one line on automatic capture and the minimum host versions.
- **No schema change, no migration, no new MCP tool.** `memory.capture_passive` gains an additive `skipped` output field and stops writing exact same-session duplicates. Rollback is a plain revert; memories already captured stay as ordinary rows.
- **Release:** server and `plugin` components both release. An older server answers the new route `404`, which the clients log once per failed POST and otherwise ignore, so plugin and server can ship in either order.
