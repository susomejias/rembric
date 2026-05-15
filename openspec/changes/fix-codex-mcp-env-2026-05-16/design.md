## Context

`plugin/.claude-plugin/mcp.json` was authored as the **shared** MCP server config — one file consumed by both `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`. The archived `2026-05-15-add-codex-distribution` change explicitly required this sharing.

That requirement assumed two things, both of which are now empirically falsified against `codex-cli 0.130.0` and the openai/codex source tree:

1. **That Codex substitutes `${CLAUDE_PLUGIN_ROOT}` in MCP server `args`.** It does not. `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` only resolves the `cwd` field; `command` and `args` are passed verbatim to the spawn. `CLAUDE_PLUGIN_ROOT` is injected as an ENV var only for the hooks engine.
2. **That if Codex doesn't substitute `${user_config.*}`, the bridge will inherit `REMBRIC_*` from the parent shell.** It will not. `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server` calls `Command::env_clear()` before applying the curated env. The subprocess sees only `DEFAULT_ENV_VARS` + names listed in `env_vars` + literal pairs from `env`.

Both bugs blocked the bridge end-to-end. Bug 1 prevented `node` from finding the bridge module; bug 2 would have prevented authentication once the bridge ran. The user's actual install symptom was bug 1 (`Cannot find module …${CLAUDE_PLUGIN_ROOT}…`); the env-side issue was only discovered downstream because the original diagnosis used a manual bash simulation, not the real Codex spawn.

This change formalises the platform-forced divergence: a separate `plugin/.codex-plugin/mcp.json` that uses both Codex-native mechanisms — `cwd` for path resolution and `env_vars` for credential forwarding.

## Goals / Non-Goals

**Goals:**

- Codex MCP server starts AND authenticates against Rembric immediately after install with no manual config.toml edits, provided the user has `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` exported in the shell that launches `codex`.
- Source-of-truth alignment: the `codex-distribution` spec describes the real Codex contract (no `${CLAUDE_PLUGIN_ROOT}` substitution in args; `env_clear` semantics; canonical `cwd` + `env_vars` mechanisms).
- Zero regression for Claude Code: `plugin/.claude-plugin/mcp.json` is untouched. Keychain prompt + `${user_config.*}` substitution + `${CLAUDE_PLUGIN_ROOT}` in args all stay as Claude Code expects them.
- Single source of truth for the bridge binary, scripts, and hooks subset — only the MCP config file forks.

**Non-Goals:**

- Removing the `${user_config.*}` env block or the `${CLAUDE_PLUGIN_ROOT}` args path from `plugin/.claude-plugin/mcp.json`. Claude Code's working install depends on both; we don't break what works.
- Adding a `userConfig`-style wizard to Codex. Codex's binary has no support; nothing to opt into.
- Migrating Claude Code's `plugin/.claude-plugin/mcp.json` to use the `cwd: "."` + relative-args pattern for symmetry. Symmetry isn't worth the regression risk.
- Inventing a third syntax (shell-style `$VAR`). Neither client's MCP loader implements shell expansion for `args`.

## Decisions

### 1. Two `mcp.json` files, one per client

**Decision.** Sibling files under `plugin/`:

- `plugin/.claude-plugin/mcp.json` — Claude Code only. Keeps the existing `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` args and the `env: { REMBRIC_*: "${user_config.*}" }` block.
- `plugin/.codex-plugin/mcp.json` — Codex only. Uses `cwd: "."` + `args: ["./bin/rembric-bridge.mjs"]` for path resolution, and `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]` for credentials.

Each manifest references its own file:

```
plugin/.claude-plugin/plugin.json → "mcpServers": "./.claude-plugin/mcp.json"
plugin/.codex-plugin/plugin.json  → "mcpServers": "./.codex-plugin/mcp.json"
```

**Alternatives considered:**

