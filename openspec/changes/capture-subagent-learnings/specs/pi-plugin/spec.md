## ADDED Requirements

### Requirement: The Pi extension MUST forward subagent reports observed in the parent session

The Pi extension SHALL forward subagent reports from the parent session, by observing the result surfaces of the recognised subagent extensions.

Pi core has no subagents. Extensions implement them and return a child's report to the parent as a tool result or a custom message. The child side cannot attribute reliably:

- pi-subagents runs foreground children in-process with ambient extensions disabled, so this extension never loads there;
- its background runner exports only the root parent id;
- the Pi example extension and gentle-pi pass no parent id.

The extension SHALL therefore forward from the parent, attributing every report to the session id it already uses for that session's turn reports, through the shared core's `postSubagentReport` (`plugin-session-protocol`).

The extension SHALL keep one table of recognised subagent surfaces:

- tool names `subagent`, `subagent_run`, `subagent_continue`, `subagent_result`;
- custom message types `subagent-notify`, `gentle-agents.message`.

It SHALL forward:

- on `tool_execution_end` for a recognised tool name with `isError` false, the concatenated text parts of `result.content`. `tool_execution_end` is used because it carries the final result after any `tool_result` handlers;
- on `message_end` for a custom message of a recognised type, the message's text content.

An unrecognised tool or message type SHALL be ignored, under the post-tool observer rule (`plugin-session-protocol`). The extension SHALL NOT forward while it is itself running as a subagent child (the existing child detection), so a nested delegation is reported only by its own parent.

#### Scenario: A foreground subagent result is forwarded

- **GIVEN** a parent session whose id the extension reports turns under as `P`
- **WHEN** `tool_execution_end` fires with `toolName: "subagent"`, `isError: false` and a text result ending in a `## Key Learnings` list
- **THEN** the extension SHALL POST that text as `report` to `/api/<slug>/sessions/P/learnings`

#### Scenario: A background completion message is forwarded

- **WHEN** `message_end` fires for a custom message of type `gentle-agents.message` whose text ends in a `## Key Learnings` list
- **THEN** the extension SHALL POST that text as `report` for the current session

#### Scenario: Errors and other tools are ignored

- **WHEN** `tool_execution_end` fires for `subagent_run` with `isError: true`, or for tool `bash` with any result
- **THEN** the extension SHALL make no request

#### Scenario: A subagent child does not forward

- **GIVEN** the extension running in a process marked as a subagent child
- **WHEN** `tool_execution_end` fires for a recognised tool
- **THEN** it SHALL make no request
