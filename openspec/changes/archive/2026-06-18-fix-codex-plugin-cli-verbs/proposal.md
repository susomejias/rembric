## Why

Installing the Codex plugin from the TUI fails. The installer prints and runs `codex plugin install rembric`, but the Codex CLI (verified against `codex-cli 0.141.0`) has **no `install` subcommand** under `codex plugin` — it aborts with `error: unrecognized subcommand 'install'` (it even suggests `list`). The marketplace is added successfully, then the install step dies, leaving the user with a half-wired plugin.

The real Codex `plugin` subcommands are:

- `codex plugin add <PLUGIN[@MARKETPLACE]>` — install from a configured marketplace snapshot
- `codex plugin remove <PLUGIN[@MARKETPLACE]>` — uninstall
- `codex plugin marketplace upgrade <name>` — refresh the marketplace snapshot (does **not** by itself re-install the cached plugin)

The wrong verbs (`install` / `uninstall`) were carried verbatim from the original `add-codex-distribution` proposal, where the commands were documented as "not yet empirically verified" (a known risk recorded in that change's design.md). They are wrong in the installer, the user-facing docs, the installer test, and the two specs that quote them.

## What Changes

- **`apps/plugin/install.sh` (the fix):** the Codex `marketplace_cmds` block uses the correct verbs — install → `codex plugin add rembric@rembric`, uninstall → `codex plugin remove rembric@rembric`. The update path refreshes the snapshot **and** re-adds (`codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`), because a snapshot refresh alone does not pull the new version into the local cache — there is no per-plugin update verb in the Codex CLI.
- **Docs:** `docs/agents.md` and `apps/plugin/README.md` update the quoted Codex marketplace command from `codex plugin install rembric` to `codex plugin add rembric@rembric`.
- **Test:** `install.test.ts` asserts the corrected verb in the Codex install + multi-agent scenarios; the update scenario keeps the guard that the output never contains `codex plugin install` (no such subcommand).
- **Specs:** `codex-distribution` and `tui-installer` update the scenarios that quote the Codex install command to the correct `codex plugin add rembric@rembric` form.

No load-bearing server invariant (append-only memory, scope-at-service, `topic_key`, judgment freshness) is touched. This is a correctness fix to the distribution surface and its documentation — no behavioural change to the server, the bridge, the hooks, or the marketplace manifest.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `codex-distribution`: the marketplace-install scenario and the `docs/agents.md` recommendation quote the correct `codex plugin add rembric@rembric` verb instead of the non-existent `codex plugin install rembric`.
- `tui-installer`: the "Marketplace client prints CLI commands" scenario asserts the installer prints `codex plugin add rembric@rembric` instead of `codex plugin install rembric`.

## Impact

- **Modified files**: `apps/plugin/install.sh`, `docs/agents.md`, `apps/plugin/README.md`, `install.test.ts`, `openspec/specs/codex-distribution/spec.md`, `openspec/specs/tui-installer/spec.md`.
- **Unchanged (deliberately)**: the Codex marketplace manifest (`.codex-plugin/marketplace.json`), the bridge, hooks, and every per-client primitive — only the install/uninstall/update _verbs_ the installer drives are corrected.
- **Versioning**: `apps/plugin/install.sh` sits in the unified `plugin` release-please component; a fix here bumps the shared `plugin` version (CHANGELOG scoped by conventional commit).
- **No supply-chain surface change**: no new dependency, no `.npmrc` / `pnpm-workspace.yaml` / lockfile / Dockerfile change.
