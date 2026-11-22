## MODIFIED Requirements

### Requirement: Version coupling with other client manifests

The `version` in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL remain managed by the single unified `plugin` release-please component covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`, via its `extra-files` updater. All five clients SHALL share that version. There SHALL be no separate Hermes release component, node-workspace cascade or registry publication introduced by this change. Contributor guidance SHALL retain the two-track server/plugin model. Hermes SHALL obtain provider updates through native source tracking rather than repeated file-copy installer fetches; its MCP bridge configuration SHALL retain its separate contract, and the bridge files that configuration runs SHALL be refreshed by the TUI installer, not by native source tracking.

#### Scenario: A Hermes-only change bumps the unified plugin component

- **WHEN** a `fix:` commit changes only the Hermes subtree
- **THEN** release-please SHALL update all plugin carriers together, without rebuilding the server or creating a separate Hermes tag

#### Scenario: A shared-bin change bumps the one plugin version

- **WHEN** a `feat:` commit modifies `apps/plugin/mcp-bridge/`
- **THEN** the single plugin version SHALL move for all clients
- **AND** native Hermes provider distribution SHALL not silently change a complete current `mcp_servers.rembric` entry

#### Scenario: A change to a registry-published client still bumps Hermes's carrier

- **WHEN** only Pi changes
- **THEN** Hermes's version carrier SHALL still move in the unified plugin release, with client-specific change attribution

### Requirement: Hermes MCP bridge configuration

The documented and updater-generated `mcp_servers.rembric` entry SHALL use `command: node` and `args: ['<home>/.config/rembric/bin/cli.mjs']`, where `<home>` is the user's home directory written as an absolute path, pass no URL or bearer argument, explicitly map `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`, and `REMBRIC_PROJECT_SLUG` into the MCP subprocess, and set `enabled: true`. `${HERMES_HOME:-~/.hermes}/.env` persists provider values, but MCP subprocesses SHALL NOT be documented as inheriting them implicitly.

The bridge files (`cli.mjs`, `bridge.mjs`, `slug.mjs`, `rembric-host-binding.mjs`, `rembric-project.mjs` and `rembric-dotenv.mjs`) SHALL be placed in `~/.config/rembric/bin/` by the TUI installer, because a native Hermes install checks out only `apps/plugin/.hermes-plugin` and never contains `apps/plugin/mcp-bridge/`. The entry SHALL NOT point into the Hermes plugin directory.

On update, the installer SHALL back up and replace only the `mcp_servers.rembric` shapes it wrote itself: its recognized legacy `mcp-remote` block, the exact incomplete npx bridge block it previously emitted (`command: npx`, `args: ['-y', '@rembric/mcp-bridge@<x.y.z>']`, no `env` or `enabled`), and the complete npx bridge block it previously emitted (`command: npx`, `args: ['-y', '@rembric/mcp-bridge@<x.y.z>']`, an `env` map of exactly `REMBRIC_SERVER_URL: ${REMBRIC_SERVER_URL}`, `REMBRIC_API_TOKEN: ${REMBRIC_API_TOKEN}` and `REMBRIC_PROJECT_SLUG: ${REMBRIC_PROJECT_SLUG}`, and `enabled: true`, with no other keys). Each SHALL be replaced with the canonical `node` block above, keeping the same `env` mappings and `enabled: true`. The replacement SHALL run only when every bridge file is present in `~/.config/rembric/bin/`; when any is missing, `config.yaml` SHALL stay byte-identical, no backup SHALL be written, and the installer SHALL print a hint to re-run the TUI installer. A backup SHALL be written once before the first replacement and an existing backup SHALL NOT be overwritten. It SHALL leave canonical and custom Rembric blocks byte-for-byte unchanged and print the canonical block when manual configuration is required.

#### Scenario: Incomplete updater bridge entry is repaired

- **GIVEN** an exact-pinned npx bridge entry with no `env` or `enabled` field
- **AND** every bridge file is present in `~/.config/rembric/bin/`
- **WHEN** the Hermes updater runs
- **THEN** it SHALL preserve a backup and replace the entry with the canonical block

#### Scenario: Custom or canonical bridge entries are preserved

- **GIVEN** a custom or canonical Rembric MCP entry
- **WHEN** the Hermes updater runs
- **THEN** a custom entry SHALL remain unchanged and print the manual fallback; a canonical entry SHALL make no config write or backup

#### Scenario: Complete installer-written npx entry is migrated to the node form

- **GIVEN** an `mcp_servers.rembric` entry with `command: npx`, `args: ['-y', '@rembric/mcp-bridge@<x.y.z>']`, the three `env` mappings and `enabled: true`, and no other keys
- **AND** every bridge file is present in `~/.config/rembric/bin/`
- **WHEN** the Hermes updater runs
- **THEN** a backup SHALL exist before `config.yaml` is changed
- **AND** the entry SHALL become `command: node` with `args: ['<home>/.config/rembric/bin/cli.mjs']`, the same three `env` mappings and `enabled: true`
- **AND** every line of `config.yaml` outside that entry SHALL be unchanged

#### Scenario: Legacy mcp-remote entry is migrated to the node form

- **GIVEN** the recognized legacy `mcp-remote` entry
- **AND** every bridge file is present in `~/.config/rembric/bin/`
- **WHEN** the Hermes updater runs
- **THEN** it SHALL preserve a backup and replace the entry with the canonical `node` block

#### Scenario: Migration waits for the bridge files

- **GIVEN** an installer-written npx entry, complete or incomplete
- **AND** `~/.config/rembric/bin/cli.mjs` or another bridge file is absent
- **WHEN** the Hermes updater runs
- **THEN** `config.yaml` SHALL be byte-identical and no backup SHALL be written
- **AND** the updater SHALL print a hint to re-run the TUI installer

#### Scenario: A customised npx entry is preserved

- **GIVEN** an `mcp_servers.rembric` entry with `command: npx` and `args: ['-y', '@rembric/mcp-bridge@<x.y.z>']` that carries a key or `env` value the installer never writes
- **AND** every bridge file is present in `~/.config/rembric/bin/`
- **WHEN** the Hermes updater runs
- **THEN** `config.yaml` SHALL be byte-identical and no backup SHALL be written
- **AND** the updater SHALL print the canonical block as the manual fallback

### Requirement: Native ownership and conservative state preservation

The user-approved native contract SHALL permit Hermes to select/reset `memory.provider`, manage plugin selection/grants and remove the entire native-managed plugin directory. Unrelated config values, MCP settings, credentials outside that directory and `.rembric` project markers SHALL remain preserved. The only MCP rewrite permitted is the update migration of the installer-written `mcp_servers.rembric` shapes that the Hermes MCP bridge configuration requirement names; a user-customised block SHALL remain preserved. Rembric SHALL NOT perform a general config rewrite. An untracked/linked directory SHALL NOT be silently removed. Repeated uninstall SHALL be a successful no-op only when both target and native source record are absent; inconsistent state SHALL fail visibly.

#### Scenario: Native uninstall of a managed install

- **WHEN** a consenting operator uninstalls a native-managed Rembric plugin
- **THEN** Hermes SHALL own whole-directory removal and selection/grant cleanup
- **AND** unrelated settings, MCP bridge configuration, credentials and project markers SHALL remain intact

#### Scenario: Already absent installation

- **WHEN** uninstall finds neither a Rembric directory nor its native source record
- **THEN** it SHALL return success without invoking a failing native removal

#### Scenario: A user-customised MCP block survives update

- **GIVEN** an `mcp_servers.rembric` block whose shape the installer never wrote
- **WHEN** the Hermes update runs
- **THEN** that block SHALL remain byte-identical

### Requirement: Recognized legacy MCP repair survives native distribution

After successful native update, the existing recognition and backup rules for legacy MCP repair SHALL remain available. The recognized legacy transport block, the incomplete bridge block and the complete installer-written npx bridge block SHALL receive the repair the Hermes MCP bridge configuration requirement defines, with a backup written before mutation, once the bridge files are present. Unrecognized, user-customised and canonical `node` MCP blocks SHALL remain untouched. Native distribution SHALL NOT broaden repair patterns beyond those installer-written shapes, replace the MCP transport or introduce new tool wiring.

#### Scenario: Recognized legacy block on native update

- **WHEN** native update succeeds and the existing legacy migration recognizes the MCP block
- **THEN** the existing backup-and-repair behavior SHALL run
- **AND** unrelated configuration SHALL be preserved

#### Scenario: Current pinned MCP block

- **WHEN** native install/update/remove encounters a complete canonical `node` MCP block
- **THEN** its command, args and explicit environment mappings SHALL remain unchanged

#### Scenario: Installer-written npx block on native update

- **GIVEN** the complete npx bridge block the installer previously wrote
- **AND** every bridge file is present in `~/.config/rembric/bin/`
- **WHEN** native update succeeds
- **THEN** the block SHALL be backed up and replaced with the canonical `node` block
- **AND** its explicit environment mappings SHALL be unchanged

### Requirement: Native distribution documentation replaces obsolete instructions

The distribution portions of user documentation SHALL lead with the canonical TUI and show native CLI commands only as manual/advanced fallback. They SHALL describe the supported default source, rejected local/ref operations, explicit copied-install backup/reinstall, Hermes-owned activation/removal effects and credential prompts. The old claim that Git-subdirectory installs are rejected SHALL be removed. The plugin README SHALL retain credential prompt/storage explanations, a combined provider/MCP configuration example, slug-resolution and troubleshooting sections. The first configuration example SHALL pair lifecycle provider and complementary tool bridge. Every Hermes `mcp_servers.rembric` block in the plugin README and `docs/agents.md` SHALL use `command: node` with a single argument, the absolute path of `cli.mjs` under `~/.config/rembric/bin/` with the home directory shown as a placeholder, explicit environment mappings for server/token/slug, and no `npx` command, package specifier, URL/header/allow-http arguments or obsolete bridge paths, and SHALL state that the TUI installer places the bridge files. Per-directory `.rembric` SHALL retain precedence over the documented default slug. Removed credential mechanisms (`~/.rembric/.env`, `get_config_schema`, `save_config`, `~/.hermes/rembric.json`) SHALL not be documented. Root/plugin READMEs SHALL retain Hermes client links. Existing credential and slug guidance SHALL remain unchanged except for action wording required by native activation. No hand-written CHANGELOG entry SHALL be added.

#### Scenario: Reader follows the installation instructions

- **WHEN** a reader follows the Hermes distribution section
- **THEN** it SHALL use the root TUI first and native subdirectory install as the manual fallback
- **AND** it SHALL NOT instruct copying three files or claim `adopt` can migrate copied installations

#### Scenario: Reader copies the Hermes MCP block

- **WHEN** a reader copies the Hermes `mcp_servers.rembric` block from the plugin README or `docs/agents.md`
- **THEN** it SHALL use `command: node` with the absolute path of `cli.mjs` under `~/.config/rembric/bin/` as its only argument, the three `env` mappings and `enabled: true`
- **AND** it SHALL contain no `npx` or `@rembric/mcp-bridge`
- **AND** the surrounding text SHALL say the TUI installer places the bridge files
