## ADDED Requirements

### Requirement: The opencode installer MUST verify its config detection and import rewrite

The opencode plugin installer SHALL detect an existing Rembric MCP configuration by locating the `rembric` key within the `mcp` object of `opencode.json` (not by matching the substring `"rembric"` anywhere in the file). After rewriting the dev-time relative dotenv import to the installed absolute path, the installer SHALL assert the rewritten import is present in the installed plugin file and SHALL abort with a clear error when the assertion fails, instead of installing a plugin that cannot load.

#### Scenario: Unrelated `"rembric"` string elsewhere in opencode.json

- **WHEN** `opencode.json` contains the string `"rembric"` outside the `mcp` object (e.g. an MCP server named `rembric-foo` or an unrelated key) and no `mcp.rembric` entry
- **THEN** the installer SHALL treat Rembric as NOT configured and print the config snippet as on a fresh install

#### Scenario: Import rewrite no-ops due to source drift

- **WHEN** the `sed` rewrite of the dotenv import produces a file that does not reference the installed dotenv path
- **THEN** the installer SHALL exit non-zero with an error naming the failed rewrite, and SHALL NOT leave the broken plugin file installed
