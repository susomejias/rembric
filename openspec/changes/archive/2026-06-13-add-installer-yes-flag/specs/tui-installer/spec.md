## MODIFIED Requirements

### Requirement: Per-client install / update / uninstall routing

For each present client the installer SHALL offer Install, Update, and Uninstall, routing each to that client's real primitive. For opencode and Hermes, install/update SHALL delegate to the client `install.sh` (re-running it performs an update) and uninstall SHALL delegate to the client `uninstall.sh`. For Claude Code and Codex, the installer SHALL print the client's marketplace CLI commands for each action and, only when the client binary is detected on `PATH`, MAY offer to run them; the installer SHALL NOT create or rely on a repo-side install script for these two clients. The offer to run the marketplace commands SHALL be presented as an interactive `[y/N]` prompt when a controlling terminal is available; in addition, when the opt-in `--yes` flag (alias `-y`) is set the installer SHALL execute those commands directly without prompting, including under headless invocation (e.g. `curl … | sh`), but still ONLY when the client binary is detected on `PATH`. When `--yes` is set but the client binary is absent, the installer SHALL print the commands and SHALL NOT execute anything. When `--yes` is not set and there is no controlling terminal, the installer SHALL only print the commands, as today.

#### Scenario: opencode update re-runs its installer

- **WHEN** the user selects Update for opencode
- **THEN** the installer SHALL invoke the opencode `install.sh` (which overwrites the installed files)

#### Scenario: Marketplace client prints CLI commands

- **WHEN** the user selects Install for Codex
- **THEN** the installer SHALL print `codex plugin marketplace add …` and `codex plugin install rembric`
- **AND** it SHALL NOT attempt to copy plugin files itself

#### Scenario: Marketplace client run-through gated on binary presence

- **WHEN** the user selects Install for Claude Code and the `claude` binary is on `PATH`
- **THEN** the installer MAY offer to run the `/plugin marketplace add` + `/plugin install` commands
- **AND** when the binary is absent, the installer SHALL print the commands for the user to run manually

#### Scenario: --yes executes the marketplace command headlessly when the binary is present

- **WHEN** the installer runs headless as `--agent=claude --action=update --yes` (or `-y`) and the `claude` binary is on `PATH`
- **THEN** it SHALL execute `claude plugin update rembric@rembric` directly without any prompt
- **AND** the same SHALL hold for Codex (`codex plugin marketplace upgrade rembric`) and for the install/uninstall actions of both clients

#### Scenario: --yes with an absent binary executes nothing

- **WHEN** the installer runs headless as `--agent=codex --action=update --yes` and the `codex` binary is NOT on `PATH`
- **THEN** it SHALL print the marketplace command(s) and SHALL NOT execute anything

#### Scenario: Without --yes a headless run only prints

- **WHEN** the installer runs headless as `--agent=claude --action=update` (no `--yes`) and the `claude` binary is on `PATH`
- **THEN** it SHALL only print the marketplace command and SHALL NOT execute it

### Requirement: Headless agent CLI surface

The installer SHALL be fully drivable headlessly as a CLI so agents/automation can use it without the interactive TUI. Beyond the existing `--server` / `--agent=<list>` / `--action=install|update|uninstall` / `--up` / `--ref=<tag>` flags and `REMBRIC_NONINTERACTIVE`, it SHALL provide:

- `--status` — print the server status and the per-agent Rembric-plugin table (columns `AGENT` · `DETECTED` = agent found on this machine · `PLUGIN` = installed plugin version · `LATEST` = latest plugin version · `ACTION`) headlessly and exit, without entering the menu and without a banner. A caption SHALL make clear the action targets the plugin, not the agent.
- `--json` — with `--status`, emit a machine-readable object `{ "server": {…}, "agents": [...] }` and nothing else on stdout so it parses cleanly. The `server` object carries `state` (docker container state: `running`/`exited`/`paused`/`created`/`dead`/`absent`/`unknown`), `version` (the running/stopped container's image tag, or null), and `latest_release` (the newest published server release from GitHub Releases — tag `server-v<semver>` — or null). Each `agents` entry carries `agent`, `present` boolean, `installed` (semver or null), `available` (semver or null), `action`.
- `--token=<value>` — set `REMBRIC_ADMIN_TOKEN` for `--server` install verbatim instead of auto-generating; the value SHALL be written safely regardless of special characters, and a value shorter than 16 characters SHALL be refused with a clear error (the server's minimum) rather than producing a crash-looping server.
- `--port=<n>` — set `REMBRIC_PORT` in the generated `.env` for `--server`, and the printed dashboard URL SHALL reflect it.
- `--yes` (alias `-y`) — opt-in auto-confirm for the Claude Code / Codex marketplace run-through. When set, the installer SHALL execute the marketplace command(s) for the requested `--action` directly (no prompt), but ONLY when the client binary is detected on `PATH`; with an absent binary it prints and executes nothing. The flag SHALL default to off, so omitting it preserves the print-only headless behavior and the interactive `[y/N]` prompt on a real TTY. `--yes` SHALL NOT auto-start the Docker bring-up (that stays gated on `--up`).

The `--up` bring-up SHALL honour `REMBRIC_NO_PULL=1` to skip `docker compose pull` and use the locally-present image as-is (air-gapped operators, and the CI end-to-end test that brings the freshly-built image up). The installer SHALL report the server status (docker-observable state + running image tag) in `--status` and in the interactive Server screen. It SHALL also surface `latest_release` — the newest published server release from the GitHub Releases API (tag `server-v<semver>`), the same source the dashboard's update-check uses — on a **best-effort** basis: a single short-timeout `curl` (overridable via `REMBRIC_RELEASES_URL`), silently omitted when offline, rate-limited, `curl`-less, or when `REMBRIC_UPDATE_CHECK=off`. Because a running `:latest` image cannot be compared to a release without a digest, `latest_release` is informational; an "update available" hint is shown ONLY when the running tag is itself a semver older than `latest_release`. The server's "available" is NOT taken from the repo manifest (that is the source-tree version, not a published release). `--status` SHALL work regardless of TTY. An unknown flag SHALL exit non-zero with an error. `--help` SHALL document the full flag set, including `--yes`/`-y`.

#### Scenario: `--status --json` is clean machine-readable output

- **WHEN** an agent runs `install.sh --status --json`
- **THEN** stdout SHALL be a single JSON object with a `server` block (`state`/`version`/`latest_release`) and an `agents` array (one object per agent: `claude`, `codex`, `hermes`, `opencode`)
- **AND** no banner, prompt, or colour escape SHALL precede or follow it

#### Scenario: Server state is reported from docker, best-effort

- **WHEN** `--status` runs and a `rembric` container exists
- **THEN** the reported server `state` SHALL be the docker container state (e.g. `running`, `exited`) and `version` its image tag
- **AND** when docker is unavailable or its daemon is unreachable, `state` SHALL be `unknown` (never a crash)

#### Scenario: latest_release comes from GitHub Releases, best-effort

- **WHEN** `--status` runs with update-checking enabled and the releases endpoint lists `server-v<semver>` tags
- **THEN** `latest_release` SHALL be the highest such semver (plugin-release tags ignored)
- **AND** when offline / rate-limited / `REMBRIC_UPDATE_CHECK=off`, `latest_release` SHALL be null and the rest of `--status` SHALL still render

#### Scenario: `--token` and `--port` configure the server non-interactively

- **WHEN** an agent runs `install.sh --server --action=install --token=<tok> --port=<n>` headless
- **THEN** `./.env` SHALL contain `REMBRIC_ADMIN_TOKEN=<tok>` (verbatim) and `REMBRIC_PORT=<n>`
- **AND** no prompt SHALL be shown

#### Scenario: `--help` documents the `--yes` flag

- **WHEN** a user runs `install.sh --help`
- **THEN** the usage output SHALL list `--yes` (and its `-y` alias) and describe it as the opt-in that runs the Claude/Codex marketplace commands when the binary is present
