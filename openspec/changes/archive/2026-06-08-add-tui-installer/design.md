## Context

Rembric ships as a Docker server image plus a four-client plugin tree (Claude Code, Codex CLI, Hermes Agent, opencode) under `apps/plugin/`. Today each install path is documented separately and uses one of two mechanisms:

- **Marketplace/CLI** — Claude Code (`/plugin marketplace add` + `/plugin install`) and Codex (`codex plugin marketplace add` + `codex plugin install rembric`). Driven by the client's own CLI; no repo-side install script.
- **curl-installer** — Hermes (`apps/plugin/.hermes-plugin/install.sh`) and opencode (`apps/plugin/.opencode-plugin/install.sh` + `uninstall.sh`). POSIX `sh`, `set -eu`, a shared `fetch_file` pattern honouring `PLUGIN_SRC`/`BIN_SRC` (http→curl, local→cp).

Versions are uniform: every plugin component sits at the same semver via the release-please `plugin-suite` linked group, and each manifest carries a `version` field (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.hermes-plugin/plugin.yaml`, and a `// @rembric-plugin-version` comment in `.opencode-plugin/plugin.ts`). The repo-root `.release-please-manifest.json` lists all of them in one file.

Constraints that shaped this design:

- The repo enforces strict single-source-of-truth for plugin assets (`invariants.test.ts`); the orchestrator must call existing primitives, never duplicate their logic.
- Strong supply-chain posture (`.npmrc ignore-scripts`, `minimumReleaseAge`, lockfile-lint). A `curl | sh` installer is itself a supply-chain surface and must be defensible.
- `private: true` and the npm-CLI sunset are locked decisions; this must not read as reintroducing a published binary.

## Goals / Non-Goals

**Goals:**

- One brand-styled, copy-pasteable entry point (`apps/plugin/install.sh`) for server prep + all four plugins.
- Detect which clients are present and show installed-vs-available version per client.
- Offer Install / Update / Uninstall per client, each routed to that client's real primitive.
- Work under `curl … | sh` (piped stdin) and degrade cleanly with no TTY and with `NO_COLOR`.
- Add the one genuinely-missing primitive: `apps/plugin/.hermes-plugin/uninstall.sh`.

**Non-Goals:**

- Running `docker compose up` or requiring Docker to be installed (server flow is prepare-only).
- Creating a Codex `install.sh`/`uninstall.sh` — Codex is marketplace-based by design; a second path would be redundant and violate the per-client-divergence-only-when-forced principle.
- Editing operator config or removing credentials/`.rembric` files during uninstall.
- A new package, binary, or npm publish. No new runtime dependency.
- Replacing the existing per-client install docs — the installer is an additional entry point.

## Decisions

**D1 — POSIX `sh` + hand-rolled ANSI + ASCII wordmark, not `gum`/`whiptail`/`dialog`.**
The existing installers are POSIX `sh`; a richer TUI toolkit (charm `gum`, `whiptail`) would render better but is an external dependency the user must already have, which kills the "one curl and done" promise and the supply-chain story. We render the brand palette with ANSI truecolor escapes (`\033[38;2;198;242;78m` for lime `#c6f24e`), degrading to 256-color then plain when truecolor is unavailable or `NO_COLOR`/`! [ -t 1 ]`. The header shows a large block-letter "REMBRIC" wordmark in lime (a static 5-row `█`-block banner, printed only when colour/TTY is active; degrades to a plain `rembric` line otherwise). _Alternatives:_ `gum` (prettiest, rejected: dependency); `whiptail`/`dialog` (curses menus, rejected: not universally installed, ugly under pipe); a Node/TS TUI (rejected: would reintroduce a published-binary shape and contradict the npm sunset); `figlet` at runtime (rejected: dependency — the banner is baked in instead).

**D2 — `/dev/tty` raw-mode arrow-key menu, with numeric + headless fallback.**
`curl … | sh` makes the script's stdin the pipe, so all interaction targets `/dev/tty` explicitly. The interactive menu uses arrow-key navigation: the script puts `/dev/tty` into raw mode via `stty -echo -icanon`, reads keypresses a byte at a time (decoding the `ESC [ A`/`ESC [ B` cursor sequences, plus `j`/`k` and Enter), and redraws an in-place highlighted list using ANSI cursor moves — restoring the saved `stty` state and cursor on exit. When raw mode cannot be entered (no `stty`, `/dev/tty` not a real terminal), it falls back to a numbered prompt read from `/dev/tty`. When there is no controlling terminal at all (CI) or `REMBRIC_NONINTERACTIVE=1`, it switches to flag-driven mode (`--server`, `--client=…`, `--action=…`) and refuses to silently guess. _Alternatives:_ numbered-menu only (rejected per user direction — arrow navigation is the requested UX); a bash-only `read -rsn1` reader (rejected: `/bin/sh` is often `dash`, which lacks `read -n`; raw-mode `dd` byte reads keep the script POSIX and the `| sh` one-liner intact); download-then-run only (remains the documented recommended path, not the sole path).

**D3 — Orchestrator, not reimplementation.**
For opencode/Hermes the script invokes their `install.sh`/`uninstall.sh` (via `curl`-pipe against the public repo, or with `PLUGIN_SRC` pointing at a local clone for dev). For Claude/Codex it prints the marketplace CLI commands and, only if the client binary is detected on `PATH`, optionally runs them. The orchestrator embeds zero client-specific install logic, preserving the single-source invariant. _Alternative:_ a monolithic script with all four clients' logic inlined (rejected: duplicates primitives, guaranteed to drift, would trip `invariants.test.ts`).

**D4 — Server flow prepares + auto-generates the token, and optionally brings the stack up.**
`REMBRIC_ADMIN_TOKEN` is the only required env (`.env.example` confirms; everything else has a default). The script fetches `docker-compose.yml` + `.env.example`, and for the token either takes a pasted value or **auto-generates** one (`openssl rand -hex 32`, with an `od`/`/dev/urandom` fallback), writing it into `.env` and displaying it (it's needed to log into the dashboard). It then, **only when `docker compose` is available and the user confirms** (interactive `[y/N]`, or the `--up` flag in non-interactive mode), runs `docker compose pull && docker compose up -d` and prints the dashboard URL. Absent Docker or without confirmation it falls back to printing the command. Update is symmetric: it re-fetches `docker-compose.yml` and offers the **same gated bring-up** (the `bring_up` helper is shared by install and update), so a user who manages the server through the installer can update in one flow; when the current directory has no `./.env` it does not bring up and points the user to install first. The dashboard's own one-click self-update remains an independent, separately-opt-in path — the two don't conflict (both are just the documented `pull && up -d`). _Alternatives:_ prepare-only always (the original plan — rejected now that token generation removes the only manual step, making a guided `up` strictly nicer with no downside since it's gated on Docker presence + confirmation); always auto-run `up` (rejected: would require Docker and do a heavy side effect silently in headless mode — hence the `--up` opt-in and the never-on-update rule); mirroring the Claude/Codex "print, optionally run" pattern is deliberate for consistency.

**D5 — Single-fetch version source = `.release-please-manifest.json` at the install ref.**
"Available" versions come from one `curl` of `.release-please-manifest.json`. Critically, the ref it is fetched from MUST equal the ref the installer would install from (default `main`; a pinned tag if the user pins). Otherwise the "update available" signal lies (comparing `main` against a tag-installed file). "Installed" versions are read per client by a small adapter: JSON `version` for Claude/Codex manifests, YAML `version:` for Hermes, the `@rembric-plugin-version` comment for opencode. Semver comparison uses `sort -V` on the bare semver the manifest provides. _Alternative:_ fetch each client's manifest separately (rejected: five round-trips, more failure modes, and they're already in lockstep in one file).

