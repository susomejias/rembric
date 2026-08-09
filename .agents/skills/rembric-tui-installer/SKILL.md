---
name: rembric-tui-installer
description: The Rembric TUI installer contract — the single, canonical install/setup/upgrade/uninstall path (`apps/plugin/install.sh`, fronted by the repo-root `install.sh` shim). Apply when touching `install.sh`, the root shim, any per-client `install.sh`/`uninstall.sh`, `marketplace.json`, or distribution docs (README, `docs/agents.md`, plugin/client READMEs). Covers the orchestrator model, what must not break, and where the source of truth lives. For running the validation suite, use `rembric-tui-installer-e2e`.
---

# Rembric TUI installer — contract

The TUI installer is the **single, canonical, user-facing path** for installing / setting up / upgrading / uninstalling the Rembric server and every client plugin. Docs lead with it; per-client commands are documented only as manual fallback.

Source of truth (read these — this file is the durable contract, not a copy):

- `apps/plugin/install.sh` — the orchestrator (real logic).
- `install.sh` (repo root) — the thin shim; canonical URL `.../main/install.sh`.
- `install.test.ts` (repo root) — the headless test surface (covers the root shim + the orchestrator).
- `openspec/specs/tui-installer/spec.md` — the normative requirements.

## The orchestrator model (do NOT violate)

The installer **delegates; it never reimplements**. There are **three** backends, and each of the five clients uses exactly one:

- **opencode, Hermes** → invokes their own `install.sh` / `uninstall.sh` (via `PLUGIN_SRC` against a local clone, or `curl` at the same ref).
- **Claude Code, Codex** → prints the marketplace CLI commands (and optionally runs them when the client binary is present). No repo-side install script is created for these.
- **Pi** → runs the client's own CLI against the public npm registry: `pi install npm:@rembric/pi`, for install **and** for update, gated on binary presence and `--yes` exactly as the marketplace backend is; uninstall goes through that client's own removal verb. There is deliberately no `.pi-plugin/install.sh`, no `.pi-plugin/uninstall.sh`, and no marketplace entry. **`--ref=<tag>` is NOT applied to it** — the artifact comes from the registry, not a git ref, and appending a version would produce a pin that the client's own `pi update --extensions` / `--all` then skip, freezing the operator while reporting success.

The per-client primitives (`install.sh`/`uninstall.sh`, `marketplace.json`, the bridge, hooks) are the backend and the documented manual fallback. Changing the installer must not duplicate or fork their logic.

The **root `install.sh` is a pure forwarder** — no menu, token, fetch-of-artifacts, or client logic of its own. From a clone it `exec`s `apps/plugin/install.sh`; over `curl|sh` it fetches that script at the same ref. Every flag/env passes through unchanged.

## Surface to preserve

- **Flags/env**: `--server`, `--agent=<a,b,..>` (one or more of `claude,codex,hermes,opencode,pi`, or `all`), `--action=install|update|uninstall`, `--up`, `--ref=<tag>`, `-h/--help`; `REMBRIC_SRC` (local-source, no network), `REMBRIC_NONINTERACTIVE`, `REMBRIC_REF`, `NO_COLOR`.
- **The client list must have ONE definition, with the agreement asserted by a test.** The parser, the per-client loops, the `arrow_menu` and the usage text all enumerate it, and a client added to eleven of twelve places is the failure mode — so a new client is a one-line change plus a green agreement test, never a search-and-add sweep.
- **Three run modes**: interactive arrow-key TUI (real `/dev/tty`, raw mode) → numbered fallback (no raw mode) → headless flag mode (no controlling terminal or `REMBRIC_NONINTERACTIVE=1`). No controlling terminal must NOT hang — it falls to headless.
- **Server flow** is prepare + token + optional gated `up`: dependency report; auto-generate `REMBRIC_ADMIN_TOKEN` (and refill an empty token from an interrupted run); never start Docker without `--up`/confirmation; `docker compose pull && up -d` gated on `docker compose` availability.

## What must not break (checklist)

1. **Orchestration**: still delegates per client; no inlined client logic; `git ls-files apps/plugin/` shows one copy of each shared resource.
2. **Root shim is a pure pass-through** (flags/env reach `apps/plugin/install.sh` unchanged).
3. **Token flow**: fresh → generated 64-hex; pasted → kept; configured `.env` → untouched + shown; empty token (interrupted run) → refilled. Never bring up with an empty token.
4. **Version detection** per client: opencode `@rembric-plugin-version` comment; Hermes `plugin.yaml`; Claude/Codex versioned marketplace cache; Pi `${PI_CODING_AGENT_DIR:-~/.pi/agent}/npm/node_modules/@rembric/pi/package.json`, which only a user-scope `pi install npm:` leaves behind — every other vector leaves none, so Pi is the one client that can legitimately report `unknown` rather than a guess. Available = single `.release-please-manifest.json` fetch at the install ref.
5. **"Update available" never lies — and the registry-CLI row is the one that could make it.** For Pi the installer does exactly one of two things: read the installed version from a deterministic on-disk location **established by measurement**, in the manner of the four adapters above; or report it as explicitly `unknown` and recommend the idempotent reinstall. Guessing, inferring from presence, or defaulting to the available version is prohibited — a table with one unreliable row is an unreliable table for every client. An `unknown` row must render `unknown`, never "up to date" and never "update available", and **update-all skips it with `unknown` as the stated reason and still exits 0** (update-all runs unattended; reinstalling on ignorance would make it act on every run for a client it can never confirm). Forcing it stays the explicit `--agent=pi --action=install` path, and the skip line names that verb — every recommendation any surface prints comes from one state → verb mapping, so it is always a verb `--action` accepts (`ACTIONS='install update uninstall'`, validated at parse time).
6. **Post-install steps reflect the action, per client.** Pi _install_ prints the `REMBRIC_SERVER_URL` / `REMBRIC_API_TOKEN` shell exports and **no settings-file alternative** — measured: that harness injects nothing from its own settings file, so offering one would be inventing a path. Pi _update_ prints only the restart.
7. **Conservative uninstall**: remove only plugin-owned files; never touch operator config, credentials, `.rembric`.
8. **UX**: lime block banner; each menu step clears+redraws (screen-replace, not stacking); restores `stty`/cursor on exit.
9. **`set -e` safety**: functions must not end on a false `[ test ]` (it aborts the script / kicks out of the menu). End client/menu helpers with `return 0` or an `if/fi`.
10. **POSIX**: `/bin/sh` (dash) compatible — no bashisms; `sh -n` clean.

## Before landing any install/distribution change

Run the `rembric-tui-installer-e2e` playbook (headless + local layers at minimum). The headless suite is CI-gated via `install.test.ts` (repo root); the interactive and Docker layers are operator-run.
