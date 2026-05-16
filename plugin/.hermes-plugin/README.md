# Rembric — Hermes Agent plugin

Memory for [Hermes Agent](https://hermes-agent.nousresearch.com), backed by your self-hosted [Rembric](https://github.com/susomejias/rembric) server.

## Install

One command, no `git clone` needed:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

The installer drops three files (`plugin.yaml`, `__init__.py`, `README.md`) into `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/`. Inspect the script first if you prefer:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | less
```

Developing against a local rembric clone? Same script, local source:

```sh
PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh
```

### Private repo? Pass a GitHub PAT.

If the `susomejias/rembric` repo is private (or you're hosting your own fork as a private repo), plain `curl` will get a 404 from `raw.githubusercontent.com`. Create a [Personal Access Token](https://github.com/settings/tokens) with `repo` scope, export it, and the installer picks it up automatically (`GH_PAT`, `GH_TOKEN`, or `GITHUB_TOKEN` — first non-empty wins):

```sh
export GH_PAT=ghp_xxxxxxxx
curl -fsSL -H "Authorization: Bearer $GH_PAT" \
  https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

The token is inherited by the piped `sh` subprocess and reused for the three internal file fetches. The script never writes it to disk; it only flows through env + the per-request `Authorization` header. SSH-based clone + `PLUGIN_SRC` local install is the alternative if you'd rather not handle PATs at all.

## Configure

The plugin works in two complementary modes — **wire both** unless you really only want lifecycle without tool access:

| Mode                | What you get                                                 | Where it's configured                      |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **Memory provider** | Auto session create / summary-on-compact / end-on-close      | `memory.provider: rembric` (this plugin)   |
| **MCP server**      | Full memory tool surface (save/search/get/context/judge/...) | `mcp_servers.rembric` (the bundled bridge) |

Drop this block into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  rembric:
    command: npx
    args:
      [
        '-y',
        'mcp-remote@latest',
        '${REMBRIC_SERVER_URL}/mcp',
        '--header',
        'Authorization: Bearer ${REMBRIC_API_TOKEN}',
        '--allow-http',
      ]

memory:
  provider: rembric
```

> If you have rembric cloned locally and want to skip `npx`, point `command: node` at `<rembric-clone>/plugin/bin/rembric-bridge.mjs` instead — same bridge, no transient install.

## Environment variables

| Variable               | Required | Description                                                                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `REMBRIC_SERVER_URL`   | ✓        | Base URL of your Rembric deployment, **without** the `/mcp` suffix. Example: `https://memory.example.com`. No trailing slash. |
| `REMBRIC_API_TOKEN`    | ✓        | Bearer token issued by `rembric token create`. Goes in your shell env or in `~/.rembric/.env`.                                |
| `REMBRIC_PROJECT_SLUG` | —        | Project slug for session-lifecycle POSTs. See "Project slug resolution" below — usually you don't need to set this.           |
| `HERMES_HOME`          | —        | Override Hermes's home dir (default `~/.hermes`). Honoured by the installer and the slug cascade.                             |
| `XDG_CONFIG_HOME`      | —        | If set, the plugin also reads `${XDG_CONFIG_HOME}/rembric/.env` as a preload source.                                          |

### Where to put the values

**Recommended: `~/.rembric/.env`.** This is the path validated against real Hermes deployments. Hermes does NOT consistently propagate parent-shell env vars to the Python subprocess that loads memory providers — so even if you `export REMBRIC_SERVER_URL=...` in your `~/.zshrc`, the provider may not see it and silently skip every session POST. The plugin reads `~/.rembric/.env` at module-import time via `os.environ.setdefault`, which means the values are guaranteed to be in `os.environ` when `initialize()` fires — without depending on how Hermes invokes the subprocess.

```sh
mkdir -p ~/.rembric
cat > ~/.rembric/.env <<'EOF'
REMBRIC_SERVER_URL=http://your-server:8787
REMBRIC_API_TOKEN=<token-from-rembric-token-create>
REMBRIC_PROJECT_SLUG=<your-slug>
EOF
chmod 600 ~/.rembric/.env
```

Other sources (in case the `.env` file doesn't fit your workflow), checked in this order at every Hermes launch:

1. **Shell env** (e.g. `export REMBRIC_SERVER_URL=...` in `~/.zshrc`) — always wins when the value reaches the provider's process. Suitable for interactive development; risky for `hermes` launched by systemd, tmux, or any wrapper that may not propagate env.
2. **`~/.rembric/.env`** — preloaded by the plugin at module import via `os.environ.setdefault`. Bulletproof regardless of how Hermes is launched. **Use this unless you have a specific reason not to.**
3. **Hermes's own config prompt** — `hermes plugins config rembric` runs `get_config_schema()` and stores the answers in `~/.hermes/rembric.json`. The plugin reads it for `project_slug` only; URL and token still come from env.

## Project slug resolution

Rembric scopes everything to a project slug. The provider resolves it on each `initialize` via a five-step cascade — the **first** valid match wins:

1. `REMBRIC_PROJECT_SLUG` environment variable.
2. `~/.hermes/rembric.json` → `"project_slug"` (or `${HERMES_HOME}/rembric.json`).
3. `<cwd>/.rembric` → `PROJECT_SLUG=<slug>` (paridad with the Claude/Codex plugins).
4. The trailing segment of `REMBRIC_SERVER_URL`'s path if it ends in `/mcp/<slug>`.
5. No slug → all session-related POSTs skip silently (a single stderr diagnostic is printed once).

Every candidate is validated against the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Non-matching values are discarded and the cascade continues.

Typical setups:

| You are…                                                                    | Recommended source                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A single-project Hermes user                                                | `REMBRIC_PROJECT_SLUG` in your shell env, OR `~/.hermes/rembric.json` via `save_config`. |
| Multi-project, repo-pinned                                                  | `.rembric` file at each project root with `PROJECT_SLUG=<your-slug>`.                    |
| Already pinning the MCP URL to `https://server/mcp/<slug>` in `config.yaml` | No action — step 4 picks the slug from the URL automatically.                            |

## Lifecycle (what the plugin actually does)

The provider implements three lifecycle methods that map 1:1 to Rembric's HTTP session endpoints:

- `initialize(session_id, cwd)` → `POST /api/<slug>/sessions` with `{id, cwd, agent: "hermes"}`.
- `on_pre_compress(messages)` → joins messages into a transcript, caps at 20,000 chars, `POST /api/<slug>/sessions/<id>/summary`.
- `on_session_end(messages)` → `POST /api/<slug>/sessions/<id>/end`.

The other `MemoryProvider` methods (`prefetch`, `system_prompt_block`, `sync_turn`, `on_memory_write`, `queue_prefetch`) are intentional no-ops in this version — those operations live exclusively on the MCP surface, so the bridge (wired via `mcp_servers.rembric`) handles them when the agent calls `memory.search` / `memory.context` / `memory.save` directly.

## Troubleshooting

| Symptom                                                                                   | Likely cause                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MCP tool calls work but `/dashboard/sessions` never shows a row with `agent=hermes`**   | **Most common cause.** Hermes did not propagate the shell's `REMBRIC_*` env to the Python provider subprocess, so `initialize()` runs with empty env and skips the session POST silently. **Fix: create `~/.rembric/.env`** with `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`, and `REMBRIC_PROJECT_SLUG` (see "Where to put the values" above), then restart Hermes. |
| `hermes memory status` shows `rembric` as available but `/dashboard/sessions` stays empty | Token doesn't have `write` permission for the project (`rembric token list` to check). Re-issue with `rembric token create --scope project --slug <slug>` (write is the default).                                                                                                                                                                                  |
| stderr shows `[rembric] no project slug for session ...; skipping session POST`           | None of the five cascade sources produced a valid slug. Set `REMBRIC_PROJECT_SLUG` in your `~/.rembric/.env`.                                                                                                                                                                                                                                                      |
| MCP works but `hermes memory status` reports `rembric: Missing`                           | The provider isn't loaded. Confirm `memory.provider: rembric` is in `~/.hermes/config.yaml` AND `hermes plugins enable rembric` was run after install.                                                                                                                                                                                                             |
| Provider sends sessions to slug X, but MCP tool calls land in slug Y                      | Bridge and provider read slug from different places. Pin the slug explicitly with `REMBRIC_PROJECT_SLUG` (read by both) or hardcode the same `/mcp/<slug>` in both the YAML `args` and the `.env` file.                                                                                                                                                            |
| `~/.rembric/.env` exists but the values aren't applied                                    | Shell-set env vars win over the file (`os.environ.setdefault` semantics). `unset REMBRIC_SERVER_URL` in the shell, restart Hermes. Useful if you want to override a `.env` value temporarily without editing the file.                                                                                                                                             |
| stderr shows `[rembric] POST /sessions failed: HTTPError 404`                             | `REMBRIC_SERVER_URL` is path-scoped (e.g. ends in `/mcp/<slug>`). The provider builds HTTP URLs by appending paths to the base, so the base must be the bare server URL (`http://host:8787`). Use `REMBRIC_PROJECT_SLUG` for slug resolution, NOT the URL.                                                                                                         |

For deeper agent-side debug (`hermes memory status`, plugin-load trace), see Hermes's docs at <https://hermes-agent.nousresearch.com/docs>.

## Updating

Re-run the installer. The script is idempotent — it overwrites the three files.

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
```

`hermes plugins update rembric` will **not** work because the plugin was not installed via `hermes plugins install owner/repo` (Hermes's installer doesn't accept monorepo subpaths today, verified against `hermes_cli/plugins_cmd.py::_resolve_git_url` at v0.4.x). The curl-installer is the canonical update path.
