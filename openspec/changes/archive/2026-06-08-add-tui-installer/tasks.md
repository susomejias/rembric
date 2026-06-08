## 1. Hermes uninstall primitive

- [x] 1.1 Create `apps/plugin/.hermes-plugin/uninstall.sh` (POSIX `sh`, idempotent), mirroring `apps/plugin/.opencode-plugin/uninstall.sh`: honour `HERMES_HOME` (default `~/.hermes`), remove `plugin.yaml`/`__init__.py`/`README.md` from `${HERMES_HOME}/plugins/rembric/`, `rmdir` the empty dir, best-effort `hermes plugins disable rembric`.
- [x] 1.2 Make `uninstall.sh` print removed files, already-absent files, and an explicit "left in place" list naming `${HERMES_HOME}/.env` and `.rembric` markers; never touch those.
- [x] 1.3 Verify idempotency: running `sh apps/plugin/.hermes-plugin/uninstall.sh` twice exits zero both times and the second run reports all files absent.
- [x] 1.4 Add a unittest under `apps/plugin/.hermes-plugin/tests/` (or extend existing) asserting the conservative-removal behaviour against a temp `HERMES_HOME`.

## 2. Update the Hermes plugin spec contract in code/docs

- [x] 2.1 Update `apps/plugin/.hermes-plugin/README.md` to document the uninstall step (`sh apps/plugin/.hermes-plugin/uninstall.sh`) and what it deliberately leaves behind.
- [x] 2.2 Confirm the `invariants.test.ts` "single copy of each shared resource" check still passes with the new `uninstall.sh` (it is a per-client maintenance script, not a shared duplicate) — run `pnpm vitest run apps/server/src/test/invariants.test.ts`.

## 3. Orchestrator skeleton (`apps/plugin/install.sh`)

- [x] 3.1 Create `apps/plugin/install.sh` as POSIX `sh`, `set -eu`; verify `sh -n apps/plugin/install.sh` passes.
- [x] 3.2 Implement colour layer: truecolor→256→plain detection; emit no ANSI when `NO_COLOR` set or `! [ -t 1 ]`; lime `#c6f24e` on `#0a0a0a` for headings/selection.
- [x] 3.3 Implement TTY handling: read prompts from `/dev/tty`; detect absence of controlling terminal; print the source ref (default `main`, overridable) on start.
- [x] 3.4 Implement non-interactive mode: parse `--server`, `--client=<list>`, `--action=install|update|uninstall`, `REMBRIC_NONINTERACTIVE=1`, `--ref=<tag>`; on ambiguous/empty input print usage and exit non-zero without side effects.

## 4. Server flow (prepare-only)

- [x] 4.1 Implement server install: download `docker-compose.yml` + `.env.example` from the install ref into CWD; for `REMBRIC_ADMIN_TOKEN` take a pasted value or auto-generate one (`gen_token`: openssl, `/dev/urandom` fallback) and write `.env`, displaying a generated token. Then run `docker compose up -d` ONLY when `docker compose` is available AND the user confirms (interactive `[y/N]` or `--up`); otherwise print the command. (Verified locally: token generated 64-hex, files prepared, no docker run without `--up`.)
- [x] 4.2 Implement server update: re-fetch `docker-compose.yml`, print `docker compose pull` / `REMBRIC_VERSION`-bump reminder. Never auto-runs Docker (avoids overlapping dashboard self-update).
- [x] 4.3 Verify server flow completes on a host with no `docker` on `PATH`. (Prepare + token-gen path runs with zero `docker` invocation; bring-up is gated on `docker_compose_ok`.)
- [x] 4.4 Add dependency pre-checks: `preflight()` (core: sed/grep/sort/mktemp, + curl in remote mode) gates all install/update and aborts listing missing tools; `server_deps_report()` shows docker / docker compose (v2 subcommand) / openssl(+urandom fallback) status before the server flow. (Verified locally.)

## 5. Client detection + version table

