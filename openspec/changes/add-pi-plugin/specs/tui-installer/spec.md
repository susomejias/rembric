## MODIFIED Requirements

### Requirement: Single orchestrator entry point

The repository SHALL host a single installer at `apps/plugin/install.sh` that serves as the one copy-pasteable entry point for setting up the Rembric server and all five client plugins. The script SHALL be POSIX `sh` (no bash-only syntax), SHALL run cleanly under `set -eu`, and SHALL be executable both as `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/install.sh | sh` and as a downloaded local file. The script SHALL be an orchestrator: it SHALL delegate to the per-client primitives and SHALL NOT inline or duplicate any client's install/uninstall logic.

There are **three** delegation backends, not two, and each client uses exactly one:

1. **Repo-side shell scripts** — `apps/plugin/.opencode-plugin/{install,uninstall}.sh` and `apps/plugin/.hermes-plugin/{install,uninstall}.sh`, fetched from the same ref (or read via `PLUGIN_SRC` against a local clone).
2. **Marketplace CLIs** — Claude Code and Codex, driven by the client's own plugin verbs against this repository as a marketplace.
3. **A client CLI resolving a public registry package** — Pi, driven by `pi install npm:@rembric/pi`. There SHALL be no repo-side install script and no marketplace entry for this client: its install mechanism is its own CLI against the npm registry, and the installer's job is to invoke it (subject to the same binary-presence and `--yes` gating the marketplace backend uses).