**D6 — Conservative uninstall, mirroring opencode.**
`apps/plugin/.hermes-plugin/uninstall.sh` removes only `${HERMES_HOME:-~/.hermes}/plugins/rembric/` contents, runs `hermes plugins disable rembric` best-effort, and explicitly does NOT remove `~/.hermes/.env`, credentials, or any `.rembric` files — printing what it left, exactly like opencode's uninstaller. The orchestrator applies the same rule to every client it can uninstall. _Alternative:_ a "deep clean" that also strips config/credentials (rejected: silently destroying operator-owned config violates the same don't-lose-data ethos as append-only memory).

**D7 — Lives at `apps/plugin/install.sh`, owned by `plugin-shared`.**
Placing it in the shared plugin root puts it under the `plugin-shared` release-please component, whose linked `plugin-suite` group already cascades version bumps to the three marketplace clients that consume shared assets. _Alternative:_ repo-root `install.sh` (rejected: needs a brand-new release-please component and sits outside the plugin versioning story it belongs to).

## Risks / Trade-offs

- [Risk] Claude Code marketplace-installed `plugin.json` path under `~/.claude/` is unverified → resolve during implementation against a real install; if the layout is unstable across Claude versions, fall back to `claude plugin list`-style CLI output for version detection rather than hard-coding a path.
- [Risk] opencode's `install.sh` `sed` rewrite could in principle strip the `@rembric-plugin-version` comment, breaking version detection → confirm against an actually-installed `rembric.ts`; the rewrite targets only the dotenv import line, so the comment should survive, but the e2e walkthrough must assert it.
- [Risk] `curl | sh` is a supply-chain surface users are right to distrust → docs lead with the download-inspect-run two-step and offer a tag-pinned URL; the script prints its own source ref on start so users see what they ran.
- [Trade-off] Server flow stops short of `docker compose up` → Accepted because it keeps the script Docker-agnostic, leaves the lifecycle command visible/owned by the operator, and avoids overlapping the dashboard self-update path.
- [Trade-off] Claude/Codex can't be fully automated by the script (their CLIs own install) → Accepted; the script prints/optionally-runs the marketplace commands, which is the platform-sanctioned path. Forcing parity by writing redundant scripts was explicitly rejected (D3, Non-Goals).
- [Risk] Non-interactive mode could do the wrong thing if flags are ambiguous → the script refuses to act on ambiguous/empty input under `REMBRIC_NONINTERACTIVE`, exiting non-zero with usage.
- [Risk] Raw-mode arrow-key reading is hard to unit-test without a real PTY and can leave the terminal in a bad state if the script dies mid-read → the saved `stty -g` state and cursor are restored on every exit path (including via `trap`); a numeric fallback covers terminals where raw mode fails; the arrow UX itself is verified by the operator (group 9), not in CI.
- [Trade-off] Arrow-key navigation adds real terminal-handling complexity to a POSIX `sh` script → Accepted because the user requested arrow navigation; the complexity is contained in one `arrow_menu` helper with a numeric fallback, and no dependency is added.

## Migration Plan

Additive — no migration. Deploy = land the two new files + doc edits; release-please bumps `plugin-shared`/`plugin-suite` and `hermes-plugin`. Rollback = revert the files; existing per-client installers and marketplace paths are untouched and remain the documented fallback. E2E validation against `pnpm run dev:docker:up` per the `rembric-plugin-development` skill's walkthrough is mandatory before merge.

## Open Questions

- ~~Exact on-disk path of the Claude Code marketplace `plugin.json`~~ — **resolved**: both Claude and Codex extract the installed plugin to a versioned cache at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.claude-plugin/plugin.json` (and the `.codex` equivalent). The adapter globs the cache, filters to the manifest whose `name` is `rembric`, and returns the highest version. Verified against a real install.
- ~~Expose `--ref=<tag>`~~ — **resolved**: `--ref` is in v1 (D5 requires ref-consistency internally anyway).
