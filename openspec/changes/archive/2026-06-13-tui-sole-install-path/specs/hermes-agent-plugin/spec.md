## MODIFIED Requirements

### Requirement: User documentation

The plugin's `README.md` (at `apps/plugin/.hermes-plugin/README.md`) SHALL include, in this order:

1. The **TUI installer** as the primary install/upgrade instruction (the root `install.sh` shim, canonical URL `.../main/install.sh`, or `--agent=hermes`). The per-client manual install — `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` followed by `hermes plugins install rembric` to trigger the `requires_env` prompts — SHALL be retained below under an explicitly-labelled "Manual install" heading, not as the lead instruction.
2. A description of what Hermes prompts for during install (the three `requires_env` vars) and where the answers are persisted (`${HERMES_HOME:-~/.hermes}/.env`).
3. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
4. A short "Project slug resolution" section explaining the four-step cascade in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, `~/.hermes/.env` edited manually after install.

The README SHALL NOT mention `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, or `~/.hermes/rembric.json`. Those mechanisms were removed; documenting them would mislead users into setting up files the plugin ignores.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code, Codex CLI, and opencode, with a link to the plugin README at `apps/plugin/.hermes-plugin/README.md`.

`docs/agents.md` SHALL gain (or retain, after path swap) a "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, leading with the TUI installer and covering install (including the `requires_env` prompt flow as the manual fallback), config, env vars, slug resolution, and a pointer to the plugin README at the new path.

`apps/plugin/README.md` and `apps/plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside the other clients.

#### Scenario: README leads with the TUI, manual curl-installer retained below

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` top-to-bottom
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `curl … install.sh | sh` + `hermes plugins install rembric` flow SHALL appear under an explicit "Manual install" heading

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`
