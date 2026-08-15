## Why

Hermes filters the environment of MCP subprocesses. The existing update migration and TUI fallback create a bridge block without its required explicit `env` map, leaving the bridge unable to read its URL or bearer token even though the provider can read `${HERMES_HOME}/.env`.

## What Changes

- Make the Hermes updater replace only its recognized legacy entry and the incomplete bridge entry it previously generated with one canonical bridge block: exact pin, three explicit environment references, and `enabled: true`.
- Preserve custom `mcp_servers.rembric` blocks and back up config before a recognized migration.
- Print and document the same complete block; remove claims of implicit MCP environment inheritance.
- Update the bridge compatibility table to distinguish supported stdio hosts from host-level runs actually recorded.
- Add regression tests for the incomplete update shape, custom no-op, and TUI output.

## Impact

- `apps/plugin/.hermes-plugin/install.sh`
- `apps/plugin/install.sh`, `install.test.ts`
- Hermes docs and the Hermes plugin specification
- No server, database, MCP wire-protocol, or dependency changes.
