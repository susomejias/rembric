## MODIFIED Requirements

### Requirement: Single orchestrator entry point

The repository SHALL host a single POSIX `sh` installer at `apps/plugin/install.sh`, fronted by the pure-forwarding root `install.sh`, for the server and all five client plugins. It SHALL run under `set -eu` from a downloaded file or `curl | sh` and delegate rather than duplicate client install logic. Delegation backends SHALL be opencode's repo-side scripts, Claude/Codex marketplace CLIs, Pi's registry CLI, and Hermes's native plugin-manager CLI. Hermes maintenance wrappers MAY retain recognized legacy MCP repair but SHALL NOT copy/fetch provider files or maintain a deletion whitelist. Pi SHALL retain no repo-side install/uninstall script or marketplace entry.

#### Scenario: Installer is a single POSIX sh file at the plugin root

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/install.sh` SHALL be the sole orchestrator and pass `sh -n`

#### Scenario: Installer delegates rather than duplicates

- **WHEN** opencode performs install/update/uninstall
- **THEN** its existing repo-side scripts SHALL own the operation
- **AND** Hermes SHALL instead delegate distribution to its native CLI

#### Scenario: The registry-CLI backend has no repo-side script

- **WHEN** the repository is at HEAD
- **THEN** Pi SHALL have no repo-side install/uninstall script and SHALL use its own CLI

### Requirement: Client presence and version detection

The installer SHALL detect all five clients by executable presence on PATH, including Hermes rather than the existence of its data directory. Installed versions SHALL retain existing per-client adapters: Claude/Codex JSON cache manifests, opencode's version comment, Hermes `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/plugin.yaml`, and Pi's measured user-scope package location or explicit unknown. Available versions SHALL come from a single `.release-please-manifest.json` fetch at the installer's source ref. Unknown installed versions SHALL never render as current or outdated. Every recommended ACTION SHALL derive from the existing single state-to-accepted-verb mapping; non-actionable states SHALL remain `up to date`, `ahead` or `-`.

Hermes local source/custom ref mutation requests SHALL be rejected rather than implied by the table's available version. Native provenance SHALL gate Hermes updateability: copied/untracked, linked, foreign-source, malformed, inconsistent or pinned installs SHALL not recommend or trigger unattended update. Their state SHALL be explicitly unknown with migration/pin guidance; the installer SHALL not call them natively updateable solely from semver comparison. Because the measured native subdirectory checker cannot reliably classify even a fresh supported installation, every existing Hermes installation SHALL report unknown update status and SHALL be skipped by update-all. Explicit update SHALL validate native source metadata or offer the separately confirmed stopped-host legacy transition; unknown update status SHALL NOT hide that explicit action. No other client's detection/version/recommendation behavior SHALL change.

#### Scenario: Status table reflects installed vs available

- **WHEN** opencode is installed at `0.9.0` and available is `0.10.0`
- **THEN** its row SHALL recommend update

#### Scenario: Absent client is omitted from actionable rows

- **WHEN** Hermes has a data directory but no executable on PATH
- **THEN** its row SHALL report the client absent and execution SHALL remain disabled

#### Scenario: Available version is read from the install ref

- **WHEN** status uses a selected ref
- **THEN** the available version SHALL be read at that ref without mutating a client

#### Scenario: An undeterminable installed version renders as unknown, not as up-to-date

- **WHEN** Pi is present but its installed package version is unreadable
- **THEN** it SHALL render unknown and recommend the accepted `install` verb, not current/update

#### Scenario: Every ACTION cell is an accepted verb or a state that recommends nothing

- **WHEN** status renders all supported states
- **THEN** each recommendation SHALL use an accepted action or the existing non-actionable state labels

#### Scenario: Following the table's recommendation reaches a real action

- **WHEN** a supported row's action is invoked with `--yes` and an available binary
- **THEN** the correct native/client primitive SHALL execute without an invented action label

#### Scenario: A copied or pinned Hermes install cannot become an unattended update

- **WHEN** its manifest version is older than available but provenance is unsupported
- **THEN** status SHALL render unknown with guidance and update-all SHALL skip it

### Requirement: Per-client install / update / uninstall routing

For opencode, install/update SHALL delegate to its install script and uninstall to its uninstall script. Claude SHALL retain `claude plugin marketplace add https://github.com/susomejias/rembric.git`, `claude plugin install rembric@rembric`, `claude plugin update rembric@rembric` and `claude plugin uninstall rembric@rembric`. Codex SHALL retain marketplace add plus `codex plugin add rembric@rembric`, update via `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`, and removal via `codex plugin remove rembric@rembric`. Pi SHALL retain the unpinned `pi install npm:@rembric/pi` for install and update and `pi remove npm:@rembric/pi` for removal; Git refs SHALL not be applied to that registry artifact.

