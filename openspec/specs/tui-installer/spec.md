# tui-installer

## Purpose

The orchestrator `install.sh` entry point for the Rembric server and all client plugins: a single copy-pasteable POSIX `sh` installer that prepares the server files and routes per-client install / update / uninstall to each client's own primitives.

## Requirements

### Requirement: Single orchestrator entry point

The repository SHALL host a single installer at `apps/plugin/install.sh` that serves as the one copy-pasteable entry point for setting up the Rembric server and all four client plugins. The script SHALL be POSIX `sh` (no bash-only syntax), SHALL run cleanly under `set -eu`, and SHALL be executable both as `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/install.sh | sh` and as a downloaded local file. The script SHALL be an orchestrator: it SHALL delegate to the per-client primitives (`apps/plugin/.opencode-plugin/{install,uninstall}.sh`, `apps/plugin/.hermes-plugin/{install,uninstall}.sh`) and to the marketplace CLIs (Claude Code, Codex), and SHALL NOT inline or duplicate any client's install/uninstall logic.

#### Scenario: Installer is a single POSIX sh file at the plugin root

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/install.sh` exists and is the only top-level orchestrator installer
- **AND** the script passes `sh -n apps/plugin/install.sh` (POSIX syntax check) with no errors

#### Scenario: Installer delegates rather than duplicates

- **WHEN** the installer performs an opencode or Hermes install/update/uninstall
- **THEN** it SHALL invoke that client's own `install.sh`/`uninstall.sh` (fetched from the same ref, or via `PLUGIN_SRC` against a local clone)
- **AND** it SHALL NOT contain a second copy of those scripts' file-copy or removal logic

### Requirement: Brand-styled output with degradation

The installer SHALL render its menu and headings using the Rembric brand palette — lime `#c6f24e` on background `#0a0a0a` — via ANSI escape sequences. On start, when colour and a terminal are active, the installer SHALL display a large block-letter "REMBRIC" wordmark in lime (a static multi-row ASCII banner baked into the script — no runtime `figlet`/font dependency). The script SHALL detect colour support and degrade in order: 24-bit truecolor → 256-colour → plain (no colour). The script SHALL emit no colour codes — and SHALL replace the block wordmark with a plain text line — when `NO_COLOR` is set in the environment or when stdout is not a terminal (`! [ -t 1 ]`).

#### Scenario: Truecolor terminal shows the lime wordmark

- **WHEN** the installer runs in a terminal advertising truecolor support and `NO_COLOR` is unset
- **THEN** the header SHALL show the multi-row block-letter "REMBRIC" banner using the lime `#c6f24e` foreground escape
- **AND** the selected menu item SHALL be drawn in lime

#### Scenario: NO_COLOR or piped stdout disables colour and the block banner

- **WHEN** `NO_COLOR` is set OR stdout is redirected to a non-terminal
- **THEN** the installer SHALL emit no ANSI colour escape sequences in its output
- **AND** it SHALL print a plain text wordmark line instead of the coloured block banner

### Requirement: TTY-aware interactivity with non-interactive fallback

Because `curl … | sh` makes the script's stdin the pipe, the installer SHALL read all interaction from `/dev/tty` rather than stdin. When a controlling terminal is available, the installer SHALL present an interactive menu navigated with the arrow keys: it SHALL put `/dev/tty` into raw mode (`stty -echo -icanon`), decode the up/down cursor escape sequences (and accept `j`/`k` and Enter), redraw the highlighted selection in place, and restore the saved terminal state and cursor on every exit path. When raw mode cannot be entered (no `stty`, or `/dev/tty` is not a real terminal) the installer SHALL fall back to a numbered prompt read from `/dev/tty`. When there is no controlling terminal at all OR `REMBRIC_NONINTERACTIVE=1` is set, the installer SHALL run non-interactively, driven by flags: `--server`, `--agent=<name>[,<name>…]` (one or more of `claude,codex,hermes,opencode`), and `--action=install|update|uninstall`. Under non-interactive mode the installer SHALL refuse to act on ambiguous or empty input, exiting non-zero with a usage message rather than guessing.

#### Scenario: Arrow keys move the highlighted selection

- **WHEN** a user runs the installer in an interactive terminal and presses the down then up arrow keys
- **THEN** the highlighted menu item SHALL move down then back up, redrawn in place with the lime accent
- **AND** pressing Enter SHALL select the highlighted item

#### Scenario: Piped invocation still navigates via the terminal

