## MODIFIED Requirements

### Requirement: TTY-aware interactivity with non-interactive fallback

Because `curl … | sh` makes the script's stdin the pipe, the installer SHALL read all interaction from `/dev/tty` rather than stdin. When a controlling terminal is available, the installer SHALL present an interactive menu navigated with the arrow keys: it SHALL put `/dev/tty` into raw mode (`stty -echo -icanon`), decode the up/down cursor escape sequences (and accept `j`/`k` and Enter), redraw the highlighted selection in place, and restore the saved terminal state and cursor on every exit path. An interrupt (`SIGINT`/`SIGTERM`, e.g. Ctrl-C) SHALL itself count as an exit path: the installer SHALL restore the terminal state AND terminate the process (a caught signal with only a restore-and-continue trap does NOT terminate a shell by default — the interactive loop would otherwise keep running in a now-broken cooked-mode state). When raw mode cannot be entered (no `stty`, or `/dev/tty` is not a real terminal) the installer SHALL fall back to a numbered prompt read from `/dev/tty`. When there is no controlling terminal at all OR `REMBRIC_NONINTERACTIVE=1` is set, the installer SHALL run non-interactively, driven by flags: `--server`, `--agent=<name>[,<name>…]` (one or more of `claude,codex,hermes,opencode`), and `--action=install|update|uninstall`. Under non-interactive mode the installer SHALL refuse to act on ambiguous or empty input, exiting non-zero with a usage message rather than guessing.

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
