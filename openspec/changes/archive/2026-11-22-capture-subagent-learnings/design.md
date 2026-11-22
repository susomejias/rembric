## Context

`memory.capture_passive` already does the hard part: `parseKeyLearnings` (`packages/mcp/src/observability-tools.ts:124`) extracts the list items of a `## Key Learnings` / `### Key Learnings` section, and `handleCapturePassive` (`:141`) saves each through `saveMemoryWithCandidates` — a two-line wrapper over `MemoryService.saveWithTopicKey` and `runPostSaveSteps` from `packages/core` — with redaction, inline embedding and save-time candidates. What is missing is a trigger that does not depend on the parent agent: the handler is MCP-only, bound to `getRequestContext()` and the session router, and no plugin observes subagent completion.

Hooks speak HTTP. The `/api/<slug>/sessions/:id/*` routes share one shape: `authenticateRequest` → `projectNotFound` → `isAuthorized(write)` → `rejectIfDeleted(token, project)` → a hand-rolled parser in `apps/web/src/lib/validation.ts` → service call → `domainErr`. The candidate and `embedNow` wiring that `memory.save` relies on is built only in `apps/web/src/lib/mcp-server.ts:64-72`, not in `getServices()`.

How each host exposes a finished subagent, from the hosts' own docs and source (reviewed 2026-11-15):

| Host                        | Where the report is                                                                                                                                                                                                                                                    | Parent session id                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude Code                 | `SubagentStop.last_assistant_message`; in auto mode on ≥ 2.1.271, `PreToolUse`/`PostToolUse` on `SubagentHandback` → `tool_input.message`                                                                                                                              | `session_id` — documented only as "Current session identifier"; the example pairs it with the parent transcript |
| Codex CLI ≥ `rust-v0.133.0` | `SubagentStop.last_assistant_message` ("Latest subagent assistant message, if available")                                                                                                                                                                              | `session_id` — "Subagent hooks use the parent session id."                                                      |
| opencode 2.x                | `session.inbox.enqueued`, `item.type: "synthetic"`, `item.payload.metadata.source: "subagent"`, report in `item.payload.text` wrapped in `<subagent …>…</subagent>`                                                                                                    | `data.sessionID`                                                                                                |
| Hermes ≥ v2026.4.23         | general hook `subagent_stop(child_summary=…)`, redacted, head+tail-trimmed when over `delegation.max_summary_chars`                                                                                                                                                    | `parent_session_id` kwarg                                                                                       |
| Pi                          | no core event; extension tools `subagent` (example, pi-subagents), `subagent_run` / `subagent_continue` / `subagent_result` (gentle-pi) on `tool_execution_end`; background completions as custom messages `subagent-notify`, `gentle-agents.message` on `message_end` | the extension's own session id                                                                                  |

Constraints that shape the design: the Claude Code and Codex manifests are pinned by `apps/plugin/test/hook-manifests.test.ts` (exact event sets, handler counts, no `PostToolUse`); the shared JS core must be the single implementation of cross-client logic (`plugin-session-protocol`, invariant test `:887-1069`); a hook has no agent to judge candidates or to choose tags.

## Goals / Non-Goals

**Goals:**

- A subagent report that contains a `## Key Learnings` section is saved, item by item, through the same curation path as `memory.capture_passive`, attributed to the parent session, on all five clients where the host exposes the report.
- Forwarding is silent toward the model, never blocks the subagent or the parent, and is idempotent.
- One server implementation of extraction + save, shared by the route and the MCP tool.

**Non-Goals:**

- Capturing anything other than the `## Key Learnings` section (no summarisation, no LLM).
- A per-user or per-project opt-out. A report without the section is already a no-op, and the section is something the user's own delegation prompts ask for.
- Judging candidates on the hook path.
- Supporting every Pi subagent package; only the named tool and message types are recognised.
- Enforcing the `413` body bound on `/api/<slug>/sessions*` (pre-existing gap; this route inherits that fix when it lands).

## Decisions

