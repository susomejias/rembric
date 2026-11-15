## ADDED Requirements

### Requirement: The opencode plugin MUST forward finished subagent reports from both of its exports

The plugin ships a 2.x export (`RembricPluginV2`, `ctx.event.subscribe`) and a legacy 1.x hooks export. Each SHALL forward subagent reports through the shared core's `postSubagentReport` (`plugin-session-protocol`), attributed to the parent session id that the export already registers for top-level sessions.

**2.x.** The `subagent` tool always runs in the background, so its tool output never contains the report. The 2.x `session.idle` event is deprecated, and the plugin `session` domain exposes no `messages` method. The report reaches the parent only as a `session.inbox.enqueued` event whose `item.type` is `synthetic` and whose `item.payload.metadata.source` is `subagent`. The 2.x export SHALL handle exactly those events. It SHALL take the parent id from the event's `sessionID` and the report from `item.payload.text`, with the enclosing `<subagent …>…</subagent>` element removed and any trailing block opencode appends to list still-running background work removed. It SHALL pass `item.payload.metadata.agent` as `agentType` when present. It SHALL NOT forward when the parent id is a session the plugin marked as a subagent. Nested reports stay with their own top-level session.

**1.x.** The `task` tool returns `<task …><task_result>…</task_result></task>`, where the result is the child's last text part. The 1.x export SHALL observe `tool.execute.after` for tool `task` only, under the post-tool observer rule (`plugin-session-protocol`). It SHALL take the parent id from the hook input's `sessionID` and the report from the content of `<task_result>`. A `task` output without a `<task_result>` element (a background start notice) SHALL NOT be forwarded.

Neither export SHALL alter the event, the inbox item or the tool output it observes.

#### Scenario: A 2.x subagent report is forwarded to the parent

- **GIVEN** a top-level session `P` registered by the plugin
- **WHEN** the event stream delivers `session.inbox.enqueued` for `P` with a synthetic item whose metadata is `{source: "subagent", agent: "explore", …}` and whose text is `<subagent sessionID="c1" state="completed" description="scan">` + a body ending in a `## Key Learnings` list + `</subagent>`
- **THEN** the plugin SHALL POST `/api/<slug>/sessions/P/learnings` with `report` equal to the body without the wrapper, and `agentType: "explore"`

#### Scenario: Other inbox items are ignored

- **WHEN** the event stream delivers `session.inbox.enqueued` whose item is not synthetic, or whose `metadata.source` is not `subagent`
- **THEN** the plugin SHALL make no request

#### Scenario: A 1.x task result is forwarded

- **WHEN** `tool.execute.after` fires for tool `task` in session `P` with output `<task id="t1" state="completed">\n<task_result>\n…## Key Learnings\n1. X\n</task_result>\n</task>`
- **THEN** the plugin SHALL POST the content of `<task_result>` as `report` to `/api/<slug>/sessions/P/learnings`
- **AND** the output the model receives SHALL be unchanged

#### Scenario: A 1.x background start notice is not forwarded

- **WHEN** `tool.execute.after` fires for tool `task` with an output that contains no `<task_result>` element
- **THEN** the plugin SHALL make no request
