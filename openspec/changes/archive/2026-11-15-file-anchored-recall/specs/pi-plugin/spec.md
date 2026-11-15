## ADDED Requirements

### Requirement: The Pi extension SHALL append file-anchored recall to the result of the tool that reached the file

The extension SHALL capture paths on `tool_call` and SHALL deliver the lines on `tool_result`, never blocking a tool.

Per Pi's extension documentation (`docs/extensions.md`, verified against `@earendil-works/pi-coding-agent` 1.4.0), `tool_call` is the event to "Authorize or modify a tool call" and `tool_result` the event to "Redact, annotate, or replace a tool result". A `tool_call` handler can only mutate input or block, and "A `tool_call` handler failure blocks the tool as a fail-safe".

The extension SHALL therefore:

**On `tool_call`: capture only.**
- Collect the paths of `read`, `edit` and `write` calls (`input.path`) and of `bash` calls (`input.command`, through the core's `extractCommandPaths`).
- Resolve them against `ctx.cwd`.
- Call the core's `fileRecall` for each fresh path, keyed by `toolCallId`.
- Every step SHALL be guarded so that it can neither throw nor return `block`.

**On `tool_result`:** when lines were obtained for that `toolCallId`:
- Return `{ content: [...event.content, { type: "text", text: <lines joined by newline> }] }`.
- Also return the event's `structuredContent` unchanged. The documentation states that replacing `content` without returning `structuredContent` drops it.
- Otherwise return nothing.

**Nested calls:** these carry `parentToolCallId`. They SHALL be handled like any other call, because Pi has no built-in sub-agents. A call in a session the core marks as a sub-agent session SHALL be skipped.

**Wiring:** the session id SHALL come from the same source the extension already uses for its other handlers. All state SHALL live in the shared core and be cleared by `forgetSession`.

#### Scenario: A bash read is annotated

- **GIVEN** an eligible memory linked to `src/app.ts` and a Pi session in that repository
- **WHEN** the agent's `bash` tool runs `cat src/app.ts`
- **THEN** the `tool_result` the model receives SHALL end with a text block starting `rembric: memories about src/app.ts:`
- **AND** the result's `structuredContent`, if any, SHALL be unchanged

#### Scenario: A failure never blocks the tool

- **GIVEN** a server that times out
- **WHEN** the agent's `read` tool reads a tracked file
- **THEN** the tool SHALL run and its result SHALL be delivered unchanged
- **AND** the `tool_call` handler SHALL NOT have thrown or returned `block`