### 1. Route at `POST /api/<slug>/sessions/:id/learnings`, session in the path

The parent session is the attribution target, so it goes in the path and gets the existing token binding (`rejectIfDeleted`: `404 session_not_found` for another token's session, `409 session_deleted`) for free. Body `{ report: string, agentType?: string }`. Response `200 { ok: true, saved, skipped, ids, candidatesDetected, reason? }`.

- _Alternative: `POST /api/<slug>/memory/capture` with `sessionId` in the body._ Rejected: re-implements session ownership checks the session routes already share, and sits outside the `/sessions*` body-bound requirement.
- _Alternative: let the route auto-create an unknown session._ Rejected: the parent session is always registered by the client's session-start path first; auto-creating would let a mis-attributed id (a subagent id) silently create orphan sessions instead of failing visibly.

### 2. Server-assigned tags

A hook cannot choose "useful reusable" tags, and `memory.capture_passive`'s contract requires 1–64. The route passes `['subagent-learning']`, plus `agentType` when supplied and non-empty, through the same service-boundary normalisation (`normalizeTags`) — `Explore` → `explore`, `my-plugin:reviewer` → `my-pluginreviewer` (the shared normalization drops the colon). If `agentType` normalises to nothing it is dropped rather than failing the request.

- _Alternative: relax the tag requirement for this path._ Rejected: tagless rows are what the required-tags change set out to stop.
- _Alternative: client-chosen tags._ Rejected: five clients would each need a policy, and none has better information than `agentType`.

### 3. The server parses only the trailing 50,000 code points

Reports can be long, and the learnings block closes the report. The route accepts `report` of any length up to the body bound and passes its last 50,000 code points (the `memory.capture_passive` `text` cap) to extraction. Hermes and gentle-pi already trim by keeping head and tail, which preserves the closing block.

- _Alternative: each client trims._ Rejected: five implementations, and bash cannot count code points cheaply.
- _Alternative: reject over-long reports with `400`._ Rejected: it loses exactly the reports most likely to carry learnings.

### 4. Idempotency by same-session exact-content skip

An extracted item whose redacted content equals the `content` of an active memory attached to the same session, in the same scope, is skipped and counted in `skipped`. The check and the insert for one item run in the same synchronous transaction, so two concurrent forwards of the same report (Claude Code's `SubagentHandback` and `SubagentStop` fire close together) cannot both insert. The lookup is a scoped repository read over `memory_session_idx`.

This covers every duplication source found: Claude Code's two paths and its pre-2.1.311 repeated `SubagentStop` firing, opencode's at-least-once inbox delivery (an `inboxID` can be redelivered from the outbox after a restart), opencode ≥ 2.3 sending a report per idle cycle, and a parent agent that also calls `memory.capture_passive` on the same report.

- _Alternative: an idempotency key (`agent_id` / `inboxID` / `toolCallId`) stored with the memory._ Rejected: needs a column or a new `source` field (a persisted-format change), differs per host, and does not cover the parent's manual capture, which carries no key.
- _Alternative: no dedupe, let save-time candidates flag duplicates._ Rejected: every duplicate becomes a pending judgment nobody on the hook path can close, inflating `memory.context.pendingJudgments[]`.

### 5. One core function shared by the route and the MCP tool

`captureKeyLearnings(deps, { text, tags, sessionId, source }, scope)` moves to `packages/core/src/services/capture-learnings.ts`, together with `parseKeyLearnings`. `handleCapturePassive` keeps scope resolution, authorisation and session resolution, then delegates. The route does the same with its own context. The candidate and `embedNow` wiring moves into a shared factory that both `mcp-server.ts` and the route use, so "embedded before return, candidates recorded" holds on both surfaces.

- _Alternative: the route re-implements the loop._ Rejected: two copies of the curation path is the drift `mcp-api` already forbids for `memory.capture_passive` vs `memory.save`.
- _Alternative: the route calls the MCP handler._ Rejected: the handler is bound to `getRequestContext()` and router scope resolution, which the route does not have.

### 6. Provenance `source.agent = 'subagent'`

The dashboard shows `source.agent` ("written by …", `apps/web/src/app/dashboard/memories/[id]/page.tsx:248`). Rows from the route carry `{ tokenName, agent: 'subagent' }`; `memory.capture_passive` keeps `'passive'`. An operator can tell an automatic capture from an agent's own.

- _Alternative: reuse `'passive'`._ Rejected: hides the one fact an operator needs when an automatic capture looks wrong.

### 7. Claude Code: `SubagentStop` + `PreToolUse` on `SubagentHandback`, both async, no `PostToolUse`

In auto mode on ≥ 2.1.271 the report never reaches `last_assistant_message`; it is `tool_input.message` of the `SubagentHandback` call, visible to `PreToolUse` and `PostToolUse`. `PreToolUse` sees the same input, keeps the manifest's no-`PostToolUse` rule intact, and — because the hook is `async` and emits nothing — can never deny the call (a deny makes the host ask the subagent to retry up to three times). Outside auto mode, or for forks, `SubagentStop` carries the report. Both entries run one script, `subagent-report.sh`, which reads the text from whichever field the event carries.

`SubagentStop` also fires for host-internal agents (prompt suggestions, `/btw`) with an empty `agent_type`; the script skips those.

- _Alternative: parse `agent_transcript_path` for a handback call._ Rejected: depends on the transcript's internal format.
- _Alternative: `PostToolUse` on `SubagentHandback`._ Rejected: equivalent data, and it reopens the manifest prohibition for no gain.

### 8. Codex: one synchronous `SubagentStop` entry printing `{}`

Codex requires JSON on stdout for `SubagentStop` when the hook exits 0. The entry declares `"timeout": 3` and the script prints `{}` after its POST (2-second budget), mirroring the `Stop` entry. There is no handback tool on Codex, so `last_assistant_message` is the report.

### 9. opencode: the inbox event on 2.x only

On 2.x the `subagent` tool always runs in the background, so its tool output never holds the report. `session.idle` is deprecated and unpublished, and the plugin `session` domain has no `messages` method. The inbox item is the one place the report reaches the parent, already tagged with the parent id. The stream carries the event's payload under `data` (`packages/plugin/src/promise/adapter.ts:331-341`, `packages/schema/src/event.ts:108-116` at 2.3.0). The forwarder removes the `<subagent>` wrapper and the trailing `Background work still running:` block (`subagent-completion.ts:37-53`).

The 1.x export is left unchanged. The published `opencode-plugin` spec keeps v1 free of tool hooks ("The v1 entry point is unchanged"), and the same v2-only scope was chosen for file-anchored recall. A 1.x route would need `tool.execute.after` on `task`. That route would also miss background completions, which 1.x delivers as a synthetic prompt part (`task.ts:226-250` at v1.19.5).

### 10. Pi: parent-side observation of known subagent tools and messages

Child-side forwarding cannot work reliably: pi-subagents runs foreground children in-process with ambient extensions disabled (our extension never loads there); its background runner exports only the _root_ parent id; the Pi example and gentle-pi pass no parent id at all. Parent-side observation attributes to the extension's own session, which is always right. The extension keeps one table of recognised tool names (`subagent`, `subagent_run`, `subagent_continue`, `subagent_result`) and custom message types (`subagent-notify`, `gentle-agents.message`). It reads `tool_execution_end` (the final value after `tool_result` middleware) and skips results with `isError: true`.

### 11. Hermes: `subagent_stop`, not `on_delegation`

Both are parent-side. `subagent_stop` passes `parent_session_id` explicitly, so attribution does not depend on which session the provider instance points at if the parent compresses or switches sessions while a delegation runs. It is registered in the existing `register(ctx)` alongside `transform_tool_result`. The child side is not an option: by default children run provider-less, and under the checkpoint gate the host suppresses `on_session_end` for `agent_context="subagent"`.

### 12. Post-tool observers: permitted narrowly

#235 removed a `PostToolUse` hook that counted tool calls to decide when to inject a save reminder into the model's context — a context-pollution and cadence problem. Observing a subagent tool's result to forward it over HTTP has neither property. Where a host exposes the report only after a tool completes (Pi), a post-tool observer is allowed if it is filtered to subagent tools by name and contributes nothing to the model's context. The Claude Code and Codex manifests keep their `PostToolUse` prohibition.

### 13. What the clients send

Each client strips `<private>…</private>` spans before sending, reusing the existing helper (`stripPrivateTags` in the JS core, the `_api.sh` equivalent, the Hermes Python helper). It sends the report text and the agent type when the host names one, and nothing else (no transcript, no task prompt). Failure is one stderr diagnostic, per the existing failed-POST rule; nothing reaches the model.

## Risks / Trade-offs

- [Risk] Claude Code's `SubagentStop` `session_id` is not documented as the parent's, and a `PreToolUse` fired inside a subagent may carry a different id → Task 1.1 probes both on a live session before any client work. If either carries the subagent's id, the route answers `404 session_not_found`, the client logs one line, and nothing is mis-attributed. The design then switches that path to the parent id the event exposes, or drops it.
- [Risk] Automatic capture saves learnings no agent reviewed → The section is something the delegating prompt asked for. Every item goes through redaction and candidate detection. Rows are marked `source.agent = 'subagent'` and stay ordinary archivable memories.
- [Risk] Candidates detected on the hook path accumulate as pending judgments → They resurface through the existing aged-pendings path. The same-session skip removes the largest duplicate source.
- [Trade-off] The content skip is exact-match only, so a near-duplicate (reworded item) is saved and flagged as a candidate → Accepted because semantic dedupe is exactly what candidate judgment exists for.
- [Risk] Pi tool and message names are per-package contracts that can change → One table in one file, covered by a test per name. An unrecognised package is simply not captured, which is today's behaviour.
- [Risk] A trimmed report could cut the learnings block. Hermes and gentle-pi trim head+tail, which keeps the closing block. The Pi example extension's `truncateModelOutput` keeps the HEAD (`truncateHead`, first 2000 lines / 50 KB, `examples/extensions/subagent/index.ts:234-245`), so a report over that size loses its closing block in `result.content` → Accepted. The full output exists only in that extension's private `details` shape, and the example is a sample rather than a maintained package.
- [Risk] Pi delivers a custom message appended while the agent is idle without `triggerTurn` to session listeners only, not to extensions (`src/core/agent-session.ts:1102-1106,2512-2521`), so such a background completion is not captured → Accepted. Deliveries that steer, follow up or trigger a turn reach the extension. Task 1.4 records how gentle-pi and pi-subagents deliver.
- [Risk] Claude Code in `-p` mode kills async hooks at teardown, so the last subagent's report can be lost → Accepted. Interactive sessions are unaffected, and there is no synchronous alternative that does not delay the subagent.
- [Risk] A host version without the event (Codex < 0.133.0, Hermes < v2026.4.23) → The entry never fires. Task 1.2 confirms an unknown event name in `hooks.codex.json` is ignored rather than rejected on an older Codex.
- [Trade-off] The route accepts reports up to the body bound but parses only the last 50,000 code points → Accepted because the learnings block closes the report.

## Migration Plan

1. Ship the server first or together: the route is additive, and `memory.capture_passive`'s `skipped` field is additive.
2. Ship the plugin. Against an older server the route answers `404`; clients log one diagnostic per failed POST and continue.
3. Rollback: revert either component. Captured memories remain ordinary rows; nothing reads a new column.

## Open Questions

- Does `SubagentStop` fire for Claude Code forks and in-process agent-team teammates? Undocumented; covered by Task 1.1. Either answer is safe: a missed fire loses a capture, a duplicate fire is skipped.
- The exact encoding of `session.inbox.enqueued` in the opencode 2.x plugin event stream (`data` vs `properties`) was read from source but not observed live; covered by Task 1.3.
- How a Pi custom message exposes `customType` and its text on `message_end`; covered by Task 1.4.
