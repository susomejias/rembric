## ADDED Requirements

### Requirement: The Pi extension SHALL report each turn on `agent_settled` and print the server's lines on `before_agent_start`

`apps/plugin/.pi-plugin/index.ts` SHALL participate in the report-and-print contract (`session-nudges`) through the events it already registers, adding no new registration and writing no new HTTP code — the report call lives in the shared core, like every other request this client makes.

**Reporting, on `agent_settled`.** That handler already fires at the end of a turn and already schedules the debounced flush; it SHALL additionally call the core's turn-report helper, and the core SHALL read its own tool-observation latch and cache the returned lines. The debounced flush is retained: the accumulator holds the only copy of this session's transcript in memory, and both this capability's session-close requirement and `plugin-session-protocol`'s Pi convergence requirement rest on it.

**Observing tool use — the signal is `message_end`, and it SHALL be ACCUMULATED across the turn rather than read from one event.** The observation is the shared core's per-session latch, with three touch points, all on handlers this extension already registers: disarmed in `before_agent_start`, armed in `message_end`, read and cleared by the report in `agent_settled`. **This extension SHALL hold no flag of its own** — what it contributes is the predicate below, which is the only part that is Pi's.

`message_end` SHALL arm the latch when EITHER holds:

- `event.message.role === 'toolResult'`, or
- `event.message.role === 'assistant'` and any element of `event.message.content` has `type === 'toolCall'`.

**Reading a single event gives the wrong answer every time, and that is the whole reason this rule is normative rather than an implementation note.** The LAST `message_end` of a turn — the one this extension's handler processes today — is the assistant message whose `stopReason` is `"stop"` and whose content is text only, carrying no `toolCall` part; the calls were in an EARLIER `message_end` whose `stopReason` was `"toolUse"`. `turn_end.toolResults` is likewise empty on the final turn. An implementation that inspects the settled message, or the last message, or the turn-end event, reports `usedTools: false` for a turn that ran ten tools.

Two places in the shipped extension discard exactly this information today, and both SHALL be adjusted rather than worked around: the `role !== 'assistant'` early return in the `message_end` handler, which drops every `toolResult` message; and `assistantText`, which filters content to `type === 'text'` and therefore drops every `toolCall` part. `assistantText`'s own contract is unchanged — it feeds the transcript accumulator, which wants text — so the latch SHALL be armed BEFORE either filter runs, not by loosening them.

**The mechanism is verified against the shipped harness (pi-coding-agent 0.84.1) rather than inferred.** `AssistantMessage.content` is typed `(TextContent | ThinkingContent | ToolCall)[]` with `ToolCall.type === "toolCall"`, and `ToolResultMessage.role === "toolResult"` is one of the three members of the `Message` union (`@earendil-works/pi-ai/dist/types.d.ts`); `StopReason` includes both `"toolUse"` and `"stop"`. The harness forwards `message_end` to extensions with the message unfiltered by role, and its own replacement normaliser enumerates `user | assistant | toolResult | custom` (`dist/core/agent-session.js`), so a `toolResult` message does reach an extension handler. That channel is additionally the one this extension already receives in production, which is why it is preferred over the alternative below.

**The five dedicated tool events are available and are NOT used, by decision.** `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call` and `tool_result` are all declared on the public extension API (`dist/core/extensions/types.d.ts`), `pi.on` stores any key into a handler `Map` without validating it against a whitelist (`dist/core/extensions/loader.js`), and dispatch is a plain `handlers.get(event.type)` lookup (`dist/core/extensions/runner.js`) fed by the same runner that already delivers `message_end`. They would be simpler — a latch armed with no content inspection. They are rejected here on evidence quality: delivery of `message_end` to this extension is observed in production, whereas delivery of the five is established by reading that code chain, and one check was not run (no purpose-built extension was loaded with `pi -e` to receive them). A later change MAY switch to `tool_execution_end` once that check exists; the accumulation rule above would be unchanged by the switch.

**A Rembric tool call SHALL NOT be used as the signal.** Pi routes every discovered Rembric tool through the extension's own `execute`, so counting those calls is available and wrong: it observes only this server's tools, so a turn that edited eight files without touching memory reports no work — which is precisely the turn the notice exists for.

**Printing, on `before_agent_start`.** The handler SHALL read and clear the cached lines and include them, after the sessionId line and any client-composed line that applies, in the `message` it already returns (`customType: 'rembric'`, `display: false`). The lines SHALL be passed through `underscoreToolNames`, exactly as the client-composed lines already are, because a provider refuses the whole tools payload if a name contains a `.` and the notice names `memory.session_summary`. **That substitution is the ONLY transformation permitted**, and it SHALL be applied by the same shared helper rather than by a per-client string edit; no other rewriting, truncation, prefixing or reordering SHALL occur.

