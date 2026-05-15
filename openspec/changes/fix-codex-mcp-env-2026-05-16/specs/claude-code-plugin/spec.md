## MODIFIED Requirements

### Requirement: Plugin manifest

The plugin SHALL be packaged in this monorepo at `plugin/` with the manifest at `plugin/.claude-plugin/plugin.json`. The manifest contract is unchanged in shape; only the path to its MCP config moves so that each client's MCP config now lives next to its plugin manifest (symmetric with the new Codex layout introduced in this change).

#### Scenario: Required manifest fields

- **WHEN** `plugin/.claude-plugin/plugin.json` is loaded
- **THEN** the manifest declares `name: "rembric"` for namespacing of commands (`/rembric:*`) and agent listings
- **AND** it declares exactly two `userConfig` fields: `server_url` (string, required) and `api_token` (string, required, sensitive)
- **AND** it SHALL NOT declare a `project_slug` userConfig field
- **AND** it declares `mcpServers: "./.claude-plugin/mcp.json"` (was `"./mcp.json"`) and SHALL NOT inline server configuration in `plugin.json`

### Requirement: MCP server declaration

The Claude Code plugin's MCP server config SHALL live at `plugin/.claude-plugin/mcp.json`, sibling to the manifest. Its contents (command, args, env) are unchanged; only the file location moves.

#### Scenario: MCP file path and bridge invocation

- **WHEN** `plugin/.claude-plugin/mcp.json` is loaded
- **THEN** it declares a single MCP server entry named `rembric`
- **AND** the server entry uses `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]`, spawning the local bridge as a stdio MCP server
- **AND** the bridge receives `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` via `env`, sourced from `${user_config.server_url}` and `${user_config.api_token}` respectively
- **AND** the plugin SHALL NOT use a direct `type: "http"` MCP server entry; the bridge mediates traffic so that the URL can be path-scoped with the slug read from `.rembric` at session start
