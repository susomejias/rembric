## Why

Pressing Ctrl-C inside the TUI installer's arrow-key menu didn't exit the process: the terminal trap restored cooked mode but a caught `INT`/`TERM` signal with a trap installed does not terminate a shell by default, so `read_key`'s loop kept running — now in cooked mode, requiring Enter per keystroke and echoing input, effectively stuck until `q`+Enter or an external kill. Reproduced and fixed with a real pty (a Python `pty.fork()` harness sending `\x03` at the main menu): before the fix the process never exits within 5s; after the fix it exits with code 130 within the same window. The same fix applies to the banner-reveal animation's cursor-hide, which had no signal trap at all.

## What Changes

- **`arrow_menu` (`apps/plugin/install.sh`).** Split the terminal-restore trap: `EXIT` still restores `stty`/cursor only; `INT`/`TERM` restore AND then `exit 130`, so the process actually terminates instead of resuming the read loop in a broken state.
- **`_wm_anim` (the banner reveal).** Same split, guarding the cursor-hide (`\033[?25l` / `\033[?25h`) — previously had no trap at all, so an interrupt mid-reveal left the cursor hidden.

Validated per the `rembric-tui-installer-e2e` playbook: Layer 1 (headless suite + `sh -n`), Layer 2 (local install round-trips), and Layer 3 (interactive pty — both the standard navigate-and-quit smoke and a dedicated Ctrl-C probe, confirmed to reproduce the bug on the pre-fix script and pass on the fixed one).

No breaking changes. No change to any flag, env var, or non-interactive behavior.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `tui-installer`: MODIFY the "TTY-aware interactivity with non-interactive fallback" requirement — "restore the saved terminal state and cursor on every exit path" is refined to say explicitly that an interrupt (`INT`/`TERM`) is itself an exit path: the terminal SHALL be restored AND the process SHALL terminate, not merely have its trap fire while execution continues.

## Impact

- `apps/plugin/install.sh` — `arrow_menu`'s and `_wm_anim`'s signal traps.
- Issue: #259.