- **WHEN** a user runs `curl -fsSL …/apps/plugin/install.sh | sh` in an interactive terminal
- **THEN** keypresses SHALL be read from `/dev/tty` in raw mode
- **AND** the menu SHALL NOT be auto-skipped by the empty piped stdin
- **AND** the saved `stty` state SHALL be restored when the installer exits

#### Scenario: Raw mode unavailable falls back to a numbered prompt

- **WHEN** the installer runs on a terminal where `stty` raw mode cannot be entered
- **THEN** it SHALL present a numbered menu read from `/dev/tty` instead of the arrow-key menu

#### Scenario: Headless run requires explicit flags

- **WHEN** the installer runs with no controlling terminal (e.g. CI) and no action flags
- **THEN** it SHALL print a usage message naming `--server`, `--agent`, and `--action`
- **AND** it SHALL exit non-zero without modifying the system

#### Scenario: Non-interactive flag-driven plugin install

- **WHEN** the installer runs as `REMBRIC_NONINTERACTIVE=1 sh install.sh --agent=opencode --action=install`
- **THEN** it SHALL perform the opencode install by delegating to the opencode `install.sh`
- **AND** it SHALL NOT prompt for any input

### Requirement: Server flow prepares files, generates the token, and optionally brings the stack up

The installer's server install option SHALL download `docker-compose.yml` and `.env.example` from the install ref into the current directory and write a `.env` derived from `.env.example` with `REMBRIC_ADMIN_TOKEN` set. The token SHALL be either a value the user pastes or, when none is given, one the installer auto-generates (`openssl rand -hex 32`, falling back to an `od`/`/dev/urandom` hex string when `openssl` is absent). An existing `.env` whose `REMBRIC_ADMIN_TOKEN` is non-empty SHALL be left untouched; an existing `.env` whose token is **empty** (e.g. left half-written by an interrupted earlier run) SHALL be treated like a fresh one and have the token filled in, so the installer is safely re-runnable and never proceeds with an empty token. The effective admin token SHALL be displayed to the user in every case — generated, pasted, or read back from `.env` — since it is required to log into the dashboard; on a successful bring-up it SHALL also be echoed alongside the dashboard URL. `REMBRIC_ADMIN_TOKEN` is the only required variable; the installer SHALL NOT prompt for any other env value. The installer SHALL then bring the stack up ONLY when `docker` is on `PATH` AND the user has confirmed (an interactive `[y/N]` prompt, or the `--up` flag under non-interactive mode); the bring-up SHALL run `docker compose pull` first on a best-effort basis (so a stale local `:latest` tag cannot shadow the published image; silently skipped when offline) and then `docker compose up -d`. On success it SHALL print the dashboard URL. When Docker is absent or the user declines, the installer SHALL instead print the exact `docker compose pull && docker compose up -d` command and SHALL NOT execute any `docker` command. The installer SHALL NOT require Docker to be installed. The server update option SHALL re-fetch `docker-compose.yml` and offer the SAME gated bring-up (`docker compose pull && docker compose up -d`, gated on `docker compose` availability and confirmation/`--up`); when the current directory has no `./.env` the update SHALL NOT bring the server up and SHALL direct the user to run install first.

#### Scenario: Server install auto-generates the token when none is pasted

- **WHEN** the user selects server install and provides no token
- **THEN** the installer SHALL write `.env` with an auto-generated `REMBRIC_ADMIN_TOKEN` and display the generated value

#### Scenario: Existing configured .env shows the current token without changing it

- **WHEN** server install runs in a directory whose `.env` already has a non-empty `REMBRIC_ADMIN_TOKEN`
- **THEN** the installer SHALL leave `.env` untouched and display the token read from it

#### Scenario: Interrupted run left an empty token — re-run fills it

- **WHEN** server install runs in a directory whose `.env` exists but `REMBRIC_ADMIN_TOKEN` is empty
- **THEN** the installer SHALL set the token (paste or auto-generate), write it into `.env`, and display it
- **AND** it SHALL NOT proceed to bring the server up with an empty token

#### Scenario: Optional bring-up gated on Docker presence and confirmation

- **WHEN** server install runs, `docker compose` is available, and the user confirms the bring-up prompt (or passes `--up`)
- **THEN** the installer SHALL run `docker compose pull && docker compose up -d` and print the dashboard URL
- **AND** when the user declines OR `docker compose` is unavailable, the installer SHALL print the command and SHALL NOT execute any `docker` command

#### Scenario: Update offers the same bring-up as install

