## 1. Root install.sh shim

- [x] 1.1 Create repo-root `install.sh` (POSIX `sh`): a thin forwarder that, when `apps/plugin/install.sh` exists next to it (clone), `exec`s it with `"$@"`; otherwise fetches `apps/plugin/install.sh` from the same ref (honour `REMBRIC_REF`/`--ref`) and runs it. No menu/token/client logic of its own. `chmod +x`.
- [x] 1.2 Pass-through check: `sh install.sh --server --action=install` (headless) behaves identically to `sh apps/plugin/install.sh --server --action=install`; flags + env (`REMBRIC_SRC`, `REMBRIC_NONINTERACTIVE`, `--up`, `--ref`, `NO_COLOR`) reach the real script unchanged. `sh -n install.sh` passes.
- [x] 1.3 Extend `install.test.ts` (repo root) with a shim case: running the root `install.sh` headless yields the same result as the plugin installer for at least one flow (e.g. `--server --action=install` token generation, or `--help`).

## 2. CLAUDE.md

- [x] 2.1 Add a one-line rule (in the Plugin development discipline section): install / setup / upgrade / uninstall is done via the TUI (`apps/plugin/install.sh`, root `install.sh` shim); any change touching install/distribution MUST first verify it doesn't break the installer (`install.test.ts` + a manual/e2e run). Point at the new skill.

## 3. Skill: rembric-tui-installer (contract / reference)

- [x] 3.1 Create `.agents/skills/rembric-tui-installer/SKILL.md`: trigger description (install/setup/upgrade/uninstall, `install.sh`, distribution docs), the orchestrator model (delegates to per-client primitives; never duplicates them), the headless test surface (`install.test.ts`), how to run it locally (`REMBRIC_SRC`), and the "what not to break" checklist (token flow incl. empty-token refill, version detection, conservative uninstall, screen/arrow UX, TTY/headless fallback, root-shim pass-through).
- [x] 3.2 Symlink it into `.claude/skills/`: `ln -s ../../.agents/skills/rembric-tui-installer .claude/skills/rembric-tui-installer` (NEVER author under `.claude/skills/` directly). Verify the Skill tool surfaces it.
- [x] 3.3 Cross-link: the skill references `rembric-plugin-development` and `rembric-tui-installer-e2e` so the three don't duplicate.

## 4. Skill: rembric-tui-installer-e2e (runnable validation playbook)

- [x] 4.1 Create `.agents/skills/rembric-tui-installer-e2e/SKILL.md`: when to apply (before merging/deploying any change touching `install.sh`, the root shim, per-client install/uninstall, or distribution docs). Encode the layered procedure:
  - **CI-safe (headless):** `cd apps/server && pnpm vitest run ../../install.test.ts`; `sh -n install.sh apps/plugin/install.sh apps/plugin/.*/install.sh apps/plugin/.*/uninstall.sh`.
  - **Local/operator (interactive pty):** drive the arrow menu via `script -q /dev/null` with keystrokes (`\033[B`=down, `\r`=enter, `q`=quit); assert the lime banner renders, each step clears+redraws (screen-replace, not stacking), and it exits cleanly (no hang, no `set -e` abort).
  - **Local install round-trips:** `REMBRIC_SRC=$(pwd)` against a throwaway `HOME` — opencode install→uninstall; server prepare (token generated 64-hex, no docker without `--up`).
  - **Optional full (Docker):** installer `--up` in a temp dir on an alt `REMBRIC_PORT` (or `dev:docker:up`); verify `/healthz` 200 + `/dashboard` 302; tear down (`docker compose down`). Cross-link `rembric-smoke-tests`.
- [x] 4.2 Document the failure signatures to watch for (non-zero exit on a client action = `set -e` regression; empty token written; hang under no-tty; banner/table misalignment; root shim dropping flags).
- [x] 4.3 Symlink into `.claude/skills/`: `ln -s ../../.agents/skills/rembric-tui-installer-e2e .claude/skills/rembric-tui-installer-e2e`. Verify the Skill tool surfaces it.

## 5. Docs — lead with the TUI, demote manual

- [x] 5.1 `README.md`: Quickstart leads with the TUI installer (canonical `.../main/install.sh`, inspect-first form, `--ref` pin). Move the manual `curl docker-compose.yml + .env + docker compose up` into a "Manual / advanced" subsection. Keep the `docs/backup.md` + `SECURITY.md` links and the supported-clients list.
- [x] 5.2 `apps/plugin/README.md`: collapse the four-command install table into "install via the TUI"; move the per-client marketplace / `curl|sh` commands under a "Manual install" section. Keep the Claude Code plugin reference content.
- [x] 5.3 `docs/agents.md`: rewrite the top callout so the TUI is the source of truth (not "per-client instructions below remain the source of truth"); each per-client section (Claude, Codex, Hermes, opencode) leads with the TUI and keeps its marketplace / `curl|sh` / `config.toml` under a "Manual config" heading. Preserve the Codex five-hook enablement steps.
- [x] 5.4 `apps/plugin/.hermes-plugin/README.md`: lead with the TUI; move the `curl|sh` install + `hermes plugins install` and the uninstall `curl|sh` under "Manual install" / "Manual uninstall". Keep the provider+bridge config block and troubleshooting.
- [x] 5.5 `apps/plugin/.opencode-plugin/README.md`: lead with the TUI; keep the two-step manual install under a "Manual install" heading; keep Update/Verify/Troubleshooting.
- [x] 5.6 Leak/placeholder scan on all touched docs (no real tokens, hostnames, LAN IPs, maintainer home paths).

