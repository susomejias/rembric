## 1. Flag parsing

- [x] 1.1 In `apps/plugin/install.sh`, add `ARG_YES=0` to the flag defaults block (alongside `ARG_UP=0`).
- [x] 1.2 In the `for arg in "$@"` parse loop, add `--yes|-y) ARG_YES=1 ;;` (before the catch-all `*)` error arm).

## 2. Run-gate in marketplace_cmds

- [x] 2.1 In `marketplace_cmds()`, replace the single TTY-gated run block with an `if … elif`: the `if [ "$ARG_YES" = "1" ] && client_present "$c"` arm `eval`s `$add` (when set) then `$cmd` with no prompt; the `elif [ "$NONINTERACTIVE" = "0" ] && [ "$HAVE_TTY" = "1" ] && client_present "$c"` arm keeps the existing `ask`/`[y/N]` path verbatim.
- [x] 2.2 Confirm the function still ends with `return 0` and neither arm leaves a bare false `[ … ]` as the last command (so `set -e` does not abort the menu).

## 3. Usage / help text

- [x] 3.1 Add `--yes, -y` to the `Flags:` list in `usage()` with a one-line description: opt-in that runs the Claude/Codex marketplace commands when the binary is present (does not start Docker — use `--up`).

## 4. Tests (install.test.ts)

- [x] 4.1 Add a `fakeClientBinDir(name)` helper (mirroring `fakeDockerDir`) that writes an executable shell script named `claude`/`codex` echoing a sentinel like `RAN:$*`, returns its dir, and is placed first on `PATH`.
- [x] 4.2 Test: `--agent=claude --action=update --yes` with the fake `claude` on PATH → output contains the executed sentinel (`RAN:plugin update rembric@rembric`).
- [x] 4.3 Test: `-y` alias behaves identically to `--yes` for the same case.
- [x] 4.4 Test: `--agent=codex --action=update --yes` with the fake `codex` on PATH → output contains the executed sentinel for `codex plugin marketplace upgrade rembric`.
- [x] 4.5 Test: `--agent=claude --action=update` WITHOUT `--yes` (fake `claude` on PATH) → output contains the printed command but NOT the executed sentinel.
- [x] 4.6 Test: `--agent=codex --action=update --yes` with NO `codex` on PATH (scrubbed PATH) → output prints the command but contains no executed sentinel.
- [x] 4.7 Test: `--help` output contains `--yes` and `-y`.

## 5. Docs

- [x] 5.1 Add `--yes`/`-y` to the headless flag list wherever it is enumerated in `README.md`, `apps/plugin/README.md`, and `docs/agents.md` (search for `--action=` / `--status` flag tables; only the flag-list spots, not a new section).

## 6. Validation

- [x] 6.1 `sh -n apps/plugin/install.sh` and `sh -n install.sh` (root shim) are clean.
- [x] 6.2 `pnpm vitest run install.test.ts` passes, including the new cases.
- [x] 6.3 `pnpm run lint` and `pnpm run typecheck` pass.
- [x] 6.4 Run the `rembric-tui-installer-e2e` headless layer per the skill (the `install.test.ts` suite is the CI gate); record the result.