- **Single shared `mcp.json` with both `env` and `env_vars`, plus path tricks.** Cannot make path resolution work for both: Claude Code uses `${CLAUDE_PLUGIN_ROOT}` in args (no `cwd` needed); Codex uses `cwd` + relative args (no `${CLAUDE_PLUGIN_ROOT}` substitution). If we tried `cwd: "."` + `${CLAUDE_PLUGIN_ROOT}/...` in args, Claude Code would substitute the var (producing an absolute path) and ignore the relative cwd; Codex would honour the cwd but the args path would still contain the unsubstituted placeholder — break. Cannot unify.
- **Single `mcp.json` with `cwd: "."` + `args: ["./bin/rembric-bridge.mjs"]`** (drop `${CLAUDE_PLUGIN_ROOT}`). Would likely work for Codex; uncertain for Claude Code. We don't break the Claude Code install on a hunch.
- **Codex-side bridge fallback.** Detect placeholder env value in the bridge and fall back to something. Couples the bridge to client-specific syntax. Rejected.
- **A bash wrapper script for Codex.** Use a hook-style invocation. Adds an extra process layer; reasonably ugly.

The split decision aligns with the CLAUDE.md rule: "Per-client divergence ONLY when the platform forces it." Two platform-level constraints force it here:

- (a) Codex does not substitute `${CLAUDE_PLUGIN_ROOT}` in MCP `args`,
- (b) Codex `env_clear`s the subprocess env, so `env_vars` is required to forward shell-exported credentials.

### 2. `cwd: "."` for path resolution under Codex

**Decision.** `plugin/.codex-plugin/mcp.json` declares `cwd: "."`. Codex's plugin-loader normalises this to `plugin_root.join(".") = plugin_root`. At spawn, `LocalStdioServerLauncher::launch_server` calls `.current_dir(cwd)` — the bridge subprocess runs with `cwd = plugin_root`. Node receives `./bin/rembric-bridge.mjs` and resolves it relative to its own cwd → `plugin_root/bin/rembric-bridge.mjs`. ✓

