## ADDED Requirements

### Requirement: A request naming an unknown MCP session MUST be refused with `404` and MUST NOT construct a server

The `/mcp` entry point hands the `mcp-session-id` header straight to the transport manager, which builds a fresh `McpServer` and transport whenever it does not recognise the id. That pair has never handled an `initialize`, so the SDK transport refuses the request with `400` and JSON-RPC code `-32000` (`Bad Request: Server not initialized`) — a status that tells a conformant client nothing about restarting its session, after paying for a full tool-surface construction to produce a refusal.

When a request carries an `mcp-session-id` the transport manager does not hold, and the request is not itself an `initialize` request, the server SHALL respond `404` with the JSON-RPC error code `-32001` and a `Session not found` message — the same refusal the SDK transport emits for an id that does not match a live transport, and the signal the Streamable HTTP transport defines for a session the server no longer has. The server SHALL NOT instantiate an `McpServer` or a transport while producing that refusal.

An `initialize` request SHALL continue to establish a fresh session, whether or not it carries a stale `mcp-session-id`. A request naming a session the manager does hold SHALL be unaffected.

This is the recovery half of the `sessions` capability's eviction rule: without it, an evicted client cannot distinguish "start a new session" from "this server is broken", and every request naming a stale id costs a server construction.

#### Scenario: A tool call naming an unknown session is refused with 404

- **GIVEN** an `mcp-session-id` the transport manager does not hold, because it was evicted or predates a restart
- **WHEN** a non-`initialize` request carrying that id arrives at `/mcp`
- **THEN** the response status SHALL be `404`
- **AND** the JSON-RPC error code SHALL be `-32001`

#### Scenario: The refusal costs no server construction

- **GIVEN** an instrumented server factory that counts its invocations
- **WHEN** several non-`initialize` requests carrying unknown `mcp-session-id` values are made
- **THEN** the factory invocation count SHALL NOT increase

#### Scenario: An initialize request still establishes a session

- **WHEN** an `initialize` request arrives carrying an `mcp-session-id` the manager does not hold
- **THEN** a new session SHALL be established and its id returned in the response header
- **AND** subsequent requests carrying the new id SHALL be served normally

#### Scenario: A known session is unaffected

- **GIVEN** a live transport registered under its `mcp-session-id`
- **WHEN** a non-`initialize` request carrying that id arrives
- **THEN** it SHALL be handled exactly as before this requirement, with no change in status or payload