#### Scenario: Installer is a single POSIX sh file at the plugin root

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/install.sh` exists and is the only top-level orchestrator installer
- **AND** the script passes `sh -n apps/plugin/install.sh` (POSIX syntax check) with no errors

#### Scenario: Installer delegates rather than duplicates

- **WHEN** the installer performs an opencode or Hermes install/update/uninstall
- **THEN** it SHALL invoke that client's own `install.sh`/`uninstall.sh` (fetched from the same ref, or via `PLUGIN_SRC` against a local clone)
- **AND** it SHALL NOT contain a second copy of those scripts' file-copy or removal logic

#### Scenario: The registry-CLI backend has no repo-side script

- **WHEN** the repository is at HEAD
- **THEN** there SHALL be no `apps/plugin/.pi-plugin/install.sh` and no `apps/plugin/.pi-plugin/uninstall.sh`
- **AND** the installer SHALL route that client's actions through its own CLI

### Requirement: TTY-aware interactivity with non-interactive fallback

Because `curl … | sh` makes the script's stdin the pipe, the installer SHALL read all interaction from `/dev/tty` rather than stdin. When a controlling terminal is available, the installer SHALL present an interactive menu navigated with the arrow keys: it SHALL put `/dev/tty` into raw mode (`stty -echo -icanon`), decode the up/down cursor escape sequences (and accept `j`/`k` and Enter), redraw the highlighted selection in place, and restore the saved terminal state and cursor on every exit path. An interrupt (`SIGINT`/`SIGTERM`, e.g. Ctrl-C) SHALL itself count as an exit path: the installer SHALL restore the terminal state AND terminate the process (a caught signal with only a restore-and-continue trap does NOT terminate a shell by default — the interactive loop would otherwise keep running in a now-broken cooked-mode state). When raw mode cannot be entered (no `stty`, or `/dev/tty` is not a real terminal) the installer SHALL fall back to a numbered prompt read from `/dev/tty`. When there is no controlling terminal at all OR `REMBRIC_NONINTERACTIVE=1` is set, the installer SHALL run non-interactively, driven by flags: `--server`, `--agent=<name>[,<name>…]` (one or more of `claude,codex,hermes,opencode,pi`), and `--action=install|update|uninstall`. Under non-interactive mode the installer SHALL refuse to act on ambiguous or empty input, exiting non-zero with a usage message rather than guessing.

The `--agent` value set SHALL be maintained in a form that cannot drift between the parser, the loops, the menu, and the usage text. Every place the client list appears SHALL agree, and the agreement SHALL be asserted rather than reviewed.

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

#### Scenario: The fifth client is accepted by `--agent`

- **WHEN** the installer runs as `REMBRIC_NONINTERACTIVE=1 sh install.sh --agent=pi --action=install`
- **THEN** it SHALL NOT reject `pi` as an unknown agent
- **AND** it SHALL route the action through that client's own CLI

#### Scenario: The client list agrees across every surface

- **WHEN** the installer's `--agent` parser, its per-client loops, its interactive agent menu, and its `--help` usage text are compared
- **THEN** all four SHALL enumerate the same client set
- **AND** the agreement SHALL be asserted by a test, so adding a sixth client in one place and not the others fails

#### Scenario: Ctrl-C inside the arrow-key menu exits the process

- **GIVEN** the installer is showing the interactive arrow-key menu
- **WHEN** the user presses Ctrl-C
- **THEN** the terminal SHALL be restored to its saved state (echo/canonical mode, visible cursor)
- **AND** the process SHALL terminate within a few seconds — it SHALL NOT continue running the menu loop in cooked mode

#### Scenario: Ctrl-C during the banner reveal restores the cursor and exits

- **GIVEN** the installer is playing the first-render banner animation (cursor hidden)
- **WHEN** the user presses Ctrl-C before the animation completes
- **THEN** the cursor SHALL be made visible again
- **AND** the process SHALL terminate rather than continuing past the animation in an inconsistent state

### Requirement: Client presence and version detection

For each of the five clients the installer SHALL determine (a) whether the client is present — Claude/Codex/opencode/Pi by `command -v <binary>`, Hermes by the existence of `${HERMES_HOME:-~/.hermes}` — and (b) the installed plugin version, read from that client's on-disk manifest using a per-client adapter: JSON `version` field for Claude Code and Codex manifests, YAML `version:` for `~/.hermes/plugins/rembric/plugin.yaml`, and the `@rembric-plugin-version` comment for `~/.config/opencode/plugins/rembric.ts`. The "available" version SHALL come from a single fetch of `.release-please-manifest.json` at the SAME git ref the installer would install from. The installer SHALL render a status table showing, per client: present (yes/no), installed version (or `—`), available version, and the recommended action. Semver comparison SHALL treat the manifest's bare semver values directly (e.g. via `sort -V`).

**The table's "update available" SHALL never lie**, and a client for which the installed version cannot be determined SHALL NOT be made to look determinate. For the registry-CLI client (Pi) the installer SHALL do exactly one of the following, and nothing else:

1. Read the installed version from a **deterministic on-disk location** whose contents were established by measurement, in the manner of the four existing adapters; or
2. Report the installed version as **explicitly unknown** and recommend an action that is correct under ignorance — the idempotent reinstall — with the table rendering `unknown` for that row.

Guessing, inferring from presence, or defaulting to the available version SHALL NOT be done. A row whose installed version is unknown SHALL NOT report "up to date" and SHALL NOT report "update available".

**Every recommendation the ACTION column prints SHALL be a verb `--action` accepts.** A cell that names something else is a defect even when the underlying state is reported correctly, because the column is an instruction: an operator or an agent that follows it literally SHALL reach a real action. A state for which no action can be recommended SHALL print the state instead (`up to date`, `ahead`, or `-` when no available version could be read) — never an invented verb. The mapping from detected state to recommended verb SHALL exist in exactly ONE place, and every surface that names a verb (the ACTION column, and update-all's force hint) SHALL take it from there, so the surfaces cannot disagree. The idempotent reinstall of an unreadable install is therefore printed as `install`, the verb that performs it.

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

#### Scenario: An undeterminable installed version renders as unknown, not as up-to-date

- **GIVEN** the registry-CLI client is present but its installed extension version cannot be read from a deterministic location
- **WHEN** `--status` renders the table
- **THEN** that row's installed version SHALL render as `unknown`
- **AND** its recommended action SHALL be the idempotent reinstall, printed as `install`
- **AND** it SHALL NOT render "up to date" or "update available"

#### Scenario: Every ACTION cell is an accepted verb or a state that recommends nothing

- **WHEN** `--status` renders the table in each detectable state — not installed, installed and outdated, installed and current, ahead of the published version, and present with an unreadable version
- **THEN** every ACTION cell SHALL be either one of the verbs `--action` accepts or one of `up to date` / `ahead` / `-`
- **AND** the accepted-verb set used to check this SHALL be derived from the installer's own single definition, not restated in the test

#### Scenario: Following the table's recommendation reaches a real action

- **GIVEN** a row whose ACTION cell names a verb
- **WHEN** the installer is re-invoked as `--agent=<that row's agent> --action=<that cell> --yes`
- **THEN** it SHALL exit `0` and SHALL execute that client's command
- **AND** it SHALL NOT report an invalid action, and SHALL NOT exit `0` having run nothing

