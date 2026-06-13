---
name: rembric-tui-installer-e2e
description: Runnable end-to-end validation playbook for the Rembric TUI installer — catch breakage before merging/deploying, AND a sandboxed manual walkthrough to evaluate/iterate its UI/UX without polluting your real env. Apply before shipping any change touching `apps/plugin/install.sh`, the repo-root `install.sh` shim, any per-client `install.sh`/`uninstall.sh`, or distribution docs, or when you want to preview/try/demo the installer and polish how it looks and feels. Layered: CI-safe headless (vitest + `sh -n`), local install round-trips, operator interactive pty smoke, an optional full Docker `up` smoke, plus a sandboxed manual UX walkthrough. For the installer contract/what-not-to-break, see `rembric-tui-installer`.
---

# Rembric TUI installer — e2e validation

Run this before merging/deploying an install/distribution change so a regression is caught locally, not in a broken release. Layers are ordered by cost/feasibility — always run the headless + local layers; run the interactive + Docker layers when a real terminal / Docker is available.

`REPO=$(git rev-parse --show-toplevel)` in every snippet below.

## Layer 1 — Headless (CI-safe, always run)

```bash
# 1a. The headless test suite (args, preflight, server install incl. empty-token
#     refill, server update, agent routing, output degradation, root-shim parity).
cd "$REPO/apps/server" && pnpm vitest run ../../install.test.ts

# 1b. POSIX syntax — dash-compatible, no bashisms.
cd "$REPO"
sh -n install.sh
sh -n apps/plugin/install.sh
for f in apps/plugin/.*/install.sh apps/plugin/.*/uninstall.sh; do [ -f "$f" ] && sh -n "$f"; done
```

## Layer 2 — Local install round-trips (no network, throwaway HOME)

`REMBRIC_SRC` makes the installer read everything from the working tree (cp, no curl).

```bash
HOME_T=$(mktemp -d); CWD_T=$(mktemp -d)
# opencode install → version detectable → uninstall removes it, leaves config.
HOME="$HOME_T" REMBRIC_SRC="$REPO" REMBRIC_NONINTERACTIVE=1 sh "$REPO/install.sh" --agent=opencode --action=install
test -f "$HOME_T/.config/opencode/plugins/rembric.ts" || echo "FAIL: opencode not installed"
HOME="$HOME_T" REMBRIC_SRC="$REPO" REMBRIC_NONINTERACTIVE=1 sh "$REPO/install.sh" --agent=opencode --action=uninstall
test ! -f "$HOME_T/.config/opencode/plugins/rembric.ts" || echo "FAIL: opencode not removed"
# server prepare: token generated 64-hex, NO docker started (no --up).
( cd "$CWD_T" && REMBRIC_SRC="$REPO" REMBRIC_NONINTERACTIVE=1 sh "$REPO/install.sh" --server --action=install )
grep -qE '^REMBRIC_ADMIN_TOKEN=[0-9a-f]{64}$' "$CWD_T/.env" || echo "FAIL: token not generated"
rm -rf "$HOME_T" "$CWD_T"
```

## Layer 3 — Interactive pty smoke (operator / real terminal)

The arrow-key TUI needs a real `/dev/tty`. Drive it through a pseudo-terminal with `script` and assert the visuals. Keystrokes: `\033[B`=down, `\033[A`=up, `\r`=Enter, `q`=quit.

```bash
# Navigate: Plugins (down, enter) → quit submenu → quit. Capture and inspect.
printf '\033[B\rqq' | script -q /dev/null env REMBRIC_SRC="$REPO" sh "$REPO/install.sh" > /tmp/tui.out 2>&1
grep -aq '██' /tmp/tui.out      # lime BLOCK banner (under a tty; the literal "REMBRIC" only shows in the no-color fallback)
grep -aq '2J' /tmp/tui.out      # screen clears between steps (not stacked)
grep -aq 'AGENT' /tmp/tui.out  # plugins status table rendered
grep -aq 'bye' /tmp/tui.out     # clean exit, no hang
```

Eyeball a real run too: `REMBRIC_SRC="$REPO" sh "$REPO/install.sh"` in your terminal — banner, arrow navigation, each step replaces the screen, `Press Enter to continue` after actions.

## Layer 4 — Full Docker smoke (operator, and CI)

Brings a real server up via the installer's own `--up`, on an alternate port to avoid clobbering a running instance. See also `rembric-smoke-tests`. This layer now ALSO runs in CI (`.github/workflows/ci.yml` → `docker-build-check`): it loads the freshly-built image as `:latest` and runs `install.sh --server --up` with `REMBRIC_NO_PULL=1` (use the local image, no GHCR pull), asserting `/healthz` 200 + `/dashboard` 302. Use `REMBRIC_NO_PULL=1` locally too when you want the installer to reuse an image you already have instead of pulling.

