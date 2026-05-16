## MODIFIED Requirements

### Requirement: MCP bridge contract

- The plugin SHALL ship `plugin/bin/rembric-bridge.mjs`, a Node ≥18 script that acts as a stdio MCP server for Claude Code while forwarding to Rembric over HTTP.
- The bridge SHALL resolve the project directory from a precedence chain of environment variables, in this order: `CLAUDE_PROJECT_DIR`, then `PWD`, then `process.cwd()`. The chain SHALL skip empty-string values (use `||` not `??` semantics) so that an explicitly-set-to-empty env var falls through cleanly. This makes the bridge reusable from non-Claude-Code clients (notably Codex) that propagate the user's shell working directory via `PWD` rather than Claude's `CLAUDE_PROJECT_DIR` convention.
- The bridge SHALL look for `${projectDir}/.rembric`. If the file exists, the bridge SHALL parse it as dotenv-style `KEY=VALUE` lines (with `#` line comments and optional matched-quote stripping) and read `PROJECT_SLUG`. If `PROJECT_SLUG` is defined and matches `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, the bridge SHALL construct the URL `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped).
- If `.rembric` is missing, unparseable, lacks `PROJECT_SLUG`, or `PROJECT_SLUG` does not match the slug regex, the bridge SHALL write a one-line stderr diagnostic and fall back to path-less `${REMBRIC_SERVER_URL}/mcp`. The bridge SHALL NOT abort in this case — the session continues with global scope (or whatever pinning the agent later does).
- The bridge SHALL delegate the actual stdio↔Streamable-HTTP-MCP transport to `npx -y mcp-remote@latest`, injecting `Authorization: Bearer ${REMBRIC_API_TOKEN}` on every request and passing the `--allow-http` flag so that plain-HTTP LAN deployments (e.g. `http://192.168.x.y:8787`) are accepted. For HTTPS deployments the flag is a no-op.
- The bridge SHALL NOT parse, rewrite, or inspect MCP frames beyond what `mcp-remote` itself does. It is purely a URL-building entrypoint.
- The bridge SHALL write one diagnostic line to stderr at startup of the form `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`, where `<source>` is exactly one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()` — naming which step of the precedence chain produced the resolved directory. This aids debugging via `claude --debug` and `codex` log inspection.
- If `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are missing, the bridge SHALL exit non-zero with a clear stderr message instructing the user to configure the plugin.
- The bridge SHALL forward the child process's exit code; if the child terminates from a signal, the bridge SHALL re-raise that signal in its own process.

#### Scenario: Claude Code passes CLAUDE_PROJECT_DIR — bridge picks it

- **WHEN** the bridge starts under Claude Code with `CLAUDE_PROJECT_DIR=/home/u/proj` set
- **THEN** the bridge SHALL resolve `projectDir = /home/u/proj`
- **AND** the stderr diagnostic SHALL include `(from CLAUDE_PROJECT_DIR)`
- **AND** the bridge SHALL look for `/home/u/proj/.rembric`

#### Scenario: Codex sets PWD, no CLAUDE_PROJECT_DIR — bridge picks PWD

- **WHEN** the bridge starts under Codex with `CLAUDE_PROJECT_DIR` unset, `PWD=/home/u/proj`, and `process.cwd()=/Users/u/.codex/plugins/cache/rembric/rembric/0.2.2`
- **THEN** the bridge SHALL resolve `projectDir = /home/u/proj`
- **AND** the stderr diagnostic SHALL include `(from PWD)`
- **AND** the bridge SHALL look for `/home/u/proj/.rembric`

#### Scenario: No env vars set — bridge falls back to process.cwd()

- **WHEN** the bridge starts with `CLAUDE_PROJECT_DIR` unset and `PWD` unset
- **THEN** the bridge SHALL resolve `projectDir = process.cwd()`
- **AND** the stderr diagnostic SHALL include `(from process.cwd())`

#### Scenario: Empty-string env values are skipped

- **WHEN** the bridge starts with `CLAUDE_PROJECT_DIR=""` and `PWD=/home/u/proj`
- **THEN** the bridge SHALL skip the empty `CLAUDE_PROJECT_DIR` (not treat it as "set")
- **AND** the bridge SHALL resolve `projectDir = /home/u/proj`
- **AND** the stderr diagnostic SHALL include `(from PWD)`
