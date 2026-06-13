# Rembric — Hermes Agent plugin

Memory for [Hermes Agent](https://hermes-agent.nousresearch.com), backed by your self-hosted [Rembric](https://github.com/susomejias/rembric) server.

## Install

Use the **TUI installer** — the single recommended path. It runs the manual steps below for you and handles update/uninstall too:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh
# → Plugins → hermes → install
```

### Manual install

Two commands, no `git clone` needed:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
hermes plugins install rembric
hermes plugins enable rembric
```

`hermes plugins install rembric` prompts for the three values the plugin needs (declared in `plugin.yaml::requires_env`) and writes them to `${HERMES_HOME:-~/.hermes}/.env`:

- **`REMBRIC_SERVER_URL`** — base URL of your deployment, **without** the `/mcp` suffix. The bridge appends `/mcp/<slug>` itself when you wire it.
- **`REMBRIC_API_TOKEN`** — Bearer token minted from the Rembric dashboard at `/dashboard/tokens` (plaintext shown exactly once). Marked `secret: true` in the manifest so the prompt hides the input.
- **`REMBRIC_PROJECT_SLUG`** — default project slug for session-lifecycle POSTs.

If the three vars are already exported in the shell that launches `hermes`, the install skips the corresponding prompts.

Inspect the install script first if you prefer:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | less
```

Developing against a local rembric clone? Same script, local source:

```sh
PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh
```

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
        '${REMBRIC_SERVER_URL}/mcp/${REMBRIC_PROJECT_SLUG}',
        '--header',
        'Authorization: Bearer ${REMBRIC_API_TOKEN}',
        '--allow-http',
      ]

memory:
  provider: rembric
```

The three `${REMBRIC_*}` env vars come from `~/.hermes/.env` (written by `hermes plugins install rembric`). Hermes loads that file into the process env at startup and forwards it to the `mcp_servers.*` subprocesses, so `mcp-remote` sees the values.

> If you have rembric cloned locally and want to skip `npx`, point `command: node` at `<rembric-clone>/plugin/bin/rembric-bridge.mjs` instead — same bridge, no transient install.

## Environment variables

| Variable               | Required | Description                                                                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `REMBRIC_SERVER_URL`   | ✓        | Base URL of your Rembric deployment, **without** the `/mcp` suffix. Example: `https://memory.example.com`. No trailing slash. |
| `REMBRIC_API_TOKEN`    | ✓        | Bearer token minted from the Rembric dashboard at `/dashboard/tokens`.                                                        |
| `REMBRIC_PROJECT_SLUG` | ✓        | Default project slug. Overridden per-cwd if a `.rembric` file is present.                                                     |
| `HERMES_HOME`          | —        | Override Hermes's home dir (default `~/.hermes`). Honoured by the installer.                                                  |

### Where credentials live

All three vars live in **`${HERMES_HOME:-~/.hermes}/.env`** — single source of truth. The flow:

1. `hermes plugins install rembric` reads the manifest's `requires_env:` list, prompts the user for each value not already set in the parent shell, and writes the answers via `save_env_value` to `~/.hermes/.env`.
2. Subsequent Hermes launches read `~/.hermes/.env` into `os.environ` before plugins import. The provider sees the values via `os.environ.get(...)`.
3. Hermes also forwards the same env to the `mcp_servers.*` subprocesses it spawns — the bundled MCP bridge inherits the env automatically.

To change a value after install:

- Edit `~/.hermes/.env` directly (it's a flat dotenv file), then restart Hermes.
- Or re-run `hermes plugins install rembric` — it re-prompts for any var not already in the parent shell and rewrites the file via `save_env_value`.

The plugin **does not** read any plugin-private dotenv file (`~/.rembric/.env`, etc. are silently ignored). Earlier 0.3.x versions read `~/.rembric/.env` as a workaround; that mechanism was removed in 0.4.0 once `requires_env:` proved sufficient.

## Project slug resolution

Rembric scopes everything to a project slug. The provider resolves it on each `initialize` via a four-step cascade — the **first** valid match wins:

1. `REMBRIC_PROJECT_SLUG` environment variable (populated by Hermes from `~/.hermes/.env`).
2. `<cwd>/.rembric` → `PROJECT_SLUG=<slug>` (paridad with the Claude/Codex plugins; lets you pin a slug per-repo even when the default in `.env` is different).
3. The trailing segment of `REMBRIC_SERVER_URL`'s path if it ends in `/mcp/<slug>`.
4. No slug → all session-related POSTs skip silently (a single stderr diagnostic is printed once).

Every candidate is validated against the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Non-matching values are discarded and the cascade continues.

## Lifecycle (what the plugin actually does)

The provider implements three lifecycle methods that map 1:1 to Rembric's HTTP session endpoints:

- `initialize(session_id, cwd)` → `POST /api/<slug>/sessions` with `{id, cwd, agent: "hermes"}`.
- `on_pre_compress(messages)` → joins messages into a transcript, caps at 20,000 chars, `POST /api/<slug>/sessions/<id>/summary`.
- `on_session_end(messages)` → `POST /api/<slug>/sessions/<id>/end`.

The other `MemoryProvider` methods (`prefetch`, `system_prompt_block`, `sync_turn`, `on_memory_write`, `queue_prefetch`) are intentional no-ops — those operations live exclusively on the MCP surface, so the bridge (wired via `mcp_servers.rembric`) handles them when the agent calls `memory.search` / `memory.context` / `memory.save` directly.

## Troubleshooting

| Symptom                                                                              | Likely cause                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes memory status` shows `rembric: Missing` after install                        | Plugin not enabled. Run `hermes plugins enable rembric` and restart Hermes.                                                                                                                                                                                           |
| `hermes plugins install rembric` didn't prompt for the env vars                      | The three `REMBRIC_*` vars are already set in the parent shell, so Hermes skipped the prompts (this is by design). Verify via `env \| grep REMBRIC_`. To force re-prompts: `unset REMBRIC_SERVER_URL REMBRIC_API_TOKEN REMBRIC_PROJECT_SLUG` then re-run the install. |
| stderr shows `[rembric] no project slug for session ...; skipping session POST`      | None of the four cascade sources produced a valid slug. Confirm `REMBRIC_PROJECT_SLUG` is in `~/.hermes/.env`. Edit the file and restart Hermes, or re-run `hermes plugins install rembric`.                                                                          |
| stderr shows `[rembric] POST /sessions failed: HTTPError 403`                        | Token doesn't have `write` permission for the project. Inspect at `/dashboard/tokens` on the server; revoke and reissue scoped to the project with the default `write` permission.                                                                                    |
| stderr shows `[rembric] POST /sessions failed: HTTPError 404`                        | `REMBRIC_SERVER_URL` is path-scoped (ends in `/mcp/<slug>`). The provider needs the bare server URL — use `REMBRIC_PROJECT_SLUG` for the slug, NOT the URL. Edit `~/.hermes/.env` and remove the `/mcp/<slug>` suffix.                                                |
| MCP works (memory.save/search round-trip) but `/dashboard/sessions` never gets a row | The provider isn't loaded OR the install never wrote credentials. Confirm `memory.provider: rembric` is in `~/.hermes/config.yaml`, then `cat ~/.hermes/.env \| grep REMBRIC_` to verify the three vars are present.                                                  |
| You edited `~/.hermes/.env` and Hermes didn't pick up the new value                  | Hermes reads `.env` at startup, not on every session. Restart Hermes.                                                                                                                                                                                                 |

For deeper agent-side debug (`hermes memory status`, plugin-load trace), see Hermes's docs at <https://hermes-agent.nousresearch.com/docs>.

## Updating

Use the TUI installer (`Plugins → hermes → update`). Manual fallback — re-run the installer; the script is idempotent (overwrites the three files):

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
```

`hermes plugins update rembric` will **not** work because the plugin was not installed via `hermes plugins install owner/repo` (Hermes's installer doesn't accept monorepo subpaths today, verified against `hermes_cli/plugins_cmd.py::_resolve_git_url` at v0.4.x). The curl-installer is the canonical update path. Re-running `hermes plugins install rembric` after the file update re-runs the `requires_env` flow without overwriting existing values.

## Uninstall

Use the TUI installer (`Plugins → hermes → uninstall`). Manual fallback — run the uninstaller; it removes the three installed plugin files, disables the plugin, and is idempotent:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/uninstall.sh | sh
```

It **deliberately leaves** your credentials (`${HERMES_HOME:-~/.hermes}/.env`) and any `.rembric` project markers in place — it prints what it left so you can remove them by hand if you want. Honours `HERMES_HOME` like the installer.
