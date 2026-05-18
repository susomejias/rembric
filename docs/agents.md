# Agent integration

For **Claude Code**, use the bundled plugin — see [`plugin/README.md`](../plugin/README.md). The rest of this doc is for everything else.

> **Running Rembric itself?** The canonical install is Docker — see [`docs/docker.md`](./docker.md) for the operator guide (topologies, GHCR auth, upgrades, troubleshooting). This page covers the agent side: how each MCP client connects to a running Rembric instance.

## Connection shape

Every MCP client uses the same two values:

```
URL:    http(s)://your-host:8787/mcp[/<project-slug>]
Header: Authorization: Bearer <agent-token>
```

- `/mcp` → global scope. The agent operates user-wide until it calls `project.use({slug})`.
- `/mcp/<slug>` → path-scoped. The agent is locked to that project; `scope=global` saves are rejected with `code: scope_locked`.

Mint per-agent tokens from the dashboard at `/dashboard/tokens`. Plaintext shown exactly once.

The MCP server emits a short `instructions` block at handshake teaching the proactive-save protocol (when to save, when to call `memory.judge`, when to call `memory.session_summary`). Clients that support `initialize.instructions` (Claude Code, Codex CLI) inject it into the system prompt. Other clients still get the same protocol via each tool's description.

## Validated configs

### Claude Code (plain JSON, if not using the plugin)

`~/.claude/mcp.json` or workspace `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://memory.example.com/mcp/my-app",
      "headers": { "Authorization": "Bearer cc-token-XXXXXXXX" }
    }
  }
}
```

### Codex CLI (recommended: bundled plugin)

Use the Codex marketplace install — the plugin ships from the same `plugin/` directory as the Claude Code plugin (one source tree, two manifests):

```bash
codex plugin marketplace add https://github.com/susomejias/rembric.git
codex plugin install rembric
```

The marketplace `source` is `git-subdir` against `./plugin`, so Codex clones the repo subtree on install. Repo access (SSH key / PAT) gates discovery, exactly like the Claude Code plugin.

What the plugin registers for Codex:

- The `rembric` MCP server (declared by `plugin/.codex-plugin/mcp.json`, the Codex-specific sibling of Claude Code's `plugin/.claude-plugin/mcp.json`), invoking the bundled bridge at `plugin_root/bin/rembric-bridge.mjs` (resolved via the manifest's `cwd: "."` + relative args).
- A four-hook subset (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`) sharing scripts with the Claude Code plugin via `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh`. All hooks are `command`-type and POST to Rembric's `/api/<slug>/sessions(*)` HTTP API for session lifecycle — the agent never needs to call `memory.session_start`/`memory.session_summary`/`memory.session_end` manually; the hooks handle creation, summary-on-compact, and end-on-stop.

After install, drop a `.rembric` file at the root of each project to path-scope the slug automatically:

```bash
echo "PROJECT_SLUG=my-app" > .rembric
```

Without that file the bridge connects path-less (`/mcp`) and operates in global scope.

#### Credentials — REQUIRED: shell env vars

Codex does **not** have a `userConfig` keychain prompt like Claude Code, and Codex does **not** substitute `${user_config.*}` placeholders in plugin manifests (verified against `developers.openai.com/codex/plugins/build` and `/codex/hooks`). The plugin therefore reads its credentials from process env.

You **must** `export` the following in the shell that launches `codex`:

```bash
# in ~/.zshrc (or .bashrc, etc.) — required for the Codex plugin to work
export REMBRIC_SERVER_URL="https://memory.example.com"     # no trailing slash, no /mcp suffix
export REMBRIC_API_TOKEN="$(cat ~/.rembric/codex-token)"   # token minted from /dashboard/tokens
```

Then restart your terminal (or `source ~/.zshrc`) before launching `codex`. The same two envs feed:

- The **MCP bridge** — `plugin/.codex-plugin/mcp.json` declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`, Codex's native mechanism for reading specific env vars from the parent shell at MCP subprocess spawn time (`create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`). Codex does NOT inherit the full parent env automatically — `LocalStdioServerLauncher::launch_server` calls `Command::env_clear()` before applying the curated env, so only the names you list under `env_vars` are forwarded, on top of `DEFAULT_ENV_VARS`. The same manifest also uses `cwd: "."` + `args: ["./bin/rembric-bridge.mjs"]` to anchor the bridge path to the plugin root — `${CLAUDE_PLUGIN_ROOT}` substitution does NOT work in MCP args under Codex (only in hook commands), so future contributors should not "simplify" the path back to the Claude Code form.
- The **lifecycle hooks** (`SessionStart`, `PreCompact`, `Stop`) so sessions appear in `/dashboard/sessions` and PreCompact persists a summary.

Symptoms of missing envs:

- `/dashboard/sessions` stays empty even when MCP tool calls work fine.
- `codex --debug` shows `[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN` (bridge) or `[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST /api/...` (hooks).

#### Enable plugin_hooks and trust hooks (REQUIRED)

MCP authenticates after install + env exports. For lifecycle hooks (session creation, summary-on-compact, end-on-stop) to actually fire under Codex, **two extra one-time steps are mandatory** as of `codex-cli 0.130.0`. Skip them and `/dashboard/sessions` stays empty no matter how many Codex sessions you run.

**Step 1 — enable the `plugin_hooks` feature.** Codex ships this feature as `under development` and disabled by default in `0.130.0`. Verify and enable from any shell:

```bash
codex features list | grep plugin_hooks     # confirms current state
codex features enable plugin_hooks          # writes [features] plugin_hooks = true to ~/.codex/config.toml
```

Newer Codex releases may default this feature on — run `codex features list` first to confirm you actually need the step. If it already reports `plugin_hooks  stable  true`, skip.

**Step 2 — trust the hooks inside Codex.** Restart Codex after step 1. On startup Codex shows a banner of the form _"4 hooks need review before they can run. Open `/hooks` to review them."_ Open `/hooks` from inside Codex and approve each of the four Rembric hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`). The trust persists in `~/.codex/config.toml` under `[hooks.state]`, so this is a one-time-per-hook step — subsequent Codex launches do not re-prompt.

After both steps, the `/plugins` panel for `rembric` shows `Hooks: PreCompact (1), SessionStart (1), UserPromptSubmit (1), Stop (1)` and the first new Codex session will POST to `/api/<slug>/sessions` against the Rembric server (visible at `/dashboard/sessions`).

##### Symptom → cause table

| Symptom in Codex                                                                                                                | Cause                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dashboard/sessions` stays empty after Codex sessions                                                                          | `plugin_hooks` feature is off (Step 1) **OR** hooks have not been approved via `/hooks` (Step 2). MCP can still work while hooks silently no-op.                                                       |
| `/plugins` panel shows `Hooks: No plugin hooks`                                                                                 | `plugin_hooks` feature is off. The plugin's `hooks.codex.json` is parsed only when the feature is enabled.                                                                                             |
| Startup banner _"N hooks need review"_ keeps appearing across launches                                                          | Step 2 not completed for some hooks. Open `/hooks` and approve any handler whose status is `Untrusted` or `Modified`.                                                                                  |
| Hook fires but Codex reports `error: hook returned invalid session start JSON output` (or `... user prompt submit JSON output`) | Known plugin bug, separate change. Codex requires hook stdout to be JSON `{ hookSpecificOutput: { additionalContext: "..." } }`; plugin scripts currently emit plain text. Tracked for plugin `0.2.3`. |

#### Using both Claude Code and Codex on the same machine

The two clients pick up credentials from different places — keep both configured:

| Client          | Where to put credentials                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Install wizard (`/plugin install rembric@rembric`) → keychain. Hooks pick them up automatically via `${user_config.*}` substitution. **No shell exports required.** |
| **Codex CLI**   | `export REMBRIC_SERVER_URL=…` and `export REMBRIC_API_TOKEN=…` in your shell rc. Bridge and hooks both read process env. **No wizard exists.**                      |

If you only use one client, set up just that one. If you use both, you need both — the wizard input does NOT propagate to Codex's process, and the shell exports are NOT consumed by Claude Code's hooks (Claude Code substitutes from the keychain, not from `process.env`). Same Rembric server, same token, two configuration surfaces.

#### Updating the plugin

Codex caches plugins by `version` under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, so the cache invalidates when we bump `plugin/.codex-plugin/plugin.json`. Official commands (`developers.openai.com/codex/plugins`):

```shell
# refresh ALL configured marketplaces
codex plugin marketplace upgrade

# or refresh a specific one
codex plugin marketplace upgrade rembric
```

After the marketplace catalog refresh, Codex picks up the new version on the next plugin load. If Codex reports it's still on the cached version, fall back to a clean cycle from inside Codex's `/plugins` panel: select the plugin, **Uninstall plugin**, then **Install plugin** again (the docs do not yet expose a per-plugin `update` command — this is the supported alternative).

Restart `codex` after the update so the bridge and hooks re-spawn from the new cache path.

### Hermes Agent (memory provider plugin)

Hermes Agent (Nous Research) loads Rembric as a native Python `MemoryProvider` from `plugin/.hermes-plugin/`. Two pieces compose:

> **Plugin `0.6.0+` required against Rembric `0.13.0+`.** The provider's `is_available()` now sends `Authorization: Bearer ${REMBRIC_API_TOKEN}` to `/healthz` (the server made the endpoint bearer-gated in `0.13.0`). The env var was already required for every other call; this just tightens an existing requirement. Running plugin `0.5.x` against server `0.13+` will silently disable the memory provider — upgrade in lock-step.


| Piece                            | What it does                                                | Wired via                                                                  |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **`memory.provider: rembric`**   | Auto session create / summary-on-compact / end-on-close     | The Python provider plugin (this section)                                  |
| **`mcp_servers.rembric`**        | Full memory tool surface (save/search/get/context/judge/…)  | The shared `bin/rembric-bridge.mjs` invoked as a stdio MCP server          |

Install with one shell command — no `git clone` of rembric required:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

The script drops three files (`plugin.yaml`, `__init__.py`, `README.md`) into `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/`. Inspect before running with `curl … | less`. Developers iterating locally: same script, `PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh`.

**Private repo?** Set a GitHub PAT (`repo` scope) in your env and add the auth header to the outer curl — the installer reuses the token for the three internal fetches automatically (`GH_PAT`, `GH_TOKEN`, or `GITHUB_TOKEN`, first non-empty wins):

```sh
export GH_PAT=ghp_xxxxxxxx
curl -fsSL -H "Authorization: Bearer $GH_PAT" \
  https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

> **Why curl-pipe-sh, not `hermes plugins install`?** Hermes's installer (`hermes_cli/plugins_cmd.py::_resolve_git_url` at v0.4.x) accepts only `owner/repo` shorthand or a full Git URL — it does NOT support monorepo subpaths. Cloning the whole rembric repo into `~/.hermes/plugins/rembric/` to extract three files would mean tens of MB of unrelated TS source. The curl-installer ships the right artifacts and nothing else.

Then drop this block into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  rembric:
    command: npx
    args: ["-y", "mcp-remote@latest", "${REMBRIC_SERVER_URL}/mcp", "--header", "Authorization: Bearer ${REMBRIC_API_TOKEN}", "--allow-http"]

memory:
  provider: rembric
```

#### Credentials — install-time prompt writes `~/.hermes/.env`

The plugin's `plugin.yaml` declares its three runtime env vars via `requires_env:`. Running `hermes plugins install rembric` prompts the user at install time and writes the answers to `${HERMES_HOME:-~/.hermes}/.env` via Hermes's standard `save_env_value`. Hermes loads that file into `os.environ` on every launch AND forwards the same env to the `mcp_servers.*` subprocesses — single source of truth for both the in-process provider and the MCP bridge.

```bash
# After the curl-installer drops the plugin files:
hermes plugins install rembric
# Hermes prompts:
#   REMBRIC_SERVER_URL — Rembric server base URL (WITHOUT /mcp suffix)
#   REMBRIC_API_TOKEN  — Bearer token (input hidden, secret: true)
#   REMBRIC_PROJECT_SLUG — Default project slug

hermes plugins enable rembric
```

If you've already `export`ed any of the three vars in the shell that launches Hermes, the corresponding prompts are skipped (Hermes only asks for vars not already in env). For automated installs, pre-export the three values before running `hermes plugins install`.

To change a value later: edit `~/.hermes/.env` directly and restart Hermes, or re-run `hermes plugins install rembric`.

> **Symptom check**: if MCP tool calls work (memory.save / memory.search round-trip in the dashboard) but `/dashboard/sessions` never gets a row with `agent=hermes`, verify with `cat ~/.hermes/.env | grep REMBRIC_` that the three vars made it into the file. If they didn't, re-run `hermes plugins install rembric`. Single file, no `~/.rembric/.env` workaround needed since 0.4.0.

#### Project slug resolution

The provider needs a project slug for every session-lifecycle POST. Cascade, first valid match wins:

1. `REMBRIC_PROJECT_SLUG` env var.
2. `${HERMES_HOME:-$HOME/.hermes}/rembric.json` → `"project_slug"` (written by `hermes plugins config rembric`).
3. `<cwd>/.rembric` → `PROJECT_SLUG=<slug>` (same dotenv format as the Claude/Codex plugins).
4. Trailing path segment of `REMBRIC_SERVER_URL` if it ends in `/mcp/<slug>`.
5. No slug → all session POSTs skip silently (`[rembric] no project slug …` stderr diagnostic once).

Every candidate is validated against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Pick whichever source matches your workflow — solo / single-project users go with step 1 or 2, multi-project users with `.rembric` files, path-scoped URL users get step 4 automatically.

#### Symptom → cause table

| Symptom in Hermes                                                                                | Cause                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hermes plugins install rembric` skipped the env prompts                                          | The three `REMBRIC_*` vars are already set in the parent shell. This is by design — Hermes only prompts for vars not in env. To force re-prompts: `unset REMBRIC_SERVER_URL REMBRIC_API_TOKEN REMBRIC_PROJECT_SLUG` then re-run the install.                       |
| MCP tools work but `/dashboard/sessions` never gets a row with `agent=hermes`                    | Either the provider isn't loaded or `~/.hermes/.env` wasn't populated. Verify `memory.provider: rembric` in `~/.hermes/config.yaml` AND `cat ~/.hermes/.env \| grep REMBRIC_` shows all three vars.                                                                |
| `hermes memory status` lists `rembric` as available but `/dashboard/sessions` stays empty        | Token doesn't have `write` permission for the project (visit `/dashboard/tokens` to inspect — `read` alone returns 403 on session POST, which the provider logs to stderr only). Revoke + reissue from `/dashboard/tokens` scoped to the project with the default `write` permission. |
| stderr shows `[rembric] no project slug for session …; skipping session POST`                    | None of the four cascade sources produced a slug. Set `REMBRIC_PROJECT_SLUG` in `~/.hermes/.env` (or re-run `hermes plugins install rembric` to be prompted).                                                                                                       |
| stderr shows `[rembric] POST /sessions failed: HTTPError 404`                                    | `REMBRIC_SERVER_URL` is path-scoped (e.g. ends in `/mcp/<slug>`). The provider needs the bare server URL — use `REMBRIC_PROJECT_SLUG` for the slug, not the URL.                                                                                                    |
| MCP tools fail and `hermes memory status` reports `rembric: Missing`                             | The Python provider isn't loaded. Confirm `memory.provider: rembric` in `~/.hermes/config.yaml`, then `hermes plugins enable rembric`. Restart Hermes.                                                                                                              |
| Provider tracks slug `A`, MCP bridge tracks slug `B`                                              | Cascade reads from process env / files; the bridge reads from its `args`. Pin `REMBRIC_PROJECT_SLUG` (read by the provider) AND keep the bridge URL aligned, OR set both via env.                                                                                  |
| You edited `~/.hermes/.env` and Hermes didn't pick up the new value                              | Hermes reads `.env` at startup, not on every session. Restart Hermes.                                                                                                                                                                                                |
| `hermes plugins update rembric` reports nothing to update                                        | The provider was not installed via `hermes plugins install`. Re-run the curl-installer — it's idempotent and overwrites the three files.                                                                                                                            |

#### Using Hermes alongside Claude Code or Codex on the same machine

Credentials, slug source, and update flow are independent per client. The Rembric server side is identical — same token, same `/api/<slug>/sessions(*)` endpoints. The clients just configure their adapters differently:

| Client          | Credentials from                                  | Slug from                                                          | Update                                                                                        |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Claude Code** | Wizard → keychain (`${user_config.*}`)             | `.rembric` file via the bridge                                     | `/plugin update rembric@rembric`                                                              |
| **Codex CLI**   | Shell env (`export REMBRIC_*`)                     | `.rembric` file via the bridge                                     | `codex plugin marketplace upgrade rembric` + restart                                          |
| **Hermes Agent**| Shell env OR `~/.rembric/.env` preload             | Cascade (env / `rembric.json` / `.rembric` / URL parse)            | Re-run the curl-installer                                                                     |

Both the Hermes MCP bridge entry (`mcp_servers.rembric`) and the Hermes provider read the same shell env, so a single shell rc edit covers them. No keychain (Hermes has no `userConfig` equivalent; `get_config_schema()` is provider-managed storage in `~/.hermes/rembric.json`).

### OpenClaw (native memory-provider plugin)

OpenClaw loads Rembric as a native Node plugin from `plugin/.openclaw-plugin/`. Architecturally closest to Hermes (in-process memory provider; no MCP subprocess; HTTP-only to the Rembric server) but with OpenClaw's first-class tool registration so all 17 `memory_*`/`project_*` tools surface natively without a separate `mcpServers` config.

> **OpenClaw memory slot is exclusive: one active provider per OpenClaw instance.** If you currently have `memory-lancedb` or `agentmemory` in `plugins.slots.memory`, installing Rembric will leave it inactive until you switch the slot. See the snippet below.

Install via the OpenClaw CLI. The plugin lives at `plugin/.openclaw-plugin/` inside the rembric repo (sibling to the Claude / Codex / Hermes sub-trees in the shared `plugin/` directory) — clone first, then `path:` install pointing at that sub-tree:

```sh
git clone https://github.com/susomejias/rembric.git /tmp/rembric
openclaw plugins install path:/tmp/rembric/plugin/.openclaw-plugin
```

Or, for iterative development (symlinks the directory so saved edits show up without reinstall):

```sh
openclaw plugins install --link /tmp/rembric/plugin/.openclaw-plugin
```

> **Why not `openclaw plugins install git:https://github.com/susomejias/rembric.git`?** OpenClaw's git-install path (`/tmp/openclaw/src/plugins/install.ts:1285`) looks for `package.json` and `openclaw.plugin.json` at the ROOT of the cloned repository — it does not support a subdir/subpath syntax (verified against `plugins-install-command.ts` and `install.ts` source). Our plugin lives at `plugin/.openclaw-plugin/` inside the shared `plugin/` tree, so direct `git:repo` install would fail to find the manifest. Source kinds accepted by `openclaw plugins install` are `path | archive | npm-spec | git:repo | clawhub:pkg` — we use `path:` (after clone) for v1. A follow-up change may introduce a satellite repo (`rembric-openclaw-plugin`) with the plugin tree at root, or publish via ClawHub, to unlock single-command `git:` install.

Then configure the plugin in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "slots": {
      "memory": "rembric"  // ← required for auto-recall + memory capability
    },
    "entries": {
      "rembric": {
        "enabled": true,
        "config": {
          "server_url": "https://memory.example.com", // no /mcp suffix, no trailing slash
          "api_token": "rbr_...",                     // mint from /dashboard/tokens
          "autoRecall": true,                         // inject memories into every prompt (default)
          "autoCapture": false,                       // off by default — Rembric prefers explicit memory_save
          "tokenBudget": 1800,                        // approx tokens for the auto-recall context block
          "project_slug": "my-project"                // OPTIONAL: pin all memory tool calls to /mcp/<slug>
                                                      //   AND override per-cwd .rembric resolution.
                                                      //   Omit to use .rembric files per project root.
        }
      }
    }
  }
}
```

Restart OpenClaw. Verify with `/rembric status` inside an OpenClaw session — the slash command surfaces server URL, masked API token, and memory-slot ownership state.

#### Memory-slot collision (only one active at a time)

OpenClaw routes the memory-capability prompt through whichever plugin owns `plugins.slots.memory`; Rembric's runtime auto-recall is wired through the typed `before_prompt_build` hook and Rembric blocks OpenClaw file-backed `MEMORY.md` / `memory/*.md` writes via `before_tool_call`. If you previously configured a different memory plugin:

```jsonc
// Before:
{ "plugins": { "slots": { "memory": "memory-lancedb" } } }

// After (Rembric takes over auto-recall + memory prompt guidance):
{ "plugins": { "slots": { "memory": "rembric" } } }
```

The plugin emits a structured warning at register time when `plugins.slots.memory !== "rembric"`, so a quick `openclaw plugins logs rembric` (or your OpenClaw logging surface) shows the slot mismatch explicitly.

#### Auto-recall token budget

`autoRecall: true` calls `memory.search` against the current prompt on every turn and injects up to `tokenBudget` tokens of context. If you came from `memory-lancedb` or `agentmemory`, tune `tokenBudget` to match the budget you were used to (memory-lancedb's default is around 2000; Rembric defaults to 1800). Larger budget = more context, more LLM cost per turn.

#### Auto-capture is OFF by default

Unlike memory-lancedb, Rembric's `autoCapture` defaults `false`. Rembric's append-only `(scope, project_id, topic_key)` graph expects each save to declare a `topic_key` that lets the server cluster related memories together. Auto-capture without a `topic_key` would generate orphan rows that consolidator-orphan-promotion has to clean up later. Set `autoCapture: true` only if you understand that trade-off; the explicit `memory_save` tool is the recommended write path.

#### Symptom → cause table

| Symptom in OpenClaw                                                            | Cause                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/rembric status` shows `memory slot: <other> (INACTIVE)`                     | Another plugin owns `plugins.slots.memory`. Update `~/.openclaw/openclaw.json` per the snippet above and restart OpenClaw.                                                          |
| Auto-recall isn't injecting memories                                          | Either `autoRecall: false`, the slot is INACTIVE, or `memory.search` is failing. Check the log: the plugin warns on every failed search via `api.logger.warn`.                       |
| A tool call is blocked with "Do not write MEMORY.md or memory/\*.md"          | Rembric owns the memory slot, so OpenClaw's file-backed memory write path is intentionally blocked. Use `memory_save` so the memory is stored in Rembric.                              |
| `openclaw plugins inspect rembric` shows no Tools/Hooks                       | The default inspect path is manifest-only. Use `openclaw plugins inspect rembric --runtime` to force runtime registration and see typed hooks/tools.                                  |
| `/dashboard/sessions` stays empty when running OpenClaw                       | No project slug resolved. Set `plugins.entries.rembric.config.project_slug` or add `.rembric::PROJECT_SLUG=<slug>` in the working directory; lifecycle hooks skip POSTs without it.   |
| Tool calls return errors like `mcp_error — token_invalid`                     | `api_token` in the config is wrong or revoked. Mint a new one at `/dashboard/tokens` and update the config.                                                                          |
| Tool calls return `mcp_init_failed`                                           | The plugin can't reach the Rembric server. Check `server_url`; the plugin retries `initialize` once per call, but a persistent network/DNS issue surfaces as `mcp_init_failed`.     |

#### Updating the plugin

Since v1 install is path-based (clone + `path:`), updates require pulling the repo and re-running install:

```sh
cd /tmp/rembric && git pull origin main
openclaw plugins install path:/tmp/rembric/plugin/.openclaw-plugin   # overwrites
```

If you installed with `--link`, edits to the cloned repo are picked up immediately (after restarting OpenClaw to re-register the plugin code). The plugin's `version` field in `openclaw.plugin.json` participates in OpenClaw's update detection and bumps in lock-step with the other three clients (Claude / Codex / Hermes) on every plugin release — see `plugin/CHANGELOG.md`. Once a satellite repo or ClawHub publication lands, `openclaw plugins update rembric` becomes the canonical flow.

### Codex CLI (manual config.toml, no plugin)

If you do not want to install the plugin, wire Codex to Rembric directly over Streamable HTTP. The trade-off: the slug is hardcoded in the URL, so you must edit `~/.codex/config.toml` (or maintain multiple `[mcp_servers.X]` blocks) when switching projects.

`~/.codex/config.toml`:

```toml
[mcp_servers.rembric]
transport = "streamable-http"
url = "https://memory.example.com/mcp/my-app"
headers = { Authorization = "Bearer codex-token-XXXXXXXX" }
```

> Heads-up: the manual path has no Codex hooks, so session lifecycle (creation, summary-on-compact, end-on-stop) depends entirely on the agent's discipline to call `memory.session_start` / `memory.session_summary` / `memory.session_end` over MCP. The plugin install is the recommended path — its hooks POST to `/api/<slug>/sessions(*)` automatically, so sessions are tracked regardless of agent diligence.

## Any other MCP client

Cursor, Windsurf, VS Code Copilot Chat, Gemini CLI, OpenCode, etc. — they all speak Streamable HTTP with the same URL + Bearer shape. Locate their MCP config file in the client's docs and drop in the same block, adjusting field names (`type`, `transport`, `httpUrl`, plain `url`) to match.

If your client is stdio-only, use `mcp-remote` (the same package the Rembric plugin's bridge wraps) as a stdio↔HTTP shim. See its README for the exact spawn command; the Rembric plugin's `bin/rembric-bridge.mjs` is a working reference.

## `project_suggestion_pending`

When you connect to `/mcp` (path-less) and roots-based discovery surfaces a slug that does not yet exist as a project, write tools refuse to silently fall through to global. They return:

```json
{
  "ok": false,
  "code": "project_suggestion_pending",
  "message": "...",
  "suggestedSlugs": ["acme-research"]
}
```

Two resolutions, both belong to the user:

- **Stay global**: re-issue passing `scope: 'global'` explicitly.
- **Mint the project**: `project.use({slug, autocreate: true})`, then re-issue.

Never autocreate or autopin silently.

## Surviving compaction

Long-running agents compact their context. To survive that, two tools fire at specific moments:

- **Before "done" / before compaction**: `memory.session_summary({Goal, Discoveries, Accomplished, Next Steps, Files})` closes the session and persists the state.
- **After compaction / new session**: `memory.context({sessions, prompts, memories})` restores it.

The proactive-save protocol embedded in `initialize.instructions` already tells agents to do this. If your client ignores the field, paste the equivalent into the client's rules file (`AGENTS.md`, `.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `~/.gemini/system.md`, etc.).

## Verifying

After registering, ask the agent to list its tools — you should see the `memory.*` and `project.*` families. Save a test memory, then check `/dashboard/memories` for the row.

## Cross-references

- Tool surface and parameters: each tool's MCP description (call `tools/list` from your client).
- Relation graph and `memory.judge` cadence: [docs/relations.md](./relations.md).
- Session deletion / undelete: dashboard `/dashboard/sessions` (toggle `?include_deleted=1` to surface soft-deleted rows).
