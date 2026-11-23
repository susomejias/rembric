# tui-installer

## Purpose

The orchestrator `install.sh` entry point for the Rembric server and all client plugins: a single copy-pasteable POSIX `sh` installer that prepares the server files and routes per-client install / update / uninstall to each client's own primitives.

## Requirements

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

### Requirement: Server flow prepares files, generates the token, and optionally brings the stack up

The installer's server install option SHALL download `docker-compose.yml` and `.env.example` from the install ref into the current directory and write a `.env` derived from `.env.example` with `REMBRIC_ADMIN_TOKEN` set. The token SHALL be either a value the user pastes or, when none is given, one the installer auto-generates (`openssl rand -hex 32`, falling back to an `od`/`/dev/urandom` hex string when `openssl` is absent). An existing `.env` whose `REMBRIC_ADMIN_TOKEN` is non-empty SHALL be left untouched; an existing `.env` whose token is **empty** (e.g. left half-written by an interrupted earlier run) SHALL be treated like a fresh one and have the token filled in, so the installer is safely re-runnable and never proceeds with an empty token. The effective admin token SHALL be displayed to the user in every case — generated, pasted, or read back from `.env` — since it is required to log into the dashboard; on a successful bring-up it SHALL also be echoed alongside the dashboard URL. `REMBRIC_ADMIN_TOKEN` is the only required variable; the installer SHALL NOT prompt for any other env value. The installer SHALL then bring the stack up ONLY when `docker` is on `PATH` AND the user has confirmed (an interactive `[y/N]` prompt, or the `--up` flag under non-interactive mode); the bring-up SHALL run `docker compose pull` first on a best-effort basis (so a stale local `:latest` tag cannot shadow the published image; silently skipped when offline); immediately before running `docker compose up -d` it SHALL ensure `./data` (the bind-mount source for the container's `/data`) exists and is accessible to the container's non-root `UID 10001`, so a rootful Linux Docker host that would otherwise auto-create `./data` as `root:root` does not leave the server unable to open its SQLite DB: `mkdir -p ./data`, then attempt `chown 10001:10001 ./data`. When that `chown` fails (no root/`CAP_CHOWN` — the common case for a non-root invocation), the installer SHALL check `./data`'s current owning UID before deciding whether anything needs fixing: if the owner is ALREADY `10001` (e.g. a prior manual `chown`, or the directory was already correct), it SHALL leave the directory untouched and print nothing — a `chown` failure alone does not imply a problem, and re-running the installer on an already-working install SHALL NEVER relax its permissions. ONLY when the owner is something else SHALL it fall back to `chmod 0777 ./data`, and in that case it SHALL print an explicit warning naming the fallback and the command to tighten it later (`sudo chown -R 10001:10001 ./data`) — the fallback SHALL NOT be applied silently. It SHALL then run `docker compose up -d`. On success it SHALL print the dashboard URL. When Docker is absent or the user declines, the installer SHALL instead print the exact `docker compose pull && docker compose up -d` command and SHALL NOT execute any `docker` command, and SHALL NOT create or modify `./data`. The installer SHALL NOT require Docker to be installed. The server update option SHALL re-fetch `docker-compose.yml` and offer the SAME gated bring-up (`docker compose pull && docker compose up -d`, gated on `docker compose` availability and confirmation/`--up`, including the same `./data` preparation step); when the current directory has no `./.env` the update SHALL NOT bring the server up and SHALL direct the user to run install first.

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

#### Scenario: Bring-up prepares an accessible data directory before starting containers, preferring chown over chmod

- **WHEN** a bring-up actually runs `docker compose up -d` (install or update, with `docker compose` available and confirmed/`--up`) and `chown 10001:10001 ./data` succeeds
- **THEN** the installer SHALL create `./data` if missing, chown it, and proceed to `docker compose up -d` WITHOUT relaxing its permissions and WITHOUT printing any fallback warning
- **AND** this preparation SHALL run on every such bring-up (install or update), not only when `./data` is freshly created — so a directory left root-owned by a pre-fix crash loop is healed on a re-run

#### Scenario: Bring-up falls back to a world-writable data directory only when chown is not possible AND the owner genuinely isn't uid 10001, and warns explicitly

- **WHEN** a bring-up actually runs `docker compose up -d`, `chown 10001:10001 ./data` fails (no root/`CAP_CHOWN`), and `./data`'s current owner is NOT uid `10001`
- **THEN** the installer SHALL `chmod 0777 ./data` before invoking `docker compose up -d`
- **AND** it SHALL print a warning identifying the fallback and a `sudo chown -R 10001:10001 ./data` hint to tighten it later
- **AND** it SHALL NOT apply this relaxed permission silently (the warning is never suppressed)

#### Scenario: A chown failure against an already-correctly-owned data directory never regresses its permissions

- **GIVEN** `./data` already exists and is owned by uid `10001` (a prior manual `chown`, or an already-working install)
- **WHEN** a bring-up actually runs `docker compose up -d` under a non-root invocation, so `chown 10001:10001 ./data` fails
- **THEN** the installer SHALL leave `./data`'s ownership and permissions completely unchanged
- **AND** it SHALL NOT print the chmod-fallback warning
- **AND** it SHALL proceed to `docker compose up -d` without modifying `./data`

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

### Requirement: Supply-chain-safe distribution guidance

Because a `curl | sh` installer is a supply-chain surface, the documentation that publishes the installer command SHALL lead with the download-inspect-run two-step (download the script, inspect it, then run it) as the recommended path, and SHALL offer a tag-pinned URL alternative for reproducibility. On start the installer SHALL print the source ref it is operating against so the user can confirm what they ran.

