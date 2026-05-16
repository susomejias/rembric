## Context

The Hermes plugin shipped in `0.3.0` made an architectural choice that turned out to be wrong: it used `get_config_schema()` + `save_config()` to handle credentials, plus a defensive `_preload_rembric_dotenv()` reading `~/.rembric/.env` as a fallback. This worked for the in-process provider but NOT for the MCP bridge subprocess that Hermes spawns from `mcp_servers.rembric`. The bridge gets its env from `~/.hermes/.env` directly, so users had to maintain two parallel `.env` files — one Hermes-managed (`~/.hermes/.env`) and one plugin-managed (`~/.rembric/.env`).

Verified live in the author's Hermes LXC install (2026-05-16): a `REMBRIC_*` value present only in `~/.rembric/.env` worked for the provider's session POSTs but mcp-remote (the bridge) failed because Hermes didn't include those values in the subprocess env. Reading the Hermes plugin source (`hermes_cli/plugins_cmd.py::_prompt_plugin_env_vars`) clarified that `requires_env:` is the canonical mechanism for env vars that need to reach both the plugin code AND the subprocesses Hermes spawns.

## Goals / Non-Goals

**Goals:**

- Single source of truth for `REMBRIC_*` credentials: `~/.hermes/.env`.
- First-class install UX via the documented `hermes plugins install <repo>` prompt flow.
- Drop the parallel `~/.rembric/.env` mechanism entirely. The custom preload was a workaround for a problem that `requires_env:` already solves.
- Drop dead code: `get_config_schema`, `save_config`, the four `_slug_from_stored_config` lines (cascade step 2 disappears), and the dotenv preload helper.
- Keep everything else stable: provider lifecycle (`initialize`, `on_pre_compress`, `on_session_end`), the curl installer, the slug cascade's still-relevant steps, the no-tool-schema discipline, the version-lockstep rule.

**Non-Goals:**

- Changing what the provider DOES. Lifecycle behavior is identical.
- Migrating existing users automatically. The CHANGELOG documents the one-time move.
- Adding any other features. This is purely simplification.

## Decisions

### Decision 1: Use `requires_env:` instead of `get_config_schema()` for credentials

Declaring `requires_env:` in `plugin.yaml` triggers Hermes's standard install prompt for the listed variables. Hermes writes the answers to `~/.hermes/.env` (atomic, file-locked) and exports them into the running process's `os.environ`. On future Hermes launches, the values are pre-loaded into `os.environ` before plugins import. Subprocesses Hermes spawns (the bridge from `mcp_servers.rembric`) inherit the same env. One file, one mechanism.

`get_config_schema()` remains useful for plugins that have **in-process-only** config (flags, modes, file paths) that don't need to reach subprocesses. None of Rembric's three vars qualify — they're all consumed by both the in-process provider AND the bridge subprocess.

### Decision 2: Drop `~/.rembric/.env` preload entirely

With `requires_env:` Hermes guarantees the vars are in `os.environ` before the plugin module imports. The plugin's `_preload_rembric_dotenv()` helper becomes dead code and would only confuse readers — "do I need this file or not?". Removing it makes the contract obvious: env comes from Hermes (`~/.hermes/.env`) and nowhere else.

The cost is a one-time migration for users on 0.3.x who set up `~/.rembric/.env`. The CHANGELOG documents the move; `hermes plugins install rembric` re-prompts for the values if they re-install.

### Decision 3: Slug cascade drops from 5 steps to 4

Step 2 of the 0.3.x cascade was "`<hermes_home>/rembric.json` → `project_slug`", written by `save_config(values, hermes_home)`. With `save_config` gone, no one writes that file. The cascade becomes:

```
1. REMBRIC_PROJECT_SLUG env var       (from ~/.hermes/.env via requires_env)
2. <cwd>/.rembric → PROJECT_SLUG      (per-repo pinning, parity with Claude/Codex)
3. URL parse: REMBRIC_SERVER_URL ending in /mcp/<slug>
4. None → degraded silent skip
```

Cleaner, fewer surprise sources, same coverage for every documented user setup.

### Decision 4: Version bump 0.3.x → 0.4.0 (minor)

Per CLAUDE.md SemVer: "minor (0.2.0 → 0.3.0): new behaviour (new hook, new endpoint touched, additional manifest field)". Adding `requires_env:` is an additional manifest field; removing `get_config_schema`/`save_config` is a Python public-method removal but those methods were internal (no documented external caller). Net: minor.

## Risks / Trade-offs

- **[Risk] Users on 0.3.x with `~/.rembric/.env` get a silent migration**. After upgrading to 0.4.0 the file is ignored. If they don't move the values to `~/.hermes/.env` (or re-install for the prompt), `initialize()` runs with empty env and skips POSTs silently. Mitigation: CHANGELOG entry with explicit migration steps. Plugin install also re-prompts if they re-run the curl installer, populating `~/.hermes/.env` afresh.

- **[Risk] `requires_env:` prompts at install make the install path interactive**. Users who pipe `install.sh | sh` from CI or another non-interactive context won't get a chance to answer. Mitigation: Hermes's docs say users can `export` the vars beforehand to skip the prompt; `requires_env:` only prompts for vars NOT already in env. Document this in the README for CI/automation use cases.

- **[Trade-off] `~/.hermes/.env` is now the ONLY source of truth**. Users with strong opinions about plugin-isolated config files lose the `~/.rembric/.env` option. We accept the trade-off because the multi-file UX is friction we observed in practice (user had to debug it live in their LXC), and the upstream pattern (`requires_env:`) is the documented one.

- **[Trade-off] Test surface shrinks**. We drop ~30 lines of preload tests + a chunk of `get_config_schema` tests. The provider gets simpler to reason about, but coverage on the install-time prompt path comes from Hermes's own test suite, not ours.

## Migration Plan

1. Implement the changes per `tasks.md`.
2. Bump version 0.3.1 → 0.4.0 in all three manifests.
3. `plugin/CHANGELOG.md::[0.4.0]` documents:
   - **Migration**: users with `~/.rembric/.env` must move the same three vars to `~/.hermes/.env`. Easiest path: re-run `curl … | sh` to refresh the plugin files, then `hermes plugins install rembric` (or re-run the install command) to be prompted afresh and let Hermes write `~/.hermes/.env` correctly.
   - **Breaking**: `_preload_rembric_dotenv()`, `get_config_schema()`, `save_config()` removed from the public Python surface.
4. After archive, `openspec validate --strict` re-runs on the updated main spec.

## Open Questions

None. All design questions settled by direct experimentation in the live LXC + reading `hermes_cli/plugins_cmd.py` source.
