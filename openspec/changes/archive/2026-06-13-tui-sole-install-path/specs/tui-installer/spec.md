## ADDED Requirements

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
- `--token=<value>` — set `REMBRIC_ADMIN_TOKEN` for `--server` install verbatim instead of auto-generating; the value SHALL be written safely regardless of special characters.
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

## MODIFIED Requirements

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