```bash
T=$(mktemp -d); cd "$T"
REMBRIC_SRC="$REPO" REMBRIC_NONINTERACTIVE=1 sh "$REPO/install.sh" --server --action=install
printf 'REMBRIC_PORT=8799\n' >> .env
REMBRIC_SRC="$REPO" REMBRIC_NONINTERACTIVE=1 sh "$REPO/install.sh" --server --action=install --up
sleep 8
TOK=$(grep '^REMBRIC_ADMIN_TOKEN=' .env | cut -d= -f2)
curl -s -o /dev/null -w 'healthz %{http_code}\n' -H "Authorization: Bearer $TOK" http://127.0.0.1:8799/healthz   # expect 200
curl -s -o /dev/null -w 'dashboard %{http_code}\n' http://127.0.0.1:8799/dashboard                              # expect 302
docker compose down; cd "$REPO"; rm -rf "$T"
```

## Manual UX walkthrough (sandboxed)

To run the installer by hand and judge / iterate the **UI/UX** without touching your real `~/.config`, `~/.hermes`, `~/.claude`, or a running server. Isolation: `HOME` → a throwaway dir (plugin installs land there), cwd → a throwaway dir (server files land there), `REMBRIC_SRC` → the clone (no network). Cleanup is one `rm -rf`.

Source the setup script (it sets up the isolated sandbox and defines `rbx`), then just run `rbx`:

```bash
source .agents/skills/rembric-tui-installer-e2e/scripts/ux-sandbox.sh
rbx                       # launch interactive: arrow-key menu (↑/↓/j/k, Enter, q)
rbx --server --action=install   # or drive it headless with flags
rbx_clean                 # remove the sandbox when done
```

> **When this skill is invoked by the agent:** the interactive `rbx` must run in the user's own terminal (it needs a real `/dev/tty`) — the agent cannot define `rbx` in the user's shell. So the agent's job is to (a) run the automated layers above and report, and (b) tell the user to `source` the script and run `rbx` themselves. The script prints a "✓ sandbox ready — run `rbx`" confirmation when sourced.

Look at, per screen:

- **Banner/frame** — lime block REMBRIC + `source:` line; resize narrower to find the min width before it wraps badly.
- **Main menu** — `▸` highlight moves; entering a section **replaces** the screen (banner redraws on top), never stacks; `q` exits with `bye`.
- **Server → install** — dependency check (docker / docker compose / openssl); blank token → auto-generated 64-hex (printed); `Run … up -d? [y/N]` (decline to stay serverless); `Press Enter to continue…`.
- **Plugins** — aligned, version-aware status table; install→uninstall an opencode plugin and read the conservative "Left in place" line; Claude/Codex print marketplace commands.

Edge cases: `NO_COLOR=1 rbx --help` (no ANSI / plain wordmark); `printf 'REMBRIC_ADMIN_TOKEN=\n' > "$SANDBOX/work/.env" && rbx --server --action=install` (empty-token refill). Optional real server: see Layer 4 but point it at `$SANDBOX/work` and an alt `REMBRIC_PORT`.

Cleanup: `( cd "$SANDBOX/work" && docker compose down 2>/dev/null ); rm -rf "$SANDBOX"; unset SANDBOX; unset -f rbx`.

Turning feedback into edits — note the screen + the dimension (spacing/alignment · wording · colour/contrast · flow/step-count · "what next" discoverability · empty/error-state clarity); they map to `wordmark`/`banner`/`screen`/`arrow_menu`/`do_server`/`bring_up`/`print_table` in `apps/plugin/install.sh`. Re-run the headless layer after any tweak.

## Failure signatures to watch for

- **Non-zero exit on an agent action** (`install.sh --agent=… --action=install` exits ≠0) → a `set -e` regression: a helper ended on a false `[ test ]`. The interactive menu would kick the user out at that step.
- **Empty token written** to `.env`, or a bring-up offered/performed with an empty `REMBRIC_ADMIN_TOKEN`.
- **Hang under no-tty** (Layer 1/2 never returns) → the no-controlling-terminal path must fall to headless, not block on a key read.
- **Banner/table misalignment** → ANSI escapes counted in `printf` field width; pad on plain text.
- **Root shim dropping flags/env** → Layer 1 parity test (`root --help` == `plugin --help`; shim server-install generates a token) fails.
- **Stacked menus instead of screen-replace** → a missing `screen` call before an action/sub-menu.