**Why `"."` not the omitted/null case.** When `cwd` is omitted, Codex falls back to `fallback_cwd` (the calling shell's cwd — `std::env::current_dir`). Setting `cwd: "."` forces the plugin-root anchor explicitly, eliminating any dependence on where the user launched `codex` from. This matters because users typically launch Codex from a project directory (e.g. `/Users/me/Desktop/myapp/`), and `./bin/rembric-bridge.mjs` would resolve there, not at the plugin root.

**Confirmed by:**

- `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` — the `cwd` field is the ONLY field this function resolves against `plugin_root`. It joins the value as a `Path`, so `"."` becomes `plugin_root`.
- `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server` — `.current_dir(cwd)` is applied to the spawned `Command`.

### 3. `env_vars` for credentials (not `env`)

**Decision.** `plugin/.codex-plugin/mcp.json` uses `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`. The `env` field is intentionally absent — any literal value there would be passed verbatim and would clobber the env_vars-resolved values (env_vars are computed first, then `env` is chained in `create_env_for_mcp_server`).

**Why this works.** `create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`:

```rust
let env = DEFAULT_ENV_VARS
    .iter().copied()
    .chain(additional_env_vars)   // names listed in env_vars
    .filter_map(|var| env::var_os(var).map(|value| (OsString::from(var), value)))
    .chain(extra_env.unwrap_or_default())  // literal `env` map
    .collect();
```

For each name in `env_vars`, Codex reads the value from its own process env (`env::var_os`) and passes the pair to the subprocess. So `REMBRIC_API_TOKEN=<real-token>` reaches the bridge, sourced from the user's shell.

**`McpServerEnvVar` enum shape.** The short string form (`"REMBRIC_API_TOKEN"`) is the `McpServerEnvVar::Name(String)` variant. The longer object form (`{ name: "X", source: "local" }`) is `McpServerEnvVar::Config`. For our case the short form is correct — `source` defaults to `"local"` which is what we want (read from the orchestrator's shell, not a remote MCP environment).

### 4. Codex has no install wizard — env-var export is the canonical path

**Decision.** Document explicitly (proposal + spec + docs/agents.md) that Codex has no `userConfig` keychain prompt, and the user MUST export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex`. Not a fallback; the canonical mechanism.

**Evidence.** Zero `userConfig` references in the Codex binary. The three `user_config` strings are CLI flags about loading `~/.codex/config.toml` (`ignore_user_config`, `IGNORE_USER_CONFIG`, `reload_user_config`).

### 5. Version bump in BOTH manifests in lockstep

**Decision.** Both `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` move `0.2.0 → 0.2.1`. Patch bump (bug fix, no behavioural change to Claude Code).

**Why both.** CLAUDE.md rule. Without the bump on the Codex side, `codex plugin marketplace upgrade rembric` reports "already at the latest version" and users have to manually uninstall + reinstall.

## Risks / Trade-offs

**Drift between `mcp.json` and `mcp.codex.json`.** The bridge path components diverge (`${CLAUDE_PLUGIN_ROOT}/bin/...` vs `./bin/...`) and the env handling diverges (env-map with placeholders vs env_vars list). Both files SHARE `command: "node"` and the structural shape of the entry. If we change the bridge filename or arg layout, both files must move. Mitigation: CLAUDE.md's plugin-discipline section now lists `mcp.codex.json` next to `hooks.codex.json` so the discipline is visible to future maintainers.

**Future client (Cursor, Windsurf, Gemini).** If a third client lands with yet another MCP config shape, it would need its own `mcp.<client>.json`. The two-file split is the precedent.

**Stale Codex caches.** Existing Codex users on `0.2.0` won't auto-upgrade until they run `codex plugin marketplace upgrade rembric`. Documented in `plugin/README.md` and `docs/agents.md`.

**Verification requires push to `main`.** Codex regenerates the cache from the marketplace's git clone on launch. We tried patching `~/.codex/plugins/cache/rembric/rembric/0.2.0/` directly — Codex overwrote our changes at next start. The empirical smoke test for this change therefore happens AFTER push to `origin/main` and `codex plugin marketplace upgrade rembric`, not before. The trade-off: the verification step blocks on the user's authorisation to push.

**Bridge silent-skip semantics when env vars are missing.** Codex's `env_vars` mechanism silently skips names it cannot find in the parent shell — `env::var_os(var).map(...)` returns None and gets filtered out. The bridge would then see neither `REMBRIC_SERVER_URL` nor `REMBRIC_API_TOKEN` and currently exits non-zero with a clear stderr message (per the `claude-code-plugin` spec's "MCP bridge contract"). That contract is unchanged by this work.

## Migration Plan

1. Land the change on `main` (version 0.2.1 in both manifests).
2. Existing Codex users: `codex plugin marketplace upgrade rembric`, then re-launch `codex`. Cache invalidates on the version bump; bridge picks up the new `mcp.codex.json`. Provided the user has `REMBRIC_*` exported, MCP authenticates on first tool call.
3. Existing Claude Code users: unchanged.
4. New installs: get the right files by default.

**Empirical smoke test sequence** (post-push, on the diagnosing machine):

1. `git push` the change to `origin/main`.
2. `codex plugin marketplace upgrade rembric` — pulls `0.2.1` into the marketplace clone.
3. Restart `codex`. Cache regenerates from the marketplace clone at the new version.
4. Trigger any MCP tool call (or just observe `~/.codex/log/codex-tui.log` at startup).
5. Expected: `[rembric-bridge] cwd=… url=http://<host>:<port>/mcp/<slug>` AND no `Cannot find module` AND no `Invalid URL`.
6. If passes → archive change. If fails → diagnose, update the change.

## Open Questions

- **Does Codex's `cwd` field accept `"."` exactly as I expect?** Confirmed by reading source — `cwd.unwrap_or(fallback_cwd)` then `Command::current_dir(cwd)`. The `Path::join` semantics for `"."` produce the original path. Verified by direct source read; will be re-confirmed empirically when 4.x of tasks runs.
- **Does Claude Code's plugin loader accept the same file split** (i.e. only loading `mcp.json` because that's what its manifest points to)? Yes by construction — Claude Code's manifest stays pointing at `mcp.json`, doesn't know `mcp.codex.json` exists.