- **WHEN** server update runs in a directory that has a `./.env`, `docker compose` is available, and the user confirms (or passes `--up`)
- **THEN** the installer SHALL re-fetch `docker-compose.yml` and run `docker compose pull && docker compose up -d`
- **AND** when the directory has no `./.env`, update SHALL NOT bring the server up and SHALL direct the user to run install first

#### Scenario: Server flow does not require Docker present

- **WHEN** the installer runs the server option on a host where `docker` is not on `PATH`
- **THEN** the file-preparation and token-generation steps SHALL still complete successfully
- **AND** the printed next-step command SHALL be the only reference to Docker

#### Scenario: Non-interactive server install does not silently start Docker

- **WHEN** the installer runs `REMBRIC_NONINTERACTIVE=1 … --server --action=install` without `--up`
- **THEN** it SHALL prepare files and generate the token but SHALL NOT execute `docker compose up`

### Requirement: Dependency pre-checks

Before performing any install or update, the installer SHALL verify the tools it needs and abort with a single clear, actionable error listing everything missing rather than failing partway. The core tools (`sed`, `grep`, `sort`, `mktemp`) SHALL always be required; `curl` SHALL be required only in remote mode (when `REMBRIC_SRC` is unset). For the server flow specifically, the installer SHALL display a dependency report covering `docker`, `docker compose` (the Compose v2 subcommand, verified via `docker compose version` — not the legacy `docker-compose` v1 binary), and token generation capability (`openssl`, or `/dev/urandom` as fallback), marking each present/absent. A missing `docker`/`docker compose` SHALL NOT block file preparation — it only disables the optional auto bring-up.

#### Scenario: Missing core tool aborts with a combined error

- **WHEN** the installer runs in remote mode on a host lacking `curl`
- **THEN** it SHALL print an error naming the missing tool(s) and exit non-zero before fetching anything

#### Scenario: Server dependency report reflects the host

- **WHEN** the user runs the server install flow
- **THEN** the installer SHALL print a dependency report marking `docker`, `docker compose`, and `openssl`/urandom as present or absent
- **AND** when `docker compose` is absent the file-preparation and token steps SHALL still complete, only the auto bring-up being skipped

### Requirement: Client presence and version detection

For each of the four clients the installer SHALL determine (a) whether the client is present — Claude/Codex/opencode by `command -v <binary>`, Hermes by the existence of `${HERMES_HOME:-~/.hermes}` — and (b) the installed plugin version, read from that client's on-disk manifest using a per-client adapter: JSON `version` field for Claude Code and Codex manifests, YAML `version:` for `~/.hermes/plugins/rembric/plugin.yaml`, and the `@rembric-plugin-version` comment for `~/.config/opencode/plugins/rembric.ts`. The "available" version SHALL come from a single fetch of `.release-please-manifest.json` at the SAME git ref the installer would install from. The installer SHALL render a status table showing, per client: present (yes/no), installed version (or `—`), available version, and the recommended action. Semver comparison SHALL treat the manifest's bare semver values directly (e.g. via `sort -V`).

#### Scenario: Status table reflects installed vs available

- **WHEN** opencode is present with an installed `rembric.ts` at version `0.9.0` and the available manifest reports `0.10.0`
- **THEN** the status table SHALL show opencode present, installed `0.9.0`, available `0.10.0`, and an Update action

#### Scenario: Absent client is omitted from actionable rows

- **WHEN** Hermes is not present (`${HERMES_HOME:-~/.hermes}` does not exist)
- **THEN** the Hermes row SHALL show "not present" and SHALL NOT offer an install-version action that assumes an existing install

#### Scenario: Available version is read from the install ref

- **WHEN** the installer is configured to install from ref `main`
- **THEN** the available version SHALL be read from `.release-please-manifest.json` at `main`
- **AND** when configured to install from a pinned tag, the available version SHALL be read from `.release-please-manifest.json` at that same tag

### Requirement: Per-client install / update / uninstall routing

For each present client the installer SHALL offer Install, Update, and Uninstall, routing each to that client's real primitive. For opencode and Hermes, install/update SHALL delegate to the client `install.sh` (re-running it performs an update) and uninstall SHALL delegate to the client `uninstall.sh`. For Claude Code and Codex, the installer SHALL print the client's marketplace CLI commands for each action and, only when the client binary is detected on `PATH`, MAY offer to run them; the installer SHALL NOT create or rely on a repo-side install script for these two clients.

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

### Requirement: Conservative uninstall across clients

When the installer performs an uninstall for any client, it SHALL remove only plugin-owned files and SHALL NOT remove operator-owned configuration (`opencode.json`, `~/.hermes/.env`), credentials, or `.rembric` project markers. After an uninstall the installer SHALL print what was deliberately left in place so the operator can remove it manually if desired.

