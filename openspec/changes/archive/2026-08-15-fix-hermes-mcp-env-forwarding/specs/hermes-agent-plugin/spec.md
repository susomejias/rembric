## MODIFIED Requirements

### Requirement: Hermes MCP bridge configuration

The documented and updater-generated `mcp_servers.rembric` entry SHALL use an exact `@rembric/mcp-bridge` pin, pass no URL or bearer argument, explicitly map the three persisted Rembric variables into the MCP subprocess, and set `enabled: true`:

```yaml
rembric:
  command: npx
  args: ['-y', '@rembric/mcp-bridge@<plugin-version>']
  env:
    REMBRIC_SERVER_URL: ${REMBRIC_SERVER_URL}
    REMBRIC_API_TOKEN: ${REMBRIC_API_TOKEN}
    REMBRIC_PROJECT_SLUG: ${REMBRIC_PROJECT_SLUG}
  enabled: true
```

`${HERMES_HOME:-~/.hermes}/.env` persists values for the provider, but Hermes MCP subprocesses SHALL NOT be documented as inheriting those values implicitly.

On update, the installer SHALL back up and replace only the already-recognized legacy `mcp-remote` block or the exact incomplete npx bridge block it previously emitted. It SHALL leave canonical and custom Rembric blocks byte-for-byte unchanged and print the canonical block when manual configuration is required.

#### Scenario: Incomplete updater bridge entry is repaired

- **GIVEN** an exact-pinned npx bridge entry with no `env` or `enabled` field
- **WHEN** the Hermes updater runs
- **THEN** it SHALL preserve a backup and replace the entry with the canonical block

#### Scenario: Custom bridge entry is preserved

- **GIVEN** a Rembric MCP entry with custom command, args, environment, or extra settings
- **WHEN** the Hermes updater runs
- **THEN** it SHALL not modify the config and SHALL print the canonical manual fallback

#### Scenario: Canonical bridge entry is unchanged

- **GIVEN** the canonical entry is already present
- **WHEN** the Hermes updater runs
- **THEN** it SHALL make no config write or backup

### Requirement: Bridge compatibility documentation distinguishes support from host verification

`apps/plugin/mcp-bridge/README.md` SHALL describe the bridge as a standard stdio MCP transport replacement for hosts that previously used `mcp-remote`. Its compatibility table SHALL retain host-level evidence where it exists and label unmeasured hosts as supported but not host-verified; it SHALL not present unmeasured host compatibility as a recorded run.

#### Scenario: Compatibility table is evidence-bounded

- **WHEN** the compatibility table is read
- **THEN** Claude Code and the real Hermes report retain their recorded verification context
- **AND** opencode, Codex CLI, and Windows are not described as host-verified without a recorded run
- **AND** Pi remains not applicable because it has its own in-process MCP client
