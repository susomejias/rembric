## MODIFIED Requirements

### Requirement: Per-client install / update / uninstall routing

For each present client the installer SHALL offer Install, Update, and Uninstall, routing each to that client's real primitive. For opencode and Hermes, install/update SHALL delegate to the client `install.sh` (re-running it performs an update) and uninstall SHALL delegate to the client `uninstall.sh`. For Claude Code and Codex, the installer SHALL print the client's marketplace CLI commands for each action and, only when the client binary is detected on `PATH`, MAY offer to run them; the installer SHALL NOT create or rely on a repo-side install script for these two clients. The offer to run the marketplace commands SHALL be presented as an interactive `[y/N]` prompt when a controlling terminal is available; in addition, when the opt-in `--yes` flag (alias `-y`) is set the installer SHALL execute those commands directly without prompting, including under headless invocation (e.g. `curl … | sh`), but still ONLY when the client binary is detected on `PATH`. When `--yes` is set but the client binary is absent, the installer SHALL print the commands and SHALL NOT execute anything. When `--yes` is not set and there is no controlling terminal, the installer SHALL only print the commands, as today.

The Codex CLI exposes the plugin verbs `codex plugin add <PLUGIN[@MARKETPLACE]>` (install), `codex plugin remove <PLUGIN[@MARKETPLACE]>` (uninstall), and `codex plugin marketplace upgrade <name>` (refresh the marketplace snapshot). There is NO `codex plugin install` / `codex plugin uninstall` / per-plugin `codex plugin update` subcommand. The installer SHALL therefore use `codex plugin add rembric@rembric` for install, `codex plugin remove rembric@rembric` for uninstall, and `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric` for update (the snapshot refresh alone does not re-install the cached plugin).

#### Scenario: opencode update re-runs its installer

- **WHEN** the user selects Update for opencode
- **THEN** the installer SHALL invoke the opencode `install.sh` (which overwrites the installed files)

#### Scenario: Marketplace client prints CLI commands

- **WHEN** the user selects Install for Codex
- **THEN** the installer SHALL print `codex plugin marketplace add …` and `codex plugin add rembric@rembric`
- **AND** it SHALL NOT attempt to copy plugin files itself

#### Scenario: Marketplace client run-through gated on binary presence

- **WHEN** the user selects Install for Claude Code and the `claude` binary is on `PATH`
- **THEN** the installer MAY offer to run the `/plugin marketplace add` + `/plugin install` commands
- **AND** when the binary is absent, the installer SHALL print the commands for the user to run manually

#### Scenario: --yes executes the marketplace command headlessly when the binary is present

- **WHEN** the installer runs headless as `--agent=claude --action=update --yes` (or `-y`) and the `claude` binary is on `PATH`
- **THEN** it SHALL execute `claude plugin update rembric@rembric` directly without any prompt
- **AND** the same SHALL hold for Codex (`codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`) and for the install/uninstall actions of both clients

#### Scenario: --yes with an absent binary executes nothing

- **WHEN** the installer runs headless as `--agent=codex --action=update --yes` and the `codex` binary is NOT on `PATH`
- **THEN** it SHALL print the marketplace command(s) and SHALL NOT execute anything

#### Scenario: Without --yes a headless run only prints

- **WHEN** the installer runs headless as `--agent=claude --action=update` (no `--yes`) and the `claude` binary is on `PATH`
- **THEN** it SHALL only print the marketplace command and SHALL NOT execute it