#### Scenario: Uninstall preserves operator config and credentials

- **WHEN** the user uninstalls the opencode plugin via the installer
- **THEN** the `mcp.rembric` block in `~/.config/opencode/opencode.json`, any `.rembric` files, and stored credentials SHALL remain untouched
- **AND** the installer SHALL print a list of what it left behind

### Requirement: Supply-chain-safe distribution guidance

Because a `curl | sh` installer is a supply-chain surface, the documentation that publishes the installer command SHALL lead with the download-inspect-run two-step (download the script, inspect it, then run it) as the recommended path, and SHALL offer a tag-pinned URL alternative for reproducibility. On start the installer SHALL print the source ref it is operating against so the user can confirm what they ran. No part of this capability SHALL add an npm dependency, a lifecycle script, or a published binary.

#### Scenario: Docs present the inspect-first alternative

- **WHEN** a reader follows the installer documentation in `README.md` or `docs/agents.md`
- **THEN** the docs SHALL show the download-inspect-run two-step and a tag-pinned URL alongside the one-line `curl | sh` form

#### Scenario: Installer announces its ref on start

- **WHEN** the installer starts
- **THEN** it SHALL print the git ref (e.g. `main` or a pinned tag) it will fetch artifacts from

### Requirement: The TUI is the canonical single documented install path

The installer at `apps/plugin/install.sh` SHALL be the primary, canonical entry point that all user-facing documentation leads with for install, setup, upgrade, and uninstall of the Rembric server and every client plugin. Per-client manual mechanisms — the Claude/Codex marketplace commands, the opencode/Hermes `curl | sh` scripts, and the manual Docker quickstart — SHALL remain documented, but ONLY under explicitly-labelled "Manual / advanced" sections, never as the primary instruction. The per-client primitives themselves (each `install.sh`/`uninstall.sh`, the `marketplace.json` files, the bridge, the hooks) are unchanged: they are the installer's backend and the documented manual fallback.

#### Scenario: Docs lead with the installer

- **WHEN** a user opens `README.md`, `apps/plugin/README.md`, or any per-client section of `docs/agents.md`
- **THEN** the first documented install / setup / upgrade instruction SHALL be the TUI installer
- **AND** any per-client marketplace or `curl | sh` command SHALL appear only under a heading that marks it as manual / advanced

### Requirement: Root install.sh shim

A repo-root `install.sh` SHALL exist that forwards to `apps/plugin/install.sh`, so the canonical install URL is `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh`. The shim SHALL NOT reimplement any installer logic: when a local copy of `apps/plugin/install.sh` is present alongside it (a clone) it SHALL `exec` that script; otherwise (run via `curl … | sh`) it SHALL fetch and run `apps/plugin/install.sh` from the same git ref. All flags and environment variables (`--server`, `--agent`, `--action`, `--up`, `--ref`, `REMBRIC_SRC`, `REMBRIC_NONINTERACTIVE`, `NO_COLOR`) SHALL pass through unchanged.

#### Scenario: Root shim forwards with arguments intact

- **WHEN** a user runs `sh install.sh --server --action=install` from a repo clone root
- **THEN** it SHALL behave identically to running `sh apps/plugin/install.sh --server --action=install`

