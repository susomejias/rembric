## ADDED Requirements

### Requirement: The Hermes provider SHALL publish a host binding for its own process

Hermes spawns its stdio MCP servers, `mcp_servers.rembric` included, from its own process, so the bridge is a descendant of the process the provider runs in. The provider SHALL therefore publish the host binding that "Clients that reach MCP through the stdio bridge MUST publish a host binding naming their live session" (`plugin-session-protocol`) specifies, for `os.getpid()`, with its own Python implementation:

- `initialize` SHALL publish its `session_id`, and `on_session_switch` SHALL publish the new id, for a primary context only. A `subagent`, `cron` or `flush` context SHALL publish nothing, so it never replaces the primary session's binding.
- `on_session_end` and `shutdown` SHALL remove the binding only while it names the provider's current session. `plugin.yaml::hooks` SHALL list `shutdown`.
- Neither SHALL raise into Hermes or change any HTTP lifecycle call.

#### Scenario: A session switch republishes

- **GIVEN** a primary provider initialized with session `A`
- **WHEN** Hermes calls `on_session_switch("B", …)`
- **THEN** `~/.cache/rembric/host-sessions/<Hermes pid>.json` SHALL name `B`

#### Scenario: A sub-agent context publishes nothing

- **WHEN** the provider is initialized with `agent_context="subagent"`
- **THEN** no binding SHALL be written

#### Scenario: Shutdown spares another session's binding

- **GIVEN** the process's binding names a session other than the provider's current one
- **WHEN** Hermes calls `shutdown()`
- **THEN** the binding SHALL be kept
