## MODIFIED Requirements

### Requirement: Per-client install / update / uninstall routing

For opencode, install/update SHALL delegate to its install script and uninstall to its uninstall script. Claude SHALL retain `claude plugin marketplace add https://github.com/susomejias/rembric.git`, `claude plugin install rembric@rembric`, `claude plugin update rembric@rembric` and `claude plugin uninstall rembric@rembric`. Codex SHALL retain marketplace add plus `codex plugin add rembric@rembric`, update via `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`, and removal via `codex plugin remove rembric@rembric`. Pi SHALL retain the unpinned `pi install npm:@rembric/pi` for install and update and `pi remove npm:@rembric/pi` for removal; Git refs SHALL not be applied to that registry artifact.

Hermes SHALL use `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable`, `hermes plugins update rembric` and `hermes plugins remove rembric`, subject to its provenance and unsupported-source guards. Explicit update of a recognized legacy copy SHALL offer the guarded one-time interactive transition to native install instead of native update. Root invocation consent SHALL NOT substitute for migration-specific consent; native installations SHALL continue using native update. All CLI backends SHALL print their commands and execute only with an available executable and interactive confirmation or `--yes`/`-y`. Without consent a headless run SHALL print only; with absent binary even `--yes` SHALL execute nothing. Hermes failure SHALL propagate rather than reporting success. Root execution consent SHALL not add forced replacement or bypass Hermes's dependency/security/capability consent.

For opencode and Hermes install and update, the bridge files (`cli.mjs`, `bridge.mjs`, `slug.mjs`, `rembric-host-binding.mjs`, `rembric-project.mjs` and `rembric-dotenv.mjs`) SHALL be placed in `~/.config/rembric/bin/` from the same ref as that client's other files, before any MCP config switch or migration runs. For opencode its install script places them. For Hermes the TUI places them, because a native Hermes install contains only `apps/plugin/.hermes-plugin`, and it SHALL do so only when the Hermes action itself executes. Each file SHALL be written to a temporary name and renamed into place, with `cli.mjs` last. When placement fails, the TUI SHALL report the failure and SHALL NOT run the Hermes MCP migration, so an existing `mcp_servers.rembric` block stays byte-identical.

#### Scenario: opencode update re-runs its installer

- **WHEN** opencode update is selected
- **THEN** its existing install script SHALL run

#### Scenario: Marketplace client prints CLI commands

- **WHEN** Codex install is selected
- **THEN** marketplace add and plugin add SHALL be printed without copying files

#### Scenario: Marketplace client run-through gated on binary presence

- **WHEN** Claude is absent
- **THEN** its commands SHALL be printed but never executed

#### Scenario: Registry-CLI client install and update are the same unpinned command

- **WHEN** Pi install/update is selected, even under a Git ref
- **THEN** the command SHALL remain `pi install npm:@rembric/pi`

#### Scenario: --yes executes the marketplace command headlessly when the binary is present

- **WHEN** a supported CLI action is selected with `--yes` and the binary is available
- **THEN** that action SHALL execute without the root confirmation prompt

#### Scenario: --yes with an absent binary executes nothing

- **WHEN** a CLI binary is absent and `--yes` is passed
- **THEN** only its command SHALL be printed

#### Scenario: Without --yes a headless run only prints

- **WHEN** headless install/update/uninstall lacks `--yes`
- **THEN** no CLI command SHALL execute, including Hermes

#### Scenario: Hermes update places the bridge files before migrating

- **WHEN** Hermes update executes under a given ref
- **THEN** the six bridge files SHALL be in `~/.config/rembric/bin/`, fetched from that same ref
- **AND** they SHALL be in place before the Hermes MCP migration runs

#### Scenario: A failed bridge placement skips the Hermes migration

- **GIVEN** fetching one of the bridge files fails during a Hermes update
- **WHEN** the TUI handles that failure
- **THEN** it SHALL report the failure
- **AND** the Hermes MCP migration SHALL NOT run, leaving `${HERMES_HOME:-~/.hermes}/config.yaml` byte-identical
- **AND** no temporary download file SHALL remain in `~/.config/rembric/bin/`

### Requirement: Conservative uninstall across clients

Uninstall SHALL preserve unrelated operator settings, credentials outside a plugin-owned directory and `.rembric` markers and report what remains. opencode SHALL retain its existing conservative file-removal behavior. For a native-managed Hermes install, the approved exception SHALL permit Hermes to remove its whole plugin directory and clean up `memory.provider`, plugin selection and grants. Hermes's unrelated MCP settings SHALL remain intact. Copied/untracked, linked, foreign-source, pinned, malformed or inconsistent Hermes targets SHALL be refused without deletion. Already-absent Hermes uninstall SHALL succeed only when both target and source record are absent.

The bridge files in `~/.config/rembric/bin/` SHALL be removed only when nothing can still run them: opencode's plugin file `~/.config/opencode/plugins/rembric.ts` is absent and `${HERMES_HOME:-~/.hermes}/config.yaml` does not reference `cli.mjs` under `~/.config/rembric/bin/`. Either client's uninstall SHALL apply that same rule, Hermes's after its native removal succeeds. Hermes's uninstall preserves the `mcp_servers.rembric` block as an operator MCP setting, so while that block references the bridge the files SHALL remain and the block SHALL keep working; the uninstall report SHALL name the files as kept and say why.

