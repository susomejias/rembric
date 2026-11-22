## ADDED Requirements

### Requirement: The Codex hooks SHALL maintain the host binding

The shared hook scripts SHALL publish and remove the Codex host's binding exactly as they do for Claude Code (`plugin-session-protocol`, "Clients that reach MCP through the stdio bridge MUST publish a host binding naming their live session"):

- `session-start.sh codex-cli` (matcher `startup|resume|clear`) and `post-compact.sh codex-cli` (matcher `compact`) SHALL publish the stdin session id for the host process.
- `session-end.sh codex-cli` SHALL remove the host's binding when it names the ending session. The removal SHALL run before the transcript read and the `/end` request, so the 3-second `SessionEnd` budget cannot skip it.

The binding is what lets the bridge, whose environment Codex clears, declare the session: the bridge needs no environment variable for it.

#### Scenario: Every Codex SessionStart source publishes

- **WHEN** Codex fires `SessionStart` with session id `S` and any of the sources `startup`, `resume`, `clear` or `compact`
- **THEN** the handler that `hooks.codex.json` wires for that source SHALL leave `~/.cache/rembric/host-sessions/<host pid>.json` naming `S`

#### Scenario: SessionEnd removes only the ending session's binding

- **GIVEN** the host's binding names session `S`
- **WHEN** `SessionEnd` fires for `S`
- **THEN** the binding SHALL be removed
- **AND** had it named another session, it SHALL have been kept