### Requirement: Per-client install / update / uninstall routing

For each present client the installer SHALL offer Install, Update, and Uninstall, routing each to that client's real primitive. For opencode and Hermes, install/update SHALL delegate to the client `install.sh` (re-running it performs an update) and uninstall SHALL delegate to the client `uninstall.sh`. For Claude Code and Codex, the installer SHALL print the client's marketplace CLI commands for each action and, only when the client binary is detected on `PATH`, MAY offer to run them; the installer SHALL NOT create or rely on a repo-side install script for these two clients. For Pi, the installer SHALL print and (under the same gating) run that client's own CLI against the npm registry. The offer to run these commands SHALL be presented as an interactive `[y/N]` prompt when a controlling terminal is available; in addition, when the opt-in `--yes` flag (alias `-y`) is set the installer SHALL execute those commands directly without prompting, including under headless invocation (e.g. `curl … | sh`), but still ONLY when the client binary is detected on `PATH`. When `--yes` is set but the client binary is absent, the installer SHALL print the commands and SHALL NOT execute anything. When `--yes` is not set and there is no controlling terminal, the installer SHALL only print the commands, as today.

The Codex CLI exposes the plugin verbs `codex plugin add <PLUGIN[@MARKETPLACE]>` (install), `codex plugin remove <PLUGIN[@MARKETPLACE]>` (uninstall), and `codex plugin marketplace upgrade <name>` (refresh the marketplace snapshot). There is NO `codex plugin install` / `codex plugin uninstall` / per-plugin `codex plugin update` subcommand. The installer SHALL therefore use `codex plugin add rembric@rembric` for install, `codex plugin remove rembric@rembric` for uninstall, and `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric` for update (the snapshot refresh alone does not re-install the cached plugin).

For Pi the installer SHALL use `pi install npm:@rembric/pi` for install **and for update** — the package spec SHALL carry no version, because a version-pinned spec is treated as pinned and is skipped by that client's own update commands, so a pinned install would silently freeze the operator. Reinstall is idempotent and is therefore also the correct action when the installed version is unknown. `--ref=<tag>` SHALL NOT be applied to this client's install command: the artifact comes from the registry, not from a git ref, and applying the ref would produce a pin whose consequence is the one this requirement forbids.

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

#### Scenario: Registry-CLI client install and update are the same unpinned command

- **WHEN** the user selects Install or Update for Pi
- **THEN** the printed command SHALL be `pi install npm:@rembric/pi` in both cases
- **AND** it SHALL carry no `@<version>` suffix, even when the installer was invoked with `--ref=<tag>`

#### Scenario: --yes executes the marketplace command headlessly when the binary is present

- **WHEN** the installer runs headless as `--agent=claude --action=update --yes` (or `-y`) and the `claude` binary is on `PATH`
- **THEN** it SHALL execute `claude plugin update rembric@rembric` directly without any prompt
- **AND** the same SHALL hold for Codex (`codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`), for Pi (`pi install npm:@rembric/pi`), and for the install/uninstall actions of each

#### Scenario: --yes with an absent binary executes nothing

- **WHEN** the installer runs headless as `--agent=codex --action=update --yes` and the `codex` binary is NOT on `PATH`
- **THEN** it SHALL print the marketplace command(s) and SHALL NOT execute anything

#### Scenario: Without --yes a headless run only prints

- **WHEN** the installer runs headless as `--agent=claude --action=update` (no `--yes`) and the `claude` binary is on `PATH`
- **THEN** it SHALL only print the marketplace command and SHALL NOT execute it

### Requirement: Supply-chain-safe distribution guidance

Because a `curl | sh` installer is a supply-chain surface, the documentation that publishes the installer command SHALL lead with the download-inspect-run two-step (download the script, inspect it, then run it) as the recommended path, and SHALL offer a tag-pinned URL alternative for reproducibility. On start the installer SHALL print the source ref it is operating against so the user can confirm what they ran.