#### Scenario: Uninstall preserves operator config and credentials

- **WHEN** opencode uninstall completes
- **THEN** its MCP config, credentials and project markers SHALL remain intact

#### Scenario: Native Hermes removal has explicit ownership

- **WHEN** a consenting operator removes a verified native-managed Hermes install
- **THEN** Hermes SHALL own directory/selection/grant removal while unrelated settings, MCP configuration and external credentials remain

#### Scenario: Uninstalling one bridge client keeps the bridge for the other

- **GIVEN** both opencode and Hermes are installed and Hermes's `config.yaml` references `cli.mjs` under `~/.config/rembric/bin/`
- **WHEN** either client is uninstalled
- **THEN** the bridge files in `~/.config/rembric/bin/` SHALL remain byte-identical

#### Scenario: Uninstalling the last bridge client removes the bridge

- **GIVEN** opencode's plugin file is absent and Hermes's `config.yaml` does not reference `cli.mjs` under `~/.config/rembric/bin/`
- **WHEN** a client's uninstall completes successfully
- **THEN** the bridge files SHALL be removed from `~/.config/rembric/bin/`
- **AND** `~/.config/rembric/bin/` SHALL be removed if it is then empty

#### Scenario: A preserved Hermes MCP block keeps its bridge

- **GIVEN** opencode's plugin file is absent and Hermes's `config.yaml` has an `mcp_servers.rembric` block that references `cli.mjs` under `~/.config/rembric/bin/`
- **WHEN** a native-managed Hermes install is uninstalled successfully
- **THEN** the block and the bridge files SHALL remain byte-identical
- **AND** the uninstall report SHALL name the bridge files as kept for that block

### Requirement: Per-agent post-install steps are surfaced

After successful installation/update, the installer SHALL print platform-specific next steps, but SHALL omit them on uninstall or native Hermes failure. Codex SHALL retain hook trust via `/hooks` and explicit shell exports, never the removed `plugin_hooks` flag. Claude installation SHALL describe keychain prompts and update SHALL request restart. opencode installation SHALL retain its MCP/environment guidance and update only restart. Pi installation SHALL require shell `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN` with no settings-file alternative and update only restart.

Hermes installation SHALL explain that native `--enable` selects the memory provider and may prompt for missing required credentials; it SHALL not instruct a second bare-name plugin install or generic enable step. Existing complementary MCP wiring guidance SHALL remain. When the bridge is present in `~/.config/rembric/bin/`, it SHALL show the `node` form (`command: node` with the absolute path of `~/.config/rembric/bin/cli.mjs` as its only argument, the three `env` mappings and `enabled: true`). When the bridge is absent (a print-only run, or a run that did not place it), it SHALL show the `npx` form pinned to the exact plugin version, and update guidance SHALL say the current entry keeps working and how to place the bridge, never advise replacing a working entry with one that names a missing file. Hermes update SHALL retain recognized legacy MCP repair guidance and gateway restart without installation-only prompts.

#### Scenario: Codex install prints the hook-trust step

- **WHEN** Codex install runs
- **THEN** `/hooks` trust SHALL be shown without `plugin_hooks`

#### Scenario: Hermes install prints the requires_env + enable + gateway-restart steps

- **WHEN** Hermes installation is offered or succeeds
- **THEN** output SHALL describe native credential prompts/provider selection, complementary MCP wiring and gateway restart, without obsolete bare-name install/enable steps

#### Scenario: Hermes update only reminds to restart the gateway

- **WHEN** native Hermes update succeeds
- **THEN** output SHALL include existing legacy MCP repair guidance and gateway restart, not install-only prompts

#### Scenario: Pi install prints the environment-variable step and no settings-file alternative

- **WHEN** Pi install runs
- **THEN** shell exports SHALL be shown without a settings-file alternative

#### Scenario: Uninstall omits post-install steps

- **WHEN** any uninstall runs
- **THEN** no post-install next steps SHALL be printed

#### Scenario: Hermes MCP wiring guidance shows the node form

- **WHEN** the Hermes install or update guidance prints the `mcp_servers.rembric` block and `~/.config/rembric/bin/cli.mjs` exists
- **THEN** the block SHALL use `command: node` with the absolute path of `~/.config/rembric/bin/cli.mjs` as its only argument
- **AND** it SHALL contain no `npx` or `@rembric/mcp-bridge`

#### Scenario: Guidance never points at a bridge that is not there

- **WHEN** a print-only Hermes install or update runs and `~/.config/rembric/bin/cli.mjs` does not exist
- **THEN** no printed block SHALL name `command: node` or that path
- **AND** an install SHALL print the `npx` block pinned to the exact plugin version
- **AND** an update SHALL say the current entry keeps working and that re-running with `--yes` places the bridge and migrates it
