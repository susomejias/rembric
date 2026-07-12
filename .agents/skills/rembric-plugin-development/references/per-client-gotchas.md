# Per-client gotchas

Hard-won knowledge for each shipped client. Read the relevant section before modifying that client's files.

## Claude Code

- `${user_config.*}` substitution works in BOTH `mcp.json::env` AND hook `command` strings. Install wizard's keychain is the single source of credentials.
- Hooks inherit nothing from MCP env. Hook commands MUST inline-prefix env vars: `REMBRIC_SERVER_URL='${user_config.server_url}' REMBRIC_API_TOKEN='${user_config.api_token}' "${CLAUDE_PLUGIN_ROOT}"/scripts/x.sh`.
- `${CLAUDE_PLUGIN_ROOT}` substitution works everywhere in Claude's manifests.
- Claude Code caches plugins by `version`. A change with no version bump is invisible to `/plugin update`. Docs-only changes intentionally skip the bump.

## Codex CLI

- `${user_config.*}` is NOT substituted (verified against `developers.openai.com/codex/plugins/build` and the codex-rs source). No user-config schema.
- Subprocess env is **cleared** before MCP spawn (`Command::env_clear()` in `codex-rs/rmcp-client/src/utils.rs`). Only names listed in `env_vars: [...]` are forwarded from the parent shell. Hooks read process env directly.
- `${CLAUDE_PLUGIN_ROOT}` is NOT substituted in MCP `args`. Use `cwd: "."` (resolved to plugin root) + relative args like `"./bin/rembric-bridge.mjs"`. Substitution DOES work in hook `command` strings.
- Hooks are stable and enabled by default as of `codex-cli 0.142.3+` (`codex features list` shows `hooks stable true`; the `plugin_hooks` feature flag was REMOVED upstream — do not tell users to run `codex features enable plugin_hooks`, that flag no longer exists). The only remaining platform-required step is opening `/hooks` inside Codex and trusting each of the plugin's hook types; until trusted, a hook loads but does not execute. Document that gate when troubleshooting "Codex hooks not firing."

## Hermes Agent

- `plugin.yaml::hooks: [...]` array **gates lifecycle override invocation**. Override a method on the provider without listing its hook name → Hermes does NOT call your override. Caught the hard way during `add-hermes-agent-plugin`.
- Credentials live in `${HERMES_HOME:-~/.hermes}/.env` populated by `requires_env: [...]` at install time. Don't preload any plugin-specific dotenv.
- The provider class MUST guard `from agent.memory_provider import MemoryProvider` with a `try/except ImportError` fallback ABC so the file is importable in tests without Hermes installed.
- `is_available` MUST send `Authorization: Bearer ${REMBRIC_API_TOKEN}` (Rembric `/healthz` requires auth since `0.13.0`). 401 → degrades to `is_available() = False`, silently disabling the provider.

## opencode

- **opencode iterates every named export of a plugin file and invokes each with the plugin ctx.** Confirmed against opencode 1.15.5 during the `add-opencode-plugin` cwd spike. `plugin.ts` MUST export ONLY `RembricPlugin`. Exporting helpers like `parseDotenv` causes them to be called with the ctx object → crash at load with `content.split is not a function`.
- The MCP bridge MUST live OUTSIDE `~/.config/opencode/plugins/` because opencode auto-loads every JS/TS file in that directory as a plugin. Canonical location: `~/.config/rembric/bin/rembric-bridge.mjs`.
- opencode does NOT support `${env.*}` substitution in `opencode.json::mcp.<name>.url`. Path-scoping via `.rembric` therefore requires the stdio bridge (which builds the URL at spawn time) — `type: "remote"` would force per-project `./opencode.json` files. The shared bridge gives Claude/Codex/opencode identical UX.
- `session.deleted` fires ONLY on explicit user delete from the UI — NOT on session close or process quit. Treat it as in-memory cleanup, not a server-side end signal.
- **Sub-agent filtering is mandatory v1**. Detect via `event.properties.info.parentID` (truthy) OR `info.title.endsWith(" subagent)")`. Without the filter, a single conversation spawning sub-agents inflates session count dramatically (a single conversation has been observed producing ~170 session rows in similar memory plugins).
- Bun's ESM resolver accepts absolute paths in `import` statements. `install.sh` sed-substitutes the dev-time relative import (`from '../bin/rembric-dotenv.mjs'`) with the absolute installed path before copying.

## All shell-hook clients (Claude + Codex)

- Bridge cwd resolution chain: `CLAUDE_PROJECT_DIR > PWD > process.cwd()`. The `||` short-circuit (not `??`) lets explicitly-empty env vars fall through. Don't introduce new precedence steps without an invariant test + a bridge-contract spec amendment.
- All hook scripts source `apps/plugin/scripts/_api.sh` for `rembric_post`, `rembric_read_project_slug`, etc. NEVER write a per-client variant (`*-claude.sh`, `*-codex.sh`) — the platform delta is in the env-prefix at the hook manifest level, not in the script.
