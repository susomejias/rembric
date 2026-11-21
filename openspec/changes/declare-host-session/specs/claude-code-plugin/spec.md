## ADDED Requirements

### Requirement: The Claude Code hooks SHALL maintain the host binding

The Claude Code hooks SHALL publish and remove the host binding that "Clients that reach MCP through the stdio bridge MUST publish a host binding naming their live session" (`plugin-session-protocol`) specifies, through `rembric_host_binding_publish` and `rembric_host_binding_remove` in `apps/plugin/scripts/_api.sh`:

- `session-start.sh` (matcher `startup|resume|clear|fork`) and `post-compact.sh` (matcher `compact`) SHALL publish the stdin `session_id` for the host process, before any HTTP request and whether or not a project resolves.
- `session-end.sh` SHALL remove the host's binding when it names the ending session, before its project check, so it runs even when the session has no project.

#### Scenario: Every SessionStart source publishes

- **WHEN** Claude Code fires `SessionStart` with `session_id` `S` and any of the sources `startup`, `resume`, `clear`, `fork` or `compact`
- **THEN** the handler that `hooks.json` wires for that source SHALL leave `~/.cache/rembric/host-sessions/<host pid>.json` naming `S`

#### Scenario: SessionEnd after a /clear keeps the new session's binding

- **GIVEN** the host's binding already names the new session `S2`
- **WHEN** `SessionEnd` fires for the old session `S1`
- **THEN** the binding SHALL still name `S2`