Hermes SHALL use `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable`, `hermes plugins update rembric` and `hermes plugins remove rembric`, subject to its provenance and unsupported-source guards. Explicit update of a recognized legacy copy SHALL offer the guarded one-time interactive transition to native install instead of native update. Root invocation consent SHALL NOT substitute for migration-specific consent; native installations SHALL continue using native update. All CLI backends SHALL print their commands and execute only with an available executable and interactive confirmation or `--yes`/`-y`. Without consent a headless run SHALL print only; with absent binary even `--yes` SHALL execute nothing. Hermes failure SHALL propagate rather than reporting success. Root execution consent SHALL not add forced replacement or bypass Hermes's dependency/security/capability consent.

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

### Requirement: Conservative uninstall across clients

Uninstall SHALL preserve unrelated operator settings, credentials outside a plugin-owned directory and `.rembric` markers and report what remains. opencode SHALL retain its existing conservative file-removal behavior. For a native-managed Hermes install, the approved exception SHALL permit Hermes to remove its whole plugin directory and clean up `memory.provider`, plugin selection and grants. Hermes's unrelated MCP settings and exact bridge pins SHALL remain intact. Copied/untracked, linked, foreign-source, pinned, malformed or inconsistent Hermes targets SHALL be refused without deletion. Already-absent Hermes uninstall SHALL succeed only when both target and source record are absent.

#### Scenario: Uninstall preserves operator config and credentials

- **WHEN** opencode uninstall completes
- **THEN** its MCP config, credentials and project markers SHALL remain intact

#### Scenario: Native Hermes removal has explicit ownership

- **WHEN** a consenting operator removes a verified native-managed Hermes install
- **THEN** Hermes SHALL own directory/selection/grant removal while unrelated settings, MCP configuration and external credentials remain

### Requirement: Per-agent post-install steps are surfaced

After successful installation/update, the installer SHALL print platform-specific next steps, but SHALL omit them on uninstall or native Hermes failure. Codex SHALL retain hook trust via `/hooks` and explicit shell exports, never the removed `plugin_hooks` flag. Claude installation SHALL describe keychain prompts and update SHALL request restart. opencode installation SHALL retain its MCP/environment guidance and update only restart. Pi installation SHALL require shell `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN` with no settings-file alternative and update only restart.

Hermes installation SHALL explain that native `--enable` selects the memory provider and may prompt for missing required credentials; it SHALL not instruct a second bare-name plugin install or generic enable step. Existing complementary pinned MCP wiring guidance SHALL remain. Hermes update SHALL retain recognized legacy MCP repair guidance and gateway restart without installation-only prompts.

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

### Requirement: The TUI is the canonical single documented install path

The installer at `apps/plugin/install.sh`, fronted by root `install.sh`, SHALL remain the primary canonical path for install/setup/update/uninstall of the server and every client. Docs SHALL lead with it. Claude/Codex marketplace commands, opencode shell scripts, Hermes native plugin commands, Pi's unpinned registry CLI and manual Docker commands SHALL appear only as explicitly labelled manual/advanced fallback. Hermes shell adapters SHALL not constitute a separate file-copy backend. Existing shared bridge/hooks and non-Hermes primitives SHALL remain unchanged.

#### Scenario: Docs lead with the installer

- **WHEN** a reader opens root/plugin READMEs or client sections in `docs/agents.md`
- **THEN** the root TUI SHALL be the first installation instruction and per-client commands SHALL appear only under manual/advanced headings

## ADDED Requirements

### Requirement: Hermes unsupported source requests fail before mutation

Hermes mutation requests SHALL reject `REMBRIC_SRC`, `PLUGIN_SRC`, `REMBRIC_REF` or an explicit `--ref` before any client/server/config mutation in the requested transaction. This stage SHALL support only default unpinned native distribution. It SHALL not silently reinterpret a local tree, tag, branch or SHA, even an explicitly supplied `main`. Read-only status/help SHALL remain available. Other clients' source/ref contracts SHALL remain unchanged.

#### Scenario: Unsupported mixed-client transaction

- **WHEN** a mutating transaction includes Hermes and an explicit ref or local source
- **THEN** it SHALL fail with a clear unsupported-operation diagnostic before modifying any selected client or server

#### Scenario: Supported default native transaction

- **WHEN** Hermes mutation uses the default source without an explicit ref/local override
- **THEN** it SHALL proceed through binary-presence, provenance and consent gates