## 6. Verification

- [x] 6.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` all green (incl. the new shim test in `install.test.ts`).
- [x] 6.2 `sh -n install.sh apps/plugin/install.sh apps/plugin/.hermes-plugin/uninstall.sh` — all POSIX-clean.
- [x] 6.3 `openspec validate tui-sole-install-path --strict` passes.
- [x] 6.4 Run the `rembric-tui-installer-e2e` playbook (headless + local layers) green; OPERATOR runs the interactive pty + optional Docker layers.
- [x] 6.5 `git ls-files` shows one root `install.sh` (shim) + one `apps/plugin/install.sh` (real); both skills present under `.agents/skills/` each with a `.claude/skills/` symlink.

## 7. CI safety net

- [x] 7.1 Add a `pnpm run e2e:installer` script (root `package.json`): `sh -n` every installer/shim/uninstall script, then run the headless `install.test.ts` suite. (Layers 3/4 — pty + Docker — stay operator-run in the skill.)
- [x] 7.2 Add an "Installer e2e (headless)" step to `.github/workflows/ci.yml` running `pnpm run e2e:installer`, so a change that breaks the installer fails CI before deploy.
- [x] 7.4 Real Docker e2e in CI: `docker-build-check` loads the built runtime image as `:latest` (`load: true`) and runs `install.sh --server --up` (with `REMBRIC_NO_PULL=1`) against it, asserting `/healthz` 200 + `/dashboard` 302, then `docker compose down`. Adds the `REMBRIC_NO_PULL=1` knob (skip `docker compose pull`; air-gapped + deterministic CI) with a unit test. GitHub Actions ubuntu runners provide the Docker daemon.
- [x] 7.3 Relocate `install.test.ts` to the repo root (next to the root `install.sh` it tests): `git mv` from `apps/plugin/`, fix the `apps/server/vitest.config.ts` include (exact `../../install.test.ts`), and register it in `eslint.config.js` (`allowDefaultProject` + `disableTypeChecked`) so it is now actually linted. (Surfaced + fixed an `import/order` issue previously hidden by the `apps/plugin/**` eslint ignore.)

## 8. Headless agent CLI surface

- [x] 8.1 Add `--status` (headless, no banner, exit) showing a SERVER line + the agent/version table, and `--json` emitting `{ server, agents }` (payload-only). User-facing nomenclature is "agent" (not "client") — table header `AGENT`, flag `--agent=`, JSON key `agent`; internal fn names keep `client_*`. New `do_status`/`json_str`/`print_table` reuse.
- [x] 8.7 Server status: `server_state` (docker container state running/exited/…/absent/unknown), `server_image_version` (running image tag), and `server_latest_release` (best-effort GitHub Releases `server-v<semver>`, `REMBRIC_UPDATE_CHECK=off`-disablable, `REMBRIC_RELEASES_URL`-overridable). Shown in `--status` and the TUI Server screen; `:latest`-running shows latest release as info only (update hint only when the running tag is an older semver). NOT sourced from the repo manifest.
- [x] 8.2 Add `--token=<v>` (set `REMBRIC_ADMIN_TOKEN` verbatim via a new `awk`-based `write_token`, safe for arbitrary values) and `--port=<n>` (write `REMBRIC_PORT`; dashboard URL reflects it). Add `awk` to `preflight`.
- [x] 8.3 Friendly `docker compose` container-name conflict: capture `up` output (set -e-safe `if x=$(…)`), translate "already in use"/Conflict into an actionable message (don't clobber an existing install), trim other errors. Fixed a `set -e` capture-abort bug found while writing the test.
- [x] 8.4 Rewrite `--help` to document the full CLI (flags + env).
- [x] 8.5 Tests in `install.test.ts` for every flag: `--status`/`--json` (JSON.parse `{server,agents}`, 4 agents, shapes), `--status` release lookup via `file://` stub (`latest_release` extraction), `--token`, `--port`, plus stubbed-`docker` bring-up (success + conflict). Runner defaults `REMBRIC_UPDATE_CHECK=off` so no GitHub network in CI. 29 tests green (args, preflight, server install/update, agent routing incl. multi-agent, root-shim, output degradation, `--status`/`--json`, server states running-old/absent/daemon-down + update hint, release lookup, `--token`/`--port` incl. in `--up`); `pnpm run e2e:installer` green.
- [x] 8.8 Surface per-agent post-install/upgrade steps (`post_install_notes`, shown after install/update, not uninstall): Codex hook-enablement (`plugin_hooks` + trust 5 hooks via `/hooks`) + `REMBRIC_*` export; Hermes `hermes plugins install rembric` → `enable` → **restart the Hermes gateway**; opencode MCP-block paste + `REMBRIC_*`; Claude keychain prompt note. Tested (codex hooks, hermes 3 steps, uninstall prints no "Next").
- [x] 8.6 Add a sourceable sandbox helper `.agents/skills/rembric-tui-installer-e2e/scripts/ux-sandbox.sh` (isolated HOME+cwd, shares `~/.docker`, defines `rbx`/`rbx_clean`) so manual UX runs need only `source … && rbx`; referenced from the e2e skill.
