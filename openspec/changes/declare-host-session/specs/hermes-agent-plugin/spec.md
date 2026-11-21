## ADDED Requirements

### Requirement: The Hermes provider SHALL publish a host binding for its own process

Hermes spawns its stdio MCP servers, `mcp_servers.rembric` included, from its own process, so the bridge is a descendant of the process the provider runs in. The provider SHALL therefore publish the host binding that "Clients that reach MCP through the stdio bridge MUST publish a host binding naming their live session" (`plugin-session-protocol`) specifies, for `os.getpid()`, with its own Python implementation:

- A primary provider instance's **live session** is the id it was initialized with, replaced by every `on_session_switch`, until `on_session_end` or `shutdown`. Hermes gives every agent its own provider instance, and an instance serves one session at a time, so a switch on one instance is sequential (`/new`, `/resume`, `/branch`, compression), never concurrent. A `subagent`, `cron` or `flush` context has no live session, so it never replaces or withdraws the primary session's binding. An instance that Hermes drops without `shutdown` stops counting once it is garbage-collected.
- The process's live sessions are the distinct live sessions of its provider instances. Two instances holding the same id are one live session.
- After every `initialize`, `on_session_switch`, `on_session_end` and `shutdown`:
  - with exactly one live session, the provider SHALL publish it;
  - with two or more, it SHALL remove the process's binding whatever session it names, and publish nothing, because a gateway's instances share one MCP bridge that cannot tell their sessions apart;
  - with none, it SHALL remove the binding only while it names the session that just stopped being live.
- `plugin.yaml::hooks` SHALL list `shutdown`.
- None of this SHALL raise into Hermes or change any HTTP lifecycle call.

#### Scenario: A session switch republishes

- **GIVEN** a primary provider initialized with session `A`
- **WHEN** Hermes calls `on_session_switch("B", …)`
- **THEN** `~/.cache/rembric/host-sessions/<Hermes pid>.json` SHALL name `B`

#### Scenario: A Hermes process serving two concurrent sessions publishes no binding

- **GIVEN** a primary provider instance live in session `A`, whose binding names `A`
- **WHEN** a second primary instance in the same process is initialized with session `B`
- **THEN** `~/.cache/rembric/host-sessions/<Hermes pid>.json` SHALL no longer exist
- **AND** an `on_session_switch` of either instance while both are live SHALL write nothing

#### Scenario: Back to one live session republishes it

- **GIVEN** two primary instances live in sessions `A` and `B`, and no binding
- **WHEN** the instance in `B` receives `on_session_end` or `shutdown`
- **THEN** the binding SHALL name `A`

#### Scenario: The same session in two instances is one live session

- **GIVEN** two primary instances both live in session `A`
- **THEN** the binding SHALL name `A`

#### Scenario: A sub-agent beside the primary keeps its binding

- **GIVEN** a primary instance live in session `A`
- **WHEN** a `subagent` instance is initialized in the same process
- **THEN** the binding SHALL still name `A`

#### Scenario: A sub-agent context publishes nothing

- **WHEN** the provider is initialized with `agent_context="subagent"`
- **THEN** no binding SHALL be written

#### Scenario: Shutdown spares another session's binding

- **GIVEN** the process's binding names a session other than the provider's current one
- **WHEN** Hermes calls `shutdown()`
- **THEN** the binding SHALL be kept
