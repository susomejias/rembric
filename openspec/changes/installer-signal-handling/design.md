## Context

POSIX shell semantics are the crux of this bug: `trap 'cmd' INT` runs `cmd` on `SIGINT`, but once ANY trap is installed for a signal, the shell's default disposition for that signal (terminate) is suppressed — execution resumes after the trap unless the trap itself calls `exit`. The original `arrow_menu` trap combined `EXIT INT TERM` into one restore-only command, so Ctrl-C restored the terminal but never stopped the `read_key` loop.

## Goals / Non-Goals

**Goals:**

- Make Ctrl-C (and `SIGTERM`) actually terminate the installer from inside the arrow-key menu and the banner animation, while still restoring the terminal.
- Prove the fix with the same technique that found the bug (a real pty), not just code review.

**Non-Goals:**

- Not building a permanent, committed pty-based regression test. This repo's test suite is Node/Vitest; a pty harness needs either a new native dependency (`node-pty`, subject to the npm-security-best-practices review before adding) or a non-Node test runner (Python), either of which is a bigger infrastructure decision than this two-function bug fix warrants. Flagged as a separate future opportunity, not bundled here.

## Decisions

### D1. Split the trap by signal, exit explicitly on INT/TERM

```sh
trap 'stty "$_saved" </dev/tty 2>/dev/null; printf "\033[?25h" >/dev/tty' EXIT
trap 'stty "$_saved" </dev/tty 2>/dev/null; printf "\033[?25h" >/dev/tty; exit 130' INT TERM
```

`EXIT` stays restore-only (it already runs at the natural end of every code path — normal loop exit already calls `trap - EXIT INT TERM` before returning, so the EXIT trap only fires on an actual process exit). `INT`/`TERM` restore then `exit 130` (the conventional 128+SIGINT exit code) — the explicit `exit` is what was missing.

**Alternative considered:** re-raise the signal (`trap - INT; kill -INT $$`) instead of a hardcoded `exit 130`, to preserve exact signal semantics for a wrapping process. Rejected for simplicity: this script has no wrapping process that inspects the specific signal (the root `install.sh` shim `exec`s or fetches-then-runs this script directly; `curl | sh` doesn't inspect child exit codes either), and `exit 130` is the standard, portable convention every caller already expects from an interrupted CLI tool.

### D2. Same fix for `_wm_anim`

The banner-reveal animation hides the cursor for its ~0.3s duration with no trap at all — an interrupt during that window left the cursor hidden. Same split-trap pattern; verified it doesn't change the animation's normal (non-interrupted) behavior.

## Verification (the actual e2e evidence, not just code review)

Per the `rembric-tui-installer-e2e` playbook:

- **Layer 1** — `pnpm vitest run install.test.ts` (50 tests) and `sh -n apps/plugin/install.sh` both clean.
- **Layer 2** — local install/uninstall round-trip (opencode) and server-prepare token generation, both via `REMBRIC_SRC` (no network): clean.
- **Layer 3** — two pty probes (Python `pty.fork()`, since this sandbox's `script` binary is util-linux and doesn't accept the skill's BSD-style invocation):
  - Standard navigate + quit smoke (down, Enter, q, q): banner, screen-clear, status table, and clean `bye` exit all present — unaffected by this change.
  - **The regression itself**: send `\x03` at the main menu, wait up to 5s for the child to exit.
    - Against the pre-fix script (verified by `git stash`-ing the fix and re-running): process does **not** exit within 5s — reproduces the bug exactly as reported.
    - Against the fixed script: process exits with code 130 within ~1s.

## Migration Plan

No migration — shell script only, no schema/data change. Rollback is a plain revert.
