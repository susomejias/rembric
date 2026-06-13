## Why

The installer prints the Claude Code / Codex marketplace commands but only offers to run them when a real TTY is present. The canonical invocation is `curl … | sh`, where the script's stdin is the pipe, so `HAVE_TTY=0` and the interactive `Run these now? [y/N]` prompt never fires. There is currently no headless way to make the installer actually execute the marketplace command — agents and `curl|sh` users are always told to run it by hand. An opt-in flag closes that gap without changing the safe default.

## What Changes

- Add an opt-in `--yes` flag (alias `-y`) parsed into `ARG_YES`.
- In `marketplace_cmds` (Claude / Codex), when `--yes` is set **and** the client binary is present on `PATH`, execute the marketplace command(s) for the action directly — no prompt — in addition to printing them.
- Preserve the existing interactive path unchanged: when `--yes` is absent, a real TTY still shows the `[y/N]` prompt; headless without `--yes` still only prints.
- `--yes` with an **absent** client binary executes nothing (there is nothing to update) and only prints the commands — same conservative behavior as today.
- Document `--yes`/`-y` in `--help`/usage.
- The flag is scoped to the marketplace run-through; it does not auto-confirm the server bring-up (that stays gated on `--up`).

No breaking changes: every existing invocation behaves identically. This touches no append-only / scope / topic_key / judgment invariant — it is purely installer orchestration surface.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `tui-installer`: the "Per-client install / update / uninstall routing" requirement gains a headless opt-in (`--yes`) for the Claude/Codex marketplace run-through, still gated on binary presence; the "Headless agent CLI surface" requirement adds `--yes`/`-y` to the documented flag set and `--help`.

## Impact

- `apps/plugin/install.sh` — flag parsing (`ARG_YES`), the run-gate in `marketplace_cmds`, and the `usage` text.
- `install.test.ts` (repo root) — new headless cases using the existing fake-binary-on-PATH pattern (mirror `fakeDockerDir`): `--yes` executes when the `claude`/`codex` binary is present; without `--yes` it only prints; `--yes` with an absent binary executes nothing.
- `openspec/specs/tui-installer/spec.md` — delta on the two requirements above.
- Docs that publish the headless flag set (`README.md`, `apps/plugin/README.md`, `docs/agents.md`) gain a mention of `--yes` where the flag list lives.
- No new dependency, lifecycle script, or published binary. Orchestrator model preserved — still delegates to the marketplace CLIs, does not reimplement client logic. POSIX `sh`, `set -eu`, `sh -n`-clean.
