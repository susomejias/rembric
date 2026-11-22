## ADDED Requirements

### Requirement: The opencode 2.x plugin MUST forward finished subagent reports from the session inbox

The 2.x export (`RembricPluginV2`, `ctx.event.subscribe`) SHALL forward subagent reports through the shared core's `postSubagentReport` (`plugin-session-protocol`). Each report SHALL be attributed to the parent session id that the export already registers for top-level sessions.

The `subagent` tool always runs in the background, so its tool output never contains the report. The 2.x `session.idle` event is deprecated, and the plugin `session` domain exposes no `messages` method. The report reaches the parent only as a `session.inbox.enqueued` event. The stream carries its payload under `data`, as `{sessionID, inboxID, item}`. For a subagent report, `item.type` is `synthetic` and `item.payload.metadata.source` is `subagent`.

The export SHALL handle exactly those events:

- it SHALL take the parent id from `data.sessionID`;
- it SHALL take the report from `item.payload.text`, with the enclosing `<subagent …>…</subagent>` element removed, and with the trailing block opencode appends to list still-running background work (it starts `Background work still running:`) also removed;
- it SHALL pass `item.payload.metadata.agent` as `agentType` when present;
- it SHALL NOT forward when the parent id is a session the plugin marked as a subagent. Nested reports stay with their own top-level session.

It SHALL NOT alter the event or the inbox item.

The 1.x export SHALL NOT forward subagent reports. It keeps registering no tool hook, as "The v1 entry point is unchanged" requires.

#### Scenario: A 2.x subagent report is forwarded to the parent

- **GIVEN** a top-level session `P` registered by the plugin
- **WHEN** the event stream delivers `session.inbox.enqueued` for `P`, carrying a synthetic item whose metadata is `{source: "subagent", agent: "explore", …}` and whose text is `<subagent sessionID="c1" state="completed" description="scan">` + a body ending in a `## Key Learnings` list + `</subagent>`
- **THEN** the plugin SHALL POST `/api/<slug>/sessions/P/learnings` with `report` equal to the body without the wrapper, and `agentType: "explore"`

#### Scenario: The still-running block is not part of the report

- **WHEN** the inbox text's body ends with `\n\nBackground work still running:\n- shell (…)`
- **THEN** the posted `report` SHALL end before that block

#### Scenario: Other inbox items are ignored

- **WHEN** the event stream delivers `session.inbox.enqueued` whose item is not synthetic, or whose `metadata.source` is not `subagent`
- **THEN** the plugin SHALL make no request

#### Scenario: The 1.x export forwards nothing

- **WHEN** the 1.x export is loaded
- **THEN** it SHALL register no `tool.execute.after` hook