Pi has no compaction event, so nothing about this changes the accepted-risk clause that governs that gap.

#### Scenario: One report per turn, from `agent_settled`

- **GIVEN** a Pi session driven through three turns
- **WHEN** the three `agent_settled` events have fired
- **THEN** exactly three turn reports SHALL have been issued through the core
- **AND** none SHALL have been issued from `before_agent_start`

#### Scenario: The server's lines reach the harness prompt, transformed only by the tool-name substitution

- **GIVEN** a cached notice from the previous turn's report
- **WHEN** `before_agent_start` next runs
- **THEN** the returned `message.content` SHALL contain those lines
- **AND** the only difference from the response's bytes SHALL be dotted tool names rendered underscored by `underscoreToolNames`
- **AND** the cache SHALL be cleared, so the next turn's `before_agent_start` includes neither

#### Scenario: Rembric's own tool calls are not the work signal

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** the tool-observation flag SHALL NOT be set from the extension's `execute` callback
- **AND** a turn in which the model called only `memory.search` SHALL NOT, by that fact alone, be reported as having used a tool

#### Scenario: The settled message alone reports the wrong answer — the flag must have accumulated

- **GIVEN** a turn in which the model called a tool and then answered in text, so the turn's `message_end` sequence is an assistant message with `stopReason: "toolUse"` carrying a `toolCall` part, then a `toolResult` message, then an assistant message with `stopReason: "stop"` carrying text only
- **WHEN** `agent_settled` fires
- **THEN** the report SHALL carry `usedTools: true`
- **AND** the control SHALL pass in the same run: inspecting ONLY the final `message_end` — the settled assistant message — SHALL yield `false`, which is why the flag is accumulated rather than read
- **AND** `turn_end.toolResults` SHALL NOT be used as the signal; on that turn it is empty

#### Scenario: The flag resets per turn

- **GIVEN** a session whose previous turn used a tool
- **WHEN** the next turn runs with no tool call and `agent_settled` fires
- **THEN** the report SHALL carry `usedTools: false`
- **AND** the disarm SHALL have happened in `before_agent_start`, so a latch armed in one turn cannot be read in the next

#### Scenario: Neither existing text filter is loosened to carry the signal

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** `assistantText` SHALL still filter content parts to `type === 'text'`
- **AND** the latch SHALL be armed before the `message_end` handler's role filter and before `assistantText` runs, rather than by widening either

## MODIFIED Requirements

### Requirement: The extension SHALL import shared session-protocol logic, never reimplement it

`apps/plugin/.pi-plugin/index.ts` SHALL obtain the client-composed line texts, `stripPrivateTags`, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers, the session-end call, **the turn-report call and the per-session cache of the server's returned lines** from `apps/plugin/bin/rembric-plugin-core.mjs`. It SHALL NOT declare its own copy of any of them.

The session-end call SHALL live in the shared core even though this is the only client that invokes it, because the core is the single implementation of the session HTTP client (see the `plugin-session-protocol` capability) and a second `fetch` against a `/sessions/…` path written in a client file is a second copy of that client by construction. The turn-report call is in the core for the same reason and for one more: it is the only request in the protocol whose RESPONSE the client consumes, so a per-client copy would also be a per-client parser of that response.

The core module SHALL require `agent` as a mandatory parameter of session registration, with **no default value**. `sessions.agent` is written once per session and memory is append-only, so a defaulted value registers sessions under the wrong agent permanently, with no repair verb. The hand-written type declaration `apps/plugin/bin/rembric-plugin-core.d.mts` SHALL declare `agent` as a required property so an omission is a compile error in the TypeScript clients, and SHALL declare the turn-report helper's parameter and return types so a client cannot pass an untyped observation or ignore the returned lines by accident.

#### Scenario: The extension imports the core rather than copying it

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains an import statement referencing `rembric-plugin-core.mjs`
- **AND** it declares no local `function stripPrivateTags`, no local line-text constant, no local session-POST helper and no local pending-lines cache

#### Scenario: The session-end and turn-report calls are imported, not written in the client

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it SHALL contain no `fetch` call against a path containing `/sessions/`
- **AND** the end and the report SHALL both be reached through the core's exported functions

#### Scenario: Omitting `agent` is a compile error

- **WHEN** a call to the core's session-registration entry point omits `agent`
- **AND** `tsc` typechecks a TypeScript client against `rembric-plugin-core.d.mts`
- **THEN** typechecking SHALL fail
- **AND** no default agent value SHALL be substituted at runtime
