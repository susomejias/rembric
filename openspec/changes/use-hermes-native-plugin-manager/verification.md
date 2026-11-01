# Verification

## Implemented scope

The canonical TUI delegates Hermes distribution to its native CLI through one source-validating adapter. Recognized legacy MCP repair remains after successful update. Provider lifecycle, MCP transport, bridge pins and summary runtime are unchanged by this distribution change.

## Evidence

- Worker reported focused RED: 11 failures / 1 pass, then GREEN: 12/12. Parent independently ran the expanded installer suite: **120/120**, Python uninstall **3/3**, four `sh -n` checks and strict OpenSpec validation (job-13, exit 0).
- Official isolated image: `nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d`; Hermes **v0.22.5**, upstream **bf0203a7**, Python **3.14.9**. Containers run as UID 10000 with all capabilities dropped, no-new-privileges, scratch HOME/HERMES_HOME, no host mounts or published ports, and synthetic settings only.
- Native CLI controls (job-10, exit 0): install with `--enable`, metadata source/revision/pin checks, update returning already current, removal and repeated-removal refusal. Copied installation and `adopt` refused without changing files; explicit backup/move-aside/reinstall preserved operator-file controls and backups. Unrelated config/MCP values and exact `.env` bytes survived each operation.
- Current adapter snapshot (job-12, exit 0): real native install/update/remove, already-absent uninstall no-op, and copied-target refusal for install/update/uninstall, with config/MCP/credential preservation. Source: `/tmp/rembric-hermes-adapter-control.py`. A later adapter change rejects unexpected positional arguments before mutation; final regressions must cover it.
- PTY navigation (job-11, exit 0): isolated HOME/HERMES_HOME/XDG/cwd, down + Enter into Plugins, then quit twice; assertions for block banner, screen clearing, agent table and clean exit. Evidence: `/tmp/rembric-hermes-pty.EondUX/tui.out`.
- Local round trips (job-14, exit 0): opencode install/uninstall from working tree, server preparation without `--up`, generated-token shape, and parseable status JSON. Evidence: `/tmp/rembric-installer-local.a7WKun`.

## Review correction and remaining checks

Parent reproduced a test-isolation defect: `nativeRun(absent=true)` inherited the host PATH. With a harmless `hermes` stub returning 99 on inherited PATH, the absent-client test failed (1 failed / 119 skipped). The fixture now uses its stub directory plus `CORE_PATH` when testing absence. The immediate targeted verification timed out at 30 seconds; this is not recorded as GREEN. After continuation, the full installer suite under the same adversarial PATH passed **120/120**, followed by `pnpm run typecheck`, `pnpm run lint` and `pnpm test` (job-15, exit 0; Hermes suite **113/113**). The absent-client test also retains a harmless inherited-client sentinel as a permanent regression control.

Safety mutations first caught 9/11 adapter mutations and exposed missing direct-adapter coverage for unexpected arguments and source-override environment variables. Four direct-boundary cases were added. The completed second series caught **14/14** mutations (11 adapter, 3 orchestrator), with named failing tests and SHA256-verified restoration after each file's series (job-17, exit 0). It used `scripts/mutate.mjs` and a temporary `pnpm` launcher adding `--root ../..` so Vitest exercises the root installer suite rather than its excluded web-project default. No repository runner/configuration was changed. Final restored-tree checks (job-19) passed **124/124 installer tests**, **113/113 Hermes tests**, typecheck, lint, shell syntax and strict OpenSpec validation. Its final `git diff --check` found one blank line at EOF in the adapter; that whitespace was removed and `git diff --check` plus shell syntax passed afterward. Active LSP diagnostics for the changed installer tests reported no errors. No commit, push or release has occurred.

## Limits

Hermes's native update checker reports a fresh subdirectory installation as provenance `drift` because it lacks `.git`. The TUI therefore reports unknown update state and skips Hermes during update-all; explicit actions validate the observed native metadata. Only an already-current update was executed: **actual version advancement was not demonstrated**.

These distribution checks do not exercise an LLM or a live gateway conversation. The separately reproduced premature-session-end mechanisms are not fixed by this change and must not be reported as fixed by its acceptance results.