The installer script itself SHALL NOT acquire an npm dependency, SHALL NOT declare or execute a lifecycle script, and SHALL NOT ship a published binary. Invoking a client's own CLI, which resolves that client's extension from the npm registry, is that **client's** install mechanism and is not an npm dependency of this capability: the installer holds no manifest, no lockfile, and no resolution of its own. Where the installer surfaces such a command, it SHALL name the exact package being installed so the operator can inspect it before consenting, and the outbound-publication requirements of `supply-chain-hygiene` govern what that package is allowed to be.

#### Scenario: Docs present the inspect-first alternative

- **WHEN** a reader follows the installer documentation in `README.md` or `docs/agents.md`
- **THEN** the docs SHALL show the download-inspect-run two-step and a tag-pinned URL alongside the one-line `curl | sh` form

#### Scenario: Installer announces its ref on start

- **WHEN** the installer starts
- **THEN** it SHALL print the git ref (e.g. `main` or a pinned tag) it will fetch artifacts from

#### Scenario: The installer has no manifest of its own

- **WHEN** the installer's own files are inspected at HEAD
- **THEN** there SHALL be no `package.json`, lockfile, or lifecycle script belonging to `apps/plugin/install.sh`
- **AND** any registry package the installer offers to install SHALL be named in full in the printed command

### Requirement: Headless agent CLI surface

The installer SHALL be fully drivable headlessly as a CLI so agents/automation can use it without the interactive TUI. Beyond the existing `--server` / `--agent=<list>` / `--action=install|update|uninstall` / `--up` / `--ref=<tag>` flags and `REMBRIC_NONINTERACTIVE`, it SHALL provide:

