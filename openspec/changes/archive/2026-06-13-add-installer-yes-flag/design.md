## Context

`marketplace_cmds()` in `apps/plugin/install.sh` prints the Claude/Codex marketplace commands and conditionally runs them:

```sh
if [ "$NONINTERACTIVE" = "0" ] && [ "$HAVE_TTY" = "1" ] && client_present "$c"; then
  yn=$(ask "  Run these now? [y/N]")
  case "$yn" in y|Y) [ -n "${add:-}" ] && eval "$add" || true; eval "$cmd" || true ;; esac
fi
```

`HAVE_TTY` is set from `{ true >/dev/tty; } 2>/dev/null && { [ -t 0 ] || [ -t 1 ]; }`. Under `curl … | sh` there is no controlling terminal, so `HAVE_TTY=0` and the block is skipped — the commands are only printed. opencode/Hermes are unaffected (they delegate to a file-copying `install.sh`, no prompt). This is the gap: no headless path executes the marketplace command.

Constraints: POSIX `sh` under `set -eu`, `sh -n`-clean, no bashisms; the orchestrator must keep delegating (no inlined client logic); the root shim must pass the new flag through unchanged (it already forwards `"$@"` verbatim, so no shim edit is needed).

## Goals / Non-Goals

**Goals:**

- A single opt-in flag (`--yes`, alias `-y`) that makes headless runs execute the Claude/Codex marketplace command for the requested action when the binary is present.
- Zero change to every existing invocation: no flag → identical behavior (print-only headless, `[y/N]` on a TTY).
- Headless test coverage of the new path.

**Non-Goals:**

- Auto-confirming the server bring-up (stays on `--up`).
- Running anything for opencode/Hermes via `--yes` (they have no marketplace prompt; their delegation already runs unconditionally).
- Executing marketplace commands when the binary is absent (nothing to update; keep printing).

## Decisions

**1. New flag `--yes` / `-y` → `ARG_YES` (default 0).** Parsed in the existing `for arg in "$@"` loop alongside `--up`/`--status`. Chosen over reusing `REMBRIC_NONINTERACTIVE` because that env var means "no TTY / flag-driven", which is orthogonal to "I consent to side effects". A dedicated opt-in keeps the safe default and reads clearly in automation. `-y` alias matches the universal convention.

**2. Re-shape the run-gate as `if … elif`, not a new branch.**

```sh
if [ "$ARG_YES" = "1" ] && client_present "$c"; then
  [ -n "${add:-}" ] && eval "$add" || true
  eval "$cmd" || true
elif [ "$NONINTERACTIVE" = "0" ] && [ "$HAVE_TTY" = "1" ] && client_present "$c"; then
  yn=$(ask "  Run these now? [y/N]")
  case "$yn" in y|Y) [ -n "${add:-}" ] && eval "$add" || true; eval "$cmd" || true ;; esac
fi
```

`--yes` takes precedence so a TTY user passing `-y` is not re-prompted. The `client_present` guard is duplicated into both arms intentionally — when `--yes` is set but the binary is absent, the `if` is false and the `elif` is also false under headless (HAVE_TTY=0), so nothing runs and only the earlier `say "  Run:"` print stands. Alternative considered (single `RUN=1` variable computed up front) rejected: the two arms differ (prompt vs. no prompt), so the branch is clearer than a flag-and-prompt combo.

**3. `set -e` safety.** Both arms already terminate in `eval … || true` or a closed `case … esac`; the function still ends with `return 0`. The new `if`/`elif` test expressions never leave a bare false `[ … ]` as the function's last command. No regression to the menu-abort invariant.

**4. Scope `--yes` to `marketplace_cmds` only.** The server bring-up is already a separate gate (`--up`), so `--yes` deliberately does not touch it. This keeps "consent to run a plugin CLI" distinct from "consent to start Docker".

## Risks / Trade-offs

- [A user passes `--yes` expecting it to also bring the server up] → `--help` text scopes `--yes` to the marketplace run-through and names `--up` for the server; the spec records the non-goal.
- [`eval` on the marketplace command in automation runs a real CLI side effect] → It is opt-in and gated on `command -v <binary>`; the command string is a fixed literal (`marketplace_cmds` builds `$cmd` from hardcoded strings, no user interpolation), so there is no injection surface beyond what the user already types as `--agent`/`--action`.
- [Test executing a real `claude`/`codex`] → Tests put a fake binary (a shell script echoing a sentinel) first on `PATH`, mirroring the existing `fakeDockerDir` pattern; no real client is invoked.

## Migration Plan

Pure additive flag; no data, no migration, no rollback concern. Shipping it is landing the edited `install.sh` + tests. The repo-root shim forwards `"$@"`, so it needs no change. Validate with the `rembric-tui-installer-e2e` headless layer (`install.test.ts` + `sh -n`) before merge.

## Open Questions

None.
