## ADDED Requirements

### Requirement: The bridge MUST generate and forward a stable per-connection bridge instance id

The bridge (`apps/plugin/bin/rembric-bridge.mjs`) SHALL generate a random instance identifier once per process startup (before spawning `mcp-remote`) and write it to a local correlation file at `${TMPDIR:-/tmp}/rembric-bridge-instance/<sanitized-cwd>`, where `<sanitized-cwd>` is the resolved project directory (per the existing `CLAUDE_PROJECT_DIR` > `PWD` > `process.cwd()` precedence chain) with every non-alphanumeric character replaced by `_`. If a file already exists at that path (e.g. from a prior bridge process for the same directory), the bridge SHALL overwrite it with its own newly-generated instance id — the file always reflects the most recently started bridge for that directory, not a history of all of them.

The bridge SHALL forward this instance id as an additional HTTP header, `X-Rembric-Bridge-Instance`, via `mcp-remote`'s existing `--header` flag, alongside the existing `Authorization` header. This value is fixed for the bridge process's entire lifetime — it is generated once at startup and never re-read or refreshed, unlike the underlying Rembric session id (which can change multiple times over a single bridge process's life, e.g. across `/clear` or `/resume`, without the bridge itself restarting).

Failure to write the correlation file (e.g. an unwritable `$TMPDIR`) SHALL NOT abort the bridge or block the MCP connection — the bridge SHALL proceed without sending the header, identically to today's behavior before this requirement existed.

This bridge is shared unmodified by the Codex CLI plugin and by the opencode plugin's stdio-transport reuse (per the existing "The bridge MUST pin the `mcp-remote` version" requirement's precedent); both inherit this behavior with no client-specific spec text needed. Client-side session-lifecycle code (Claude Code and Codex hook scripts, the opencode plugin, the Hermes provider) reads the same correlation file to tag its own HTTP lifecycle calls — that read-side behavior is specified in `plugin-session-protocol/spec.md`'s "Each client MUST tag its session-lifecycle HTTP calls with a bridge instance id read from the local correlation file" requirement, not here; this requirement governs only the bridge's write-and-forward side.

#### Scenario: The bridge writes a fresh instance id file at startup

- **WHEN** `rembric-bridge.mjs` starts for project directory `/repo`
- **THEN** it SHALL write a new random instance id to `${TMPDIR:-/tmp}/rembric-bridge-instance/<sanitized "/repo">`, overwriting any existing content at that path

#### Scenario: The instance id header is sent unchanged for the whole connection

- **GIVEN** the bridge has started and written its instance id
- **WHEN** the underlying Rembric session changes (e.g. the user runs `/clear` in Claude Code) without the bridge process restarting
- **THEN** the `X-Rembric-Bridge-Instance` header value on subsequent MCP requests SHALL remain the same as at bridge startup — it is not tied to, and does not change with, the current session

#### Scenario: An unwritable correlation directory does not block the connection

- **GIVEN** `$TMPDIR` (or its fallback `/tmp`) is not writable
- **WHEN** the bridge starts
- **THEN** it SHALL proceed to spawn `mcp-remote` and connect without the `X-Rembric-Bridge-Instance` header, exactly as it would have before this requirement existed