- `--status` — print the server status and the per-agent Rembric-plugin table (columns `AGENT` · `DETECTED` = agent found on this machine · `PLUGIN` = installed plugin version · `LATEST` = latest plugin version · `ACTION`) headlessly and exit, without entering the menu and without a banner. A caption SHALL make clear the action targets the plugin, not the agent.
- `--json` — with `--status`, emit a machine-readable object `{ "server": {…}, "agents": [...] }` and nothing else on stdout so it parses cleanly. The `server` object carries `state` (docker container state: `running`/`exited`/`paused`/`created`/`dead`/`absent`/`unknown`), `version` (the running/stopped container's image tag, or null), and `latest_release` (the newest published server release from GitHub Releases — tag `server-v<semver>` — or null). Each `agents` entry carries `agent`, `present` boolean, `installed` (semver or null), `available` (semver or null), `action`. The `agents` array SHALL carry one entry per client, in a stable order, for **all five** clients.
- `--token=<value>` — set `REMBRIC_ADMIN_TOKEN` for `--server` install verbatim instead of auto-generating; the value SHALL be written safely regardless of special characters, and a value shorter than 16 characters SHALL be refused with a clear error (the server's minimum) rather than producing a crash-looping server.
- `--port=<n>` — set `REMBRIC_PORT` in the generated `.env` for `--server`, and the printed dashboard URL SHALL reflect it.
- `--yes` (alias `-y`) — opt-in auto-confirm for the Claude Code / Codex marketplace run-through and for the Pi registry-CLI run-through. When set, the installer SHALL execute the client command(s) for the requested `--action` directly (no prompt), but ONLY when the client binary is detected on `PATH`; with an absent binary it prints and executes nothing. The flag SHALL default to off, so omitting it preserves the print-only headless behavior and the interactive `[y/N]` prompt on a real TTY. `--yes` SHALL NOT auto-start the Docker bring-up (that stays gated on `--up`).

`--action` SHALL accept a **closed set of verbs** — `install`, `update`, `uninstall` — held in ONE definition the usage text derives from, and an unrecognised value SHALL be refused **at parse time**, with a non-zero exit and a message naming the accepted verbs, before the banner is drawn and before any file is written or any client command is printed or run. `--server`, which has no uninstall backend, SHALL additionally refuse `--action=uninstall` rather than performing an install under an "uninstall" heading. Every internal `case` on the action SHALL carry a fail-closed arm as defence in depth: an unmatched POSIX `sh` `case` exits `0`, so without one an unhandled verb produces a successful run that did nothing (or, under `--yes`, an `eval` of an unassigned variable). In `--status --json` the per-agent `action` field carries the detected **state** (`none`/`update`/`install`/`ahead`/`unknown`), not a verb; the human-facing recommendation is derived from that state by the single mapping the version-detection requirement fixes.

The `--up` bring-up SHALL honour `REMBRIC_NO_PULL=1` to skip `docker compose pull` and use the locally-present image as-is (air-gapped operators, and the CI end-to-end test that brings the freshly-built image up). The installer SHALL report the server status (docker-observable state + running image tag) in `--status` and in the interactive Server screen. It SHALL also surface `latest_release` — the newest published server release from the GitHub Releases API (tag `server-v<semver>`), the same source the dashboard's update-check uses — on a **best-effort** basis: a single short-timeout `curl` (overridable via `REMBRIC_RELEASES_URL`), silently omitted when offline, rate-limited, `curl`-less, or when `REMBRIC_UPDATE_CHECK=off`. Because a running `:latest` image cannot be compared to a release without a digest, `latest_release` is informational; an "update available" hint is shown ONLY when the running tag is itself a semver older than `latest_release`. The server's "available" is NOT taken from the repo manifest (that is the source-tree version, not a published release). `--status` SHALL work regardless of TTY. An unknown flag SHALL exit non-zero with an error. `--help` SHALL document the full flag set, including `--yes`/`-y`.

#### Scenario: `--status --json` is clean machine-readable output

- **WHEN** an agent runs `install.sh --status --json`
- **THEN** stdout SHALL be a single JSON object with a `server` block (`state`/`version`/`latest_release`) and an `agents` array (one object per agent: `claude`, `codex`, `hermes`, `opencode`, `pi`)
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

#### Scenario: An unrecognised `--action` is refused before anything runs

- **WHEN** the installer is invoked with `--action=<not one of the accepted verbs>`, even together with `--yes` and a present client binary
- **THEN** it SHALL exit non-zero with an error naming the accepted verbs
- **AND** it SHALL NOT print or execute any client command, and SHALL NOT print the per-agent post-install steps
- **AND** the control — the same invocation with an accepted verb — SHALL exit `0` and execute the client command

#### Scenario: `--server` refuses an action it has no backend for

- **WHEN** the installer is invoked as `--server --action=uninstall`
- **THEN** it SHALL exit non-zero with an error stating that `--server` takes `install` or `update`
- **AND** no `./.env` SHALL be written

#### Scenario: `--help` documents the `--yes` flag

- **WHEN** a user runs `install.sh --help`
- **THEN** the usage output SHALL list `--yes` (and its `-y` alias) and describe it as the opt-in that runs the client commands (marketplace or registry CLI) when the binary is present

### Requirement: Per-agent post-install steps are surfaced

After a successful install or update (NOT uninstall), the installer SHALL print the required platform post-install steps for that agent, so the user is not left with a half-wired plugin. The steps SHALL reflect the action: install-only wiring (credential prompts, enabling the plugin) SHALL NOT be repeated on update, where the plugin is already installed and enabled. At minimum: Codex SHALL show trusting the 5 hooks via `/hooks` (hooks are stable and on by default as of `codex-cli 0.142.3+`; the removed `plugin_hooks` flag SHALL NOT be shown), plus exporting `REMBRIC_*`; Hermes install SHALL show `hermes plugins install rembric` (which triggers the `requires_env` credential prompts), then `hermes plugins enable rembric`, then a reminder to run `hermes gateway restart` so it loads the (new) plugin, while Hermes **update** SHALL show only `hermes gateway restart`; opencode install SHALL point at pasting the printed MCP block and exporting `REMBRIC_*` while opencode **update** SHALL only point at restarting opencode; Claude install SHALL note credentials are prompted (keychain) while Claude **update** SHALL only point at restarting Claude Code; **Pi install SHALL point at exporting `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell environment** — that client injects no environment from its own settings file, so there is no settings-file alternative to offer — **and Pi update SHALL only point at restarting the client.** The full walkthrough remains in `docs/agents.md`.

#### Scenario: Codex install prints the hook-trust step

- **WHEN** `--agent=codex --action=install` runs
- **THEN** the output SHALL include trusting the hooks via `/hooks`
- **AND** the output SHALL NOT instruct enabling the removed `plugin_hooks` flag

#### Scenario: Hermes install prints the requires_env + enable + gateway-restart steps

- **WHEN** `--agent=hermes --action=install` runs
- **THEN** the output SHALL include `hermes plugins install rembric`, `hermes plugins enable rembric`, and a reminder to run `hermes gateway restart`

#### Scenario: Hermes update only reminds to restart the gateway

- **WHEN** `--agent=hermes --action=update` runs
- **THEN** the output SHALL include `hermes gateway restart` and SHALL NOT repeat the install-only `hermes plugins install rembric` step

#### Scenario: Pi install prints the environment-variable step and no settings-file alternative

- **WHEN** `--agent=pi --action=install` runs
- **THEN** the output SHALL instruct exporting `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell environment
- **AND** it SHALL NOT suggest placing them in the client's settings file

#### Scenario: Uninstall omits post-install steps

- **WHEN** any `--action=uninstall` runs
- **THEN** no post-install "Next" steps SHALL be printed

### Requirement: `--action=update` without `--agent` updates every installed plugin that needs it

When the installer runs non-interactively with `--action=update` and either no `--agent` is given or `--agent=all` is given explicitly, it SHALL update every client plugin whose detected state (per the same `installed_version`/`available_version`/`vercmp` logic `--status` uses) is `update`, and SHALL skip every other client without erroring: `none` (already up to date), `install` (not installed), `ahead`, or `unknown`. The command SHALL exit `0` even when no plugin needs updating. This is the command `memory.about` advertises as `update_all` — it MUST succeed with no other flags.

A client whose installed version is `unknown` — which the version-detection requirement permits for the registry-CLI backend — SHALL be **skipped** by update-all with `unknown` as its stated reason, not silently reinstalled. Update-all is invoked unattended; reinstalling on ignorance would make it act on every run for a client it can never confirm. The skip line SHALL name the explicit command that forces it, and the verb it names SHALL come from the same state → verb mapping the status table uses (`--agent=<client> --action=install` for an unreadable install), so the hint cannot name a verb the parser refuses. When even the available version could not be read, no verb can be recommended and the line SHALL state the skip without a force hint rather than inventing one.

`--agent=<specific-clients>,…` (naming one or more of `claude,codex,hermes,opencode,pi` explicitly) SHALL remain unaffected by this requirement: it updates exactly the named clients regardless of their detected state, as before.

In the interactive menu, the Plugins section's agent-selection prompt SHALL include a first entry — `all — update outdated` — that triggers the same update-all behavior, presented directly below the already-rendered per-agent status table so the operator sees which agents will be touched before selecting it.

#### Scenario: Bare `--action=update` updates only the outdated agents

- **GIVEN** opencode is installed at a version older than the published one, and claude/codex/hermes/pi are not installed
- **WHEN** the installer runs `--action=update` with no `--agent`
- **THEN** it SHALL update opencode
- **AND** it SHALL report claude, codex, hermes, and pi as skipped (not installed) without error
- **AND** the process SHALL exit `0`

#### Scenario: Nothing needs updating

- **GIVEN** every installed plugin is already at the published version, and any others are not installed
- **WHEN** the installer runs `--action=update` with no `--agent`
- **THEN** it SHALL update nothing, report each agent's skip reason, and exit `0` — NOT an error

#### Scenario: An unknown installed version is skipped by update-all, not reinstalled

- **GIVEN** the registry-CLI client is present and its installed version is reported `unknown`
- **WHEN** the installer runs `--action=update` with no `--agent`
- **THEN** it SHALL skip that client with `unknown` as the stated reason
- **AND** it SHALL NOT run the install command for it
- **AND** the force hint it prints SHALL name a verb `--action` accepts
- **AND** the process SHALL exit `0`

#### Scenario: `--agent=all` is an explicit alias for the same behavior

- **WHEN** the installer runs `--agent=all --action=update`
- **THEN** it SHALL behave identically to `--action=update` with no `--agent` at all

#### Scenario: An explicit agent list is unaffected

- **WHEN** the installer runs `--agent=claude,codex --action=update`
- **THEN** it SHALL update exactly claude and codex, regardless of their detected `vercmp` state, exactly as before this change

#### Scenario: The interactive menu offers update-all

- **GIVEN** the operator has navigated to the Plugins section
- **WHEN** the "Which agent?" prompt is shown
- **THEN** its first entry SHALL be `all — update outdated`, appearing below the rendered status table
- **AND** selecting it SHALL run the same update-all behavior as the headless `--action=update` command
