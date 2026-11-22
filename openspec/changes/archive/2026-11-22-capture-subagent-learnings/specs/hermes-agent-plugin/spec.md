## ADDED Requirements

### Requirement: The Hermes plugin MUST forward delegated subagent reports through `subagent_stop`

The Hermes plugin SHALL forward a delegated child's final summary to the parent session from the parent side, through the general `subagent_stop` hook.

Hermes runs `delegate_task` children with no memory provider by default. Under the checkpoint gate it still suppresses `on_session_end` and `on_delegation` for `agent_context="subagent"`, so the child side cannot forward. The general plugin hook `subagent_stop` fires once per child on the parent thread with `parent_session_id`, `child_session_id`, `child_role` and `child_summary` — "The final response the child returned to the parent", already redacted by the host.

The plugin's `register(ctx)` SHALL register a `subagent_stop` callback through `ctx.register_hook`, beside the existing `transform_tool_result` and `transform_terminal_output` registrations. The callback SHALL accept `**kwargs`: the host passes `child_session_id`, which its own documentation omits. The callback SHALL:

- do nothing when the provider is suppressed, has no slug, or when `parent_session_id` or `child_summary` is empty;
- apply the cross-client pre-filter and strip `<private>…</private>` spans;
- POST `/api/<slug>/sessions/<parent_session_id>/learnings` with `report` = `child_summary`, plus `agentType` = `child_role` when non-empty;
- run the POST on a background worker created the same way as `sync_turn`'s, with the initialized server, token and slug captured at dispatch, so the parent thread is never blocked by the request;
- return `None` and never raise into Hermes. A failure is one safe stderr diagnostic.

`parent_session_id` is used rather than the provider's current session id, so a parent that compresses or switches sessions while a delegation runs still attributes the report to the session that delegated.

#### Scenario: A delegated child's learnings reach the parent session

- **GIVEN** an initialized, unsuppressed provider with a resolved slug
- **WHEN** Hermes invokes `subagent_stop(parent_session_id="P", child_session_id="C", child_role="researcher", child_summary=<text ending in a ## Key Learnings list>)`
- **THEN** the plugin SHALL POST `{"report": <text>, "agentType": "researcher"}` to `/api/<slug>/sessions/P/learnings` from a background worker
- **AND** the callback SHALL return before that request completes

#### Scenario: An empty summary is ignored

- **WHEN** `subagent_stop` fires with an empty `child_summary`
- **THEN** the plugin SHALL make no request

#### Scenario: A failing server never raises into Hermes

- **GIVEN** the server is unreachable
- **WHEN** `subagent_stop` fires with a report containing learnings
- **THEN** the callback SHALL return normally and the worker SHALL write one diagnostic line without the response body or credentials
