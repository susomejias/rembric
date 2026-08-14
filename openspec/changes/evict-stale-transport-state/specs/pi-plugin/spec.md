## ADDED Requirements

### Requirement: The extension MUST recover from a terminated MCP session by re-initializing exactly once

The extension is the MCP client — Pi ships none — and it initializes exactly once, when the plugin activates. Its request helper throws on every non-2xx response, so a single `404` naming a session the server no longer holds is terminal for the life of the Pi process: every subsequent `tools/call` fails and no code path re-establishes the session. That is a non-conformance with the Streamable HTTP transport independently of when it becomes reachable, and the server's transport-state eviction (`sessions` capability) is what makes it reachable.

On a `404` response to a request that carried an `mcp-session-id`, the extension SHALL discard the stored session id, perform `initialize` and the initialized notification again, and retry the original request exactly once. A failure of the retry SHALL surface as an error; the extension SHALL NOT loop.

The recovery SHALL be scoped to `404` alone. A `401`, `403`, `429` or any `5xx` SHALL continue to surface as an error with no re-initialize and no retry, so an authentication, authorization or capacity failure is never masked, and a request that may have been applied is never replayed.

Retrying a write-bearing tool call is admissible here for one specific reason, which SHALL hold: the `404` is produced at the transport boundary before any tool handler runs, so the refused call cannot have been partially applied.

The extension SHALL NOT re-register its tools after recovering. The host already holds the registration from activation, and the rebuilt connection exposes the same tool surface.

#### Scenario: A tool call after the server dropped the session succeeds on the retry

- **GIVEN** an activated extension whose MCP session the server no longer holds
- **WHEN** the extension invokes a registered tool and the server answers `404`
- **THEN** the extension SHALL send exactly one further `initialize`
- **AND** SHALL retry the original `tools/call` on the new session
- **AND** SHALL return the tool's result to the host as if nothing had happened

#### Scenario: A second failure is reported, not retried again

- **GIVEN** a server that answers `404` to every request including the retry
- **WHEN** the extension invokes a registered tool
- **THEN** exactly one re-initialize and one retry SHALL be attempted
- **AND** the failure SHALL surface to the host as an error

#### Scenario: An authentication failure is never re-initialized

- **GIVEN** a server that answers `401`
- **WHEN** the extension invokes a registered tool
- **THEN** no `initialize` SHALL be sent
- **AND** the error SHALL surface to the host unchanged

#### Scenario: Recovery does not re-register tools

- **GIVEN** a recovery triggered by a `404`
- **WHEN** the retry succeeds
- **THEN** no additional tool registration call SHALL be made against the host