#### Scenario: Canonical short URL works

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh`
- **THEN** the root shim SHALL run the `apps/plugin/install.sh` orchestrator (fetched at the same ref)

#### Scenario: Shim adds no installer logic

- **WHEN** the repository is at HEAD
- **THEN** the root `install.sh` SHALL be a thin forwarder (no menu, token, fetch-of-artifacts, or client logic of its own) that delegates entirely to `apps/plugin/install.sh`

### Requirement: Headless agent CLI surface

The installer SHALL be fully drivable headlessly as a CLI so agents/automation can use it without the interactive TUI. Beyond the existing `--server` / `--agent=<list>` / `--action=install|update|uninstall` / `--up` / `--ref=<tag>` flags and `REMBRIC_NONINTERACTIVE`, it SHALL provide:

- `--status` — print the server status and the per-agent Rembric-plugin table (columns `AGENT` · `DETECTED` = agent found on this machine · `PLUGIN` = installed plugin version · `LATEST` = latest plugin version · `ACTION`) headlessly and exit, without entering the menu and without a banner. A caption SHALL make clear the action targets the plugin, not the agent.
- `--json` — with `--status`, emit a machine-readable object `{ "server": {…}, "agents": [...] }` and nothing else on stdout so it parses cleanly. The `server` object carries `state` (docker container state: `running`/`exited`/`paused`/`created`/`dead`/`absent`/`unknown`), `version` (the running/stopped container's image tag, or null), and `latest_release` (the newest published server release from GitHub Releases — tag `server-v<semver>` — or null). Each `agents` entry carries `agent`, `present` boolean, `installed` (semver or null), `available` (semver or null), `action`.
- `--token=<value>` — set `REMBRIC_ADMIN_TOKEN` for `--server` install verbatim instead of auto-generating; the value SHALL be written safely regardless of special characters, and a value shorter than 16 characters SHALL be refused with a clear error (the server's minimum) rather than producing a crash-looping server.
- `--port=<n>` — set `REMBRIC_PORT` in the generated `.env` for `--server`, and the printed dashboard URL SHALL reflect it.

The `--up` bring-up SHALL honour `REMBRIC_NO_PULL=1` to skip `docker compose pull` and use the locally-present image as-is (air-gapped operators, and the CI end-to-end test that brings the freshly-built image up). The installer SHALL report the server status (docker-observable state + running image tag) in `--status` and in the interactive Server screen. It SHALL also surface `latest_release` — the newest published server release from the GitHub Releases API (tag `server-v<semver>`), the same source the dashboard's update-check uses — on a **best-effort** basis: a single short-timeout `curl` (overridable via `REMBRIC_RELEASES_URL`), silently omitted when offline, rate-limited, `curl`-less, or when `REMBRIC_UPDATE_CHECK=off`. Because a running `:latest` image cannot be compared to a release without a digest, `latest_release` is informational; an "update available" hint is shown ONLY when the running tag is itself a semver older than `latest_release`. The server's "available" is NOT taken from the repo manifest (that is the source-tree version, not a published release). `--status` SHALL work regardless of TTY. An unknown flag SHALL exit non-zero with an error. `--help` SHALL document the full flag set.

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

### Requirement: Hero tagline and one-time banner reveal

In colour mode the header SHALL show, under the lime block wordmark, a two-line hero tagline describing Rembric (the GitHub one-liner: "Persistent memory for AI coding agents — self-hosted, MCP-native, append-only. One Docker image, one SQLite file."). On the FIRST render in an interactive terminal the block wordmark MAY animate as a top-to-bottom reveal (a short per-row delay); the reveal SHALL play at most once per run and SHALL be skipped entirely in headless mode, under `--status`/`--json`, when `NO_COLOR` is set, or when stdout is not a terminal. The plain/degraded wordmark SHALL show neither the tagline nor the animation.

#### Scenario: Tagline and reveal are interactive-only

- **WHEN** the installer runs headless, under `--status`, or with `NO_COLOR`
- **THEN** no reveal animation SHALL occur and the hero tagline SHALL NOT be printed (output is the plain wordmark line, or for `--status` the payload only)

#### Scenario: Reveal plays at most once

- **WHEN** the interactive menu redraws the banner across navigation steps
- **THEN** only the first render MAY animate; subsequent redraws SHALL be instant

### Requirement: Per-agent post-install steps are surfaced

After a successful install or update (NOT uninstall), the installer SHALL print the required platform post-install steps for that agent, so the user is not left with a half-wired plugin. At minimum: Codex SHALL show enabling `plugin_hooks` and trusting the 5 hooks via `/hooks`, plus exporting `REMBRIC_*`; Hermes SHALL show `hermes plugins install rembric` (which triggers the `requires_env` credential prompts), then `hermes plugins enable rembric`, then a reminder to run `hermes gateway restart` so it loads the (new) plugin; opencode SHALL point at pasting the printed MCP block and exporting `REMBRIC_*`; Claude SHALL note credentials are prompted at install (keychain). The full walkthrough remains in `docs/agents.md`.

#### Scenario: Codex install prints the hook-enablement steps

- **WHEN** `--agent=codex --action=install` runs
- **THEN** the output SHALL include enabling `plugin_hooks` and trusting the hooks via `/hooks`

#### Scenario: Hermes install prints the requires_env + enable + gateway-restart steps

- **WHEN** `--agent=hermes --action=install` runs
- **THEN** the output SHALL include `hermes plugins install rembric`, `hermes plugins enable rembric`, and a reminder to run `hermes gateway restart`

#### Scenario: Uninstall omits post-install steps

- **WHEN** any `--action=uninstall` runs
- **THEN** no post-install "Next" steps SHALL be printed