No part of this capability SHALL add an npm dependency, a lifecycle script, or a published binary.

Invoking a client's own CLI, which resolves that client's extension from the npm registry, does not breach that: it is the **client's** install mechanism, and this capability holds no manifest, no lockfile and no resolution of its own. Where the installer surfaces such a command, it SHALL name the exact package being installed so the operator can inspect it before consenting, and the outbound-publication requirements of `supply-chain-hygiene` govern what that package is allowed to be.

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

### Requirement: The TUI is the canonical single documented install path

The installer at `apps/plugin/install.sh`, fronted by root `install.sh`, SHALL remain the primary canonical path for install/setup/update/uninstall of the server and every client. Docs SHALL lead with it. Claude/Codex marketplace commands, opencode shell scripts, Hermes native plugin commands, Pi's unpinned registry CLI and manual Docker commands SHALL appear only as explicitly labelled manual/advanced fallback. Hermes shell adapters SHALL not constitute a separate file-copy backend. Existing shared bridge/hooks and non-Hermes primitives SHALL remain unchanged.

#### Scenario: Docs lead with the installer

- **WHEN** a reader opens root/plugin READMEs or client sections in `docs/agents.md`
- **THEN** the root TUI SHALL be the first installation instruction and per-client commands SHALL appear only under manual/advanced headings

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

### Requirement: Hero tagline and one-time banner reveal

In colour mode the header SHALL show, under the lime block wordmark, a two-line hero tagline describing Rembric (the GitHub one-liner: "Persistent memory for AI coding agents — self-hosted, MCP-native, append-only. One Docker image, one SQLite file."). On the FIRST render in an interactive terminal the block wordmark MAY animate as a top-to-bottom reveal (a short per-row delay); the reveal SHALL play at most once per run and SHALL be skipped entirely in headless mode, under `--status`/`--json`, when `NO_COLOR` is set, or when stdout is not a terminal. The plain/degraded wordmark SHALL show neither the tagline nor the animation.

#### Scenario: Tagline and reveal are interactive-only

- **WHEN** the installer runs headless, under `--status`, or with `NO_COLOR`
- **THEN** no reveal animation SHALL occur and the hero tagline SHALL NOT be printed (output is the plain wordmark line, or for `--status` the payload only)

#### Scenario: Reveal plays at most once

- **WHEN** the interactive menu redraws the banner across navigation steps
- **THEN** only the first render MAY animate; subsequent redraws SHALL be instant

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

### Requirement: bring-up MUST verify application health before reporting success

After `docker compose up -d` succeeds, the installer SHALL poll the authenticated `/healthz` endpoint on `127.0.0.1:<configured-port>` using the admin token it holds, with a bounded per-attempt timeout and a bounded total ceiling (≈30 s, sized for first-boot embedding-model load). The installer SHALL print the success banner (dashboard URL, token echo) ONLY after `/healthz` returns `{ok:true}`; on ceiling expiry it SHALL print a failure diagnostic pointing at `docker compose logs` and SHALL NOT claim the stack is up. The poll loop SHALL be POSIX-sh and `set -e`-safe.

#### Scenario: Container starts but the app crashes on boot

- **WHEN** `docker compose up -d` exits 0 but the server process crashes before binding (e.g. invalid `.env` or failed migration)
- **THEN** the installer SHALL report bring-up failure with a `docker compose logs` hint and SHALL NOT print the dashboard URL/success banner

#### Scenario: Healthy bring-up reports the server version

- **WHEN** `/healthz` responds `{ok:true,version:<v>}` within the ceiling
- **THEN** the installer SHALL print the success banner including `<v>`

### Requirement: Installer network fetches MUST be time-bounded and retried

The artifact `fetch()` helper in `apps/plugin/install.sh` and the root shim's script download SHALL use bounded curl options (`--max-time` and `--retry` with connection-refused retries). No installer network call SHALL be able to hang indefinitely.

#### Scenario: Stalled raw.githubusercontent connection

- **WHEN** an artifact download stalls
- **THEN** curl SHALL abort at the configured `--max-time`, retry up to the configured count, and on final failure the installer SHALL surface its existing fetch-error path instead of hanging

### Requirement: `--port` MUST be validated at argument parse time

The installer SHALL reject a non-numeric or out-of-range (`<1`, `>65535`) `--port` value with a clear error at parse time, before writing anything to `.env`.

#### Scenario: Alphabetic port value

- **WHEN** the installer is invoked with `--port=abc`
- **THEN** it SHALL exit with an error naming the invalid value and SHALL NOT modify `.env`

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

### Requirement: Hermes unsupported source requests fail before mutation

Hermes mutation requests SHALL reject `REMBRIC_SRC`, `PLUGIN_SRC`, `REMBRIC_REF` or an explicit `--ref` before any client/server/config mutation in the requested transaction. This stage SHALL support only default unpinned native distribution. It SHALL not silently reinterpret a local tree, tag, branch or SHA, even an explicitly supplied `main`. Read-only status/help SHALL remain available. Other clients' source/ref contracts SHALL remain unchanged.

#### Scenario: Unsupported mixed-client transaction

- **WHEN** a mutating transaction includes Hermes and an explicit ref or local source
- **THEN** it SHALL fail with a clear unsupported-operation diagnostic before modifying any selected client or server

#### Scenario: Supported default native transaction

- **WHEN** Hermes mutation uses the default source without an explicit ref/local override
- **THEN** it SHALL proceed through binary-presence, provenance and consent gates
