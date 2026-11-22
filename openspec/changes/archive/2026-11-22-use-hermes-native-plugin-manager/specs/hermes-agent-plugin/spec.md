## MODIFIED Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to the other client manifest directories. The directory SHALL contain `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh` and `README.md`, and MAY contain a nested Python `tests/` directory. Native Hermes SHALL own installation of this source subdirectory; Rembric SHALL NOT maintain a three-file copy whitelist or a second packaging path. Maintenance scripts SHALL delegate distribution to the native CLI while retaining recognized legacy MCP repair.

#### Scenario: Plugin tree contains the five top-level files

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.hermes-plugin/` SHALL contain `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, and `README.md`
- **AND** Python test sources MAY live in its nested `tests/` directory
- **AND** native installation MAY ship that subtree without a Rembric file-copy whitelist

#### Scenario: Plugin subtree is natively installable

- **WHEN** Hermes installs `susomejias/rembric/apps/plugin/.hermes-plugin`
- **THEN** the installed plugin SHALL retain manifest name `rembric` and the unified plugin version
- **AND** Rembric SHALL NOT promise that scripts/tests are excluded from the native-installed subtree

### Requirement: Version coupling with other client manifests

The `version` in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL remain managed by the single unified `plugin` release-please component covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`, via its `extra-files` updater. All five clients SHALL share that version. There SHALL be no separate Hermes release component, node-workspace cascade or registry publication introduced by this change. Contributor guidance SHALL retain the two-track server/plugin model. Hermes SHALL obtain provider updates through native source tracking rather than repeated file-copy installer fetches; its MCP bridge and exact pins SHALL retain their separate existing contract.

#### Scenario: A Hermes-only change bumps the unified plugin component

- **WHEN** a `fix:` commit changes only the Hermes subtree
- **THEN** release-please SHALL update all plugin carriers together, without rebuilding the server or creating a separate Hermes tag

#### Scenario: A shared-bin change bumps the one plugin version

- **WHEN** a `feat:` commit modifies `apps/plugin/mcp-bridge/`
- **THEN** the single plugin version SHALL move for all clients
- **AND** native Hermes provider distribution SHALL not silently change a complete current MCP pin

#### Scenario: A change to a registry-published client still bumps Hermes's carrier

- **WHEN** only Pi changes
- **THEN** Hermes's version carrier SHALL still move in the unified plugin release, with client-specific change attribution

## REMOVED Requirements

### Requirement: Distribution via curl-installer

**Reason**: Native source tracking replaces file copying and fetching.

**Migration**: Use the canonical root TUI. Copied installs require an explicit operator backup/move-aside and native reinstall; no automatic force/adopt operation.

### Requirement: Uninstall via local script

**Reason**: Native removal owns the complete managed directory and plugin-selection cleanup rather than a three-file whitelist.

**Migration**: The canonical root TUI delegates to `hermes plugins remove rembric`; a retained local wrapper SHALL be only a native adapter, not a parallel deletion backend.

### Requirement: User documentation

**Reason**: Native distribution replaces copied-file installation and the extra bare-name install/enable steps; complementary provider/bridge guidance remains required.

**Migration**: Follow the replacement native distribution documentation requirement below.

## ADDED Requirements

### Requirement: Hermes native distribution contract

Hermes installation SHALL delegate to `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable`, update to `hermes plugins update rembric`, and uninstall to `hermes plugins remove rembric`. The canonical root TUI SHALL remain the primary entry point. No file-copy fallback, automatic `adopt`, forced replacement or scan/dependency-consent bypass SHALL be added. Native failures SHALL propagate.

#### Scenario: Fresh native installation

- **WHEN** an operator consents to native install with no existing target
- **THEN** Hermes SHALL own installation and source metadata for `rembric`
- **AND** Rembric SHALL NOT copy provider files itself

#### Scenario: Native update failure

- **WHEN** the native update command fails
- **THEN** Rembric SHALL return failure without reporting successful installation or executing legacy MCP repair

### Requirement: Copied installs require explicit operator transition

Native update/removal SHALL require canonical unpinned source metadata and a non-linked target. Explicit update MAY instead migrate a recognized legacy Rembric copy after separate interactive confirmation that Hermes gateway/CLI sessions and automatic restarts are stopped. Ordinary `--yes` SHALL NOT grant migration consent. Recognition SHALL require the old regular manifest/provider/README files, Rembric manifest identity and provider class, with no source record or Git metadata. Unknown, linked, foreign-source, pinned, malformed or inconsistent targets SHALL remain refused. The adapter SHALL inspect processes conservatively and refuse activity or unavailable inspection; it SHALL NOT stop/restart Hermes. The operator SHALL keep Hermes stopped throughout migration. A verified private full backup outside plugin discovery SHALL precede moving the old directory aside. Native install SHALL own new files; old unknown files SHALL remain in backup, not be overlaid. Failed installation or verification SHALL restore the previous directory/configuration and retain evidence only when no native publication journal remains, dependency selection is unchanged and Hermes remains stopped. Otherwise it SHALL preserve the backup and migration lock, report manual recovery required, and never restore a tree that a pending native journal could subsequently delete. Concurrent migration SHALL be refused. No force/adopt or alternate copy-install backend SHALL be introduced.

#### Scenario: Copied directory contains unknown local data

- **WHEN** explicit update encounters a recognized legacy Rembric copy with an operator file and the stopped-host operator confirms migration
- **THEN** it SHALL retain the entire old directory in a verified private backup outside plugins and delegate installation to Hermes
- **AND** it SHALL verify native source metadata before success without overwriting the new provider with old files

#### Scenario: Migration is not unattended

- **WHEN** migration lacks its specific interactive confirmation, Hermes is active, inspection fails, or another migration holds the lock
- **THEN** no plugin or configuration mutation SHALL occur, even with ordinary `--yes`

#### Scenario: Native migration fails

- **WHEN** native installation fails or returns success without valid canonical source metadata, with no pending publication, changed dependency selection or renewed activity
- **THEN** the adapter SHALL return failure, restore the old directory and configuration, retain its backup, and omit success/restart claims

#### Scenario: Native recovery remains pending

- **WHEN** native publication remains pending, dependency selection changes or Hermes starts during failure recovery
- **THEN** the adapter SHALL preserve the backup and lock, require manual recovery with Hermes stopped, and SHALL NOT restore over uncertain native state

#### Scenario: Native pinned or foreign install

- **WHEN** a native source record is pinned or does not match the canonical source
- **THEN** Rembric SHALL refuse mutation rather than silently unpin or replace the source

### Requirement: Native ownership and conservative state preservation

The user-approved native contract SHALL permit Hermes to select/reset `memory.provider`, manage plugin selection/grants and remove the entire native-managed plugin directory. Unrelated config values, MCP settings, exact bridge pins, credentials outside that directory and `.rembric` project markers SHALL remain preserved. Rembric SHALL NOT perform a general config rewrite. An untracked/linked directory SHALL NOT be silently removed. Repeated uninstall SHALL be a successful no-op only when both target and native source record are absent; inconsistent state SHALL fail visibly.

#### Scenario: Native uninstall of a managed install

- **WHEN** a consenting operator uninstalls a native-managed Rembric plugin
- **THEN** Hermes SHALL own whole-directory removal and selection/grant cleanup
- **AND** unrelated settings, MCP bridge configuration, credentials and project markers SHALL remain intact

#### Scenario: Already absent installation

- **WHEN** uninstall finds neither a Rembric directory nor its native source record
- **THEN** it SHALL return success without invoking a failing native removal

### Requirement: Recognized legacy MCP repair survives native distribution

After successful native update, the existing recognition and backup rules for legacy MCP repair SHALL remain available. The recognized legacy transport block and incomplete bridge block SHALL receive the existing repair, with a backup written before mutation. Unrecognized/current MCP blocks SHALL remain untouched. This change SHALL NOT broaden repair patterns, replace the MCP transport, alter current bridge pins or introduce new tool wiring.

#### Scenario: Recognized legacy block on native update

- **WHEN** native update succeeds and the existing legacy migration recognizes the MCP block
- **THEN** the existing backup-and-repair behavior SHALL run
- **AND** unrelated configuration SHALL be preserved

#### Scenario: Current pinned MCP block

- **WHEN** native install/update/remove encounters a complete current MCP block
- **THEN** its package pin and explicit environment mappings SHALL remain unchanged

### Requirement: Native distribution documentation replaces obsolete instructions

The distribution portions of user documentation SHALL lead with the canonical TUI and show native CLI commands only as manual/advanced fallback. They SHALL describe the supported default source, rejected local/ref operations, explicit copied-install backup/reinstall, Hermes-owned activation/removal effects and credential prompts. The old claim that Git-subdirectory installs are rejected SHALL be removed. The plugin README SHALL retain credential prompt/storage explanations, a combined provider/MCP configuration example, slug-resolution and troubleshooting sections. The first configuration example SHALL pair lifecycle provider and complementary tool bridge. Every MCP block in the plugin README and `docs/agents.md` SHALL use an exact pinned `@rembric/mcp-bridge` version, only `-y` and the package specifier in args, explicit environment mappings for server/token/slug, and no URL/header/allow-http arguments, floating tags or obsolete bridge paths. Per-directory `.rembric` SHALL retain precedence over the documented default slug. Removed credential mechanisms (`~/.rembric/.env`, `get_config_schema`, `save_config`, `~/.hermes/rembric.json`) SHALL not be documented. Root/plugin READMEs SHALL retain Hermes client links. Existing credential and slug guidance SHALL remain unchanged except for action wording required by native activation. No hand-written CHANGELOG entry SHALL be added.

#### Scenario: Reader follows the installation instructions

- **WHEN** a reader follows the Hermes distribution section
- **THEN** it SHALL use the root TUI first and native subdirectory install as the manual fallback
- **AND** it SHALL NOT instruct copying three files or claim `adopt` can migrate copied installations