- [x] 5.1 Implement presence detection: `command -v claude|codex|opencode`; `[ -d ${HERMES_HOME:-~/.hermes} ]` for Hermes.
- [x] 5.2 Implement per-client installed-version adapters: YAML `version:` (`~/.hermes/plugins/rembric/plugin.yaml`), `@rembric-plugin-version` comment (`~/.config/opencode/plugins/rembric.ts`), and JSON `version` from the versioned marketplace **cache** for Claude (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json`) and Codex (`~/.codex/plugins/cache/.../.codex-plugin/plugin.json`) — glob the cache, filter to the manifest whose `name` is `rembric`, return the highest version. **All four adapters verified against the real system** (claude 0.10.0, codex 0.10.0, hermes absent, opencode 0.8.0).
- [x] 5.3 Implement available-version fetch: single `curl` of `.release-please-manifest.json` at the SAME ref the installer installs from.
- [x] 5.4 Render the status table (present / installed / available / action) and implement semver comparison via `sort -V` on the bare manifest values. (`vercmp` unit-checked across install/none/update/ahead/unknown.)

## 6. Per-client action routing

- [x] 6.1 opencode + Hermes: route install/update to the client `install.sh` and uninstall to the client `uninstall.sh`, fetched from the install ref or via `PLUGIN_SRC` against a local clone. No inlined logic. (opencode round-trip verified locally.)
- [x] 6.2 Claude + Codex: print the marketplace CLI commands for install/update/uninstall; when the client binary is on `PATH`, optionally offer to run them. Create no repo-side script for these clients.
- [x] 6.3 Apply the conservative-uninstall rule uniformly: after any uninstall, print what was left (config, credentials, `.rembric`) and never remove it.

## 7. Documentation

- [x] 7.1 Add the installer entry point to `README.md` Quickstart and `apps/plugin/README.md`: one-line `curl | sh`, plus the download-inspect-run two-step (recommended) and a tag-pinned URL alternative.
- [x] 7.2 Update `docs/agents.md` per-client sections to reference the unified installer alongside (not replacing) existing instructions.
- [x] 7.3 Ensure no tracked file introduced here contains real tokens, hostnames, LAN IPs, or maintainer home paths (placeholders only); rely on the pre-commit grep.

## 8. Release-please wiring

- [x] 8.1 Confirm `apps/plugin/install.sh` falls under the `plugin-shared` component (and thus the `plugin-suite` linked group) and `apps/plugin/.hermes-plugin/uninstall.sh` under the `hermes-plugin` component — no `release-please-config.json` change needed unless a path filter excludes them; adjust `exclude-paths` only if required. (Confirmed: `plugin-shared` `exclude-paths` lists only the four manifest dirs, so `install.sh` is covered; `uninstall.sh` is path-matched by the `hermes-plugin` component. No config change.)

## 9. End-to-end validation (operator-run against local dev stack)

- [x] 9.1 Bring up a live server via the installer's own `--up` path (prod compose + real GHCR image after `docker compose pull`); verified healthy (`/healthz` 200, `/dashboard` 302→login). (Surfaced + documented a real-system gotcha: `pnpm run dev:docker:up` tags the dev build as `:latest` locally, which the prod `up` would otherwise shadow — fixed by the best-effort `docker compose pull` before `up`.)
- [x] 9.2 Exercise install/uninstall via `REMBRIC_SRC` against the local clone: opencode round-trip verified (install → version detected → uninstall removes, conservative "left in place" output); real-system status table verified (claude 0.10.0, codex 0.10.0, hermes absent, opencode 0.8.0).
- [x] 9.3 OPERATOR: confirm opencode's `install.sh` `sed` preserves the `@rembric-plugin-version` comment in the installed `rembric.ts` so version detection works. (Verified locally: orchestrator-driven opencode install produced `rembric.ts` with `@rembric-plugin-version 0.10.0` intact, detected by the installed-version adapter.)
- [x] 9.4 Verified the Claude/Codex branches print the correct marketplace commands and gate run-through on binary presence (headless + real-system).
- [x] 9.5 Verified in a real terminal: the lime block-letter REMBRIC banner renders, the arrow-key menu navigates (↑/↓ + Enter, `q` quits), each step clears to a fresh screen (banner + content) rather than stacking, `pause` after actions, and the no-TTY/capture context falls to headless instead of hanging.
- [x] 9.6 Teardown is a single `docker compose down` in the install dir (left to the operator; the test server was brought up at the operator's request).

## 10. Gate checks

- [x] 10.1 Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm test`; all green. (typecheck clean; lint clean; tests EXIT=0 — server 665 passed/1 skipped, plugin python 33 passed incl. new uninstall tests.)
- [x] 10.2 `git ls-files apps/plugin/` shows exactly one copy of each shared resource (the new files are legitimate per-client / orchestrator additions, not duplicates). (One orchestrator `install.sh` at the plugin root; per-client `install.sh`/`uninstall.sh` in their dirs.)
- [x] 10.3 Add an automated test suite for the installer: `apps/plugin/install.test.ts` (vitest + `child_process`, no new dependency) driving the headless surface — arg handling, preflight, server install (fresh / empty-token-refill / configured), server update (with/without `.env`), client routing (marketplace print + opencode round-trip), and output degradation. Wired into `pnpm test`/CI via the `../plugin/*.test.ts` include glob in `apps/server/vitest.config.ts`. (15 tests; caught + fixed a `set -e` regression where client actions returned non-zero and aborted.)
