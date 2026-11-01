# Rembric — Hermes Agent plugin

Memory for [Hermes Agent](https://hermes-agent.nousresearch.com), backed by your self-hosted [Rembric](https://github.com/susomejias/rembric) server.

## Install

Use the **TUI installer** — the single recommended path. It runs the manual steps below for you and handles update/uninstall too:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh
# → Plugins → hermes → install
```

### Manual install

Use Hermes's native plugin manager (verified with Hermes v0.22.5):

```sh
hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable
```

Hermes records the repository/subdirectory source and installs under `${HERMES_HOME:-~/.hermes}/plugins/rembric`. `--enable` selects `memory.provider: rembric`, replacing any previous provider selection. This does not wire the separate MCP bridge.

Native installation prompts for missing values declared in `plugin.yaml::requires_env` and stores them in `${HERMES_HOME:-~/.hermes}/.env`:

- **`REMBRIC_SERVER_URL`** — base URL of your deployment, **without** the `/mcp` suffix. The bridge appends `/mcp/<slug>` itself when you wire it.
- **`REMBRIC_API_TOKEN`** — Bearer token minted from the Rembric dashboard at `/dashboard/tokens` (plaintext shown exactly once). Marked `secret: true` in the manifest so the prompt hides the input.
- **`REMBRIC_PROJECT_SLUG`** — default project slug for the provider and bridge.

The TUI prints native commands without executing them when Hermes is unavailable or a headless run lacks `--yes`. `--yes` authorizes invocation, not bypassing Hermes's dependency/security/capability consent.

Hermes mutations support only the default unpinned source: `REMBRIC_SRC`, `PLUGIN_SRC`, `REMBRIC_REF` and explicit `--ref` (including `main`, tags and SHAs) are rejected before mutation. Other clients keep their own source/ref behavior.

### Transition from a copied installation

The TUI refuses copied/untracked, linked, foreign-source, pinned or inconsistent targets rather than overwriting them. `hermes plugins adopt` cannot adopt a copied directory. Make a complete backup of the existing `plugins/rembric` directory **outside `plugins/`**, including unknown local files. Explicitly move the original directory outside plugin discovery, keep your credentials and MCP configuration, then run TUI **Plugins → hermes → install**. Keep the backup until you have verified the new install. Review existing native pins/source records separately; the TUI does not silently unpin or force-replace them.

## Configure

The plugin works in two complementary modes — **wire both** unless you really only want lifecycle without tool access:

| Mode                | What you get                                                 | Where it's configured                      |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| **Memory provider** | Auto session create / summary-on-compact / end-on-close      | `memory.provider: rembric` (this plugin)   |
| **MCP server**      | Full memory tool surface (save/search/get/context/judge/...) | `mcp_servers.rembric` (the bundled bridge) |

Drop this block into `~/.hermes/config.yaml`. Replace `<plugin-version>` with the exact version printed by the TUI installer (or in `~/.hermes/plugins/rembric/plugin.yaml`):

```yaml
mcp_servers:
  rembric:
    command: npx
    args: ['-y', '@rembric/mcp-bridge@<plugin-version>']
    env:
      REMBRIC_SERVER_URL: ${REMBRIC_SERVER_URL}
      REMBRIC_API_TOKEN: ${REMBRIC_API_TOKEN}
      REMBRIC_PROJECT_SLUG: ${REMBRIC_PROJECT_SLUG}
    enabled: true

memory:
  provider: rembric
```

Configure these settings for each active Hermes profile. The provider resolves them through Hermes' `agent.secret_scope.get_secret` API; the explicit `env` map configures the separate MCP bridge. Both prefer a valid per-directory `.rembric` slug. Without a valid slug, the provider skips requests with a diagnostic; the bridge uses path-less `/mcp`.

## Environment variables

| Variable               | Required | Description                                                                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `REMBRIC_SERVER_URL`   | ✓        | Base URL of your Rembric deployment, **without** the `/mcp` suffix. Example: `https://memory.example.com`. No trailing slash. |
| `REMBRIC_API_TOKEN`    | ✓        | Bearer token minted from the Rembric dashboard at `/dashboard/tokens`.                                                        |
| `REMBRIC_PROJECT_SLUG` | —        | Optional default project slug. Overridden by a valid per-directory `.rembric` file.                                           |
| `HERMES_HOME`          | —        | Override Hermes's home dir (default `~/.hermes`). Honoured by the installer.                                                  |

### Where credentials live

Hermes owns credential storage, normally the active profile's `${HERMES_HOME}/.env`, populated by the manifest's `requires_env` prompts. The provider resolves `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and the default slug through `agent.secret_scope.get_secret` during initialization, then retains the server, token and resolved slug on that provider instance. Later hooks and session switches do not re-read credentials. Background summary/turn requests capture the binding before dispatch through Hermes' `spawn_context_thread`, so another profile or an exited secret scope cannot redirect them. Identical slugs on different servers or with different tokens remain independent.

**Compatibility change:** the provider never falls back to process environment or default-profile credentials. If the scoped secret API or context-thread API is unavailable, or scope resolution fails, it shows a safe diagnostic and skips requests without interrupting Hermes. Update Hermes if those APIs are unavailable. On supported single-profile Hermes, `get_secret` itself can resolve shell environment values natively; this is Hermes behavior, not a plugin fallback.

The separate `mcp_servers.rembric.env` map forwards settings to the bundled MCP bridge; this provider change does not alter bridge configuration.

To change a value after install:

- Edit `~/.hermes/.env` directly (it's a flat dotenv file), then restart Hermes.
- Do not reinstall just to edit credentials: the TUI treats an existing native install as already installed; update it separately.

The plugin **does not** read any plugin-private dotenv file (`~/.rembric/.env`, etc. are silently ignored). Earlier 0.3.x versions read `~/.rembric/.env` as a workaround; that mechanism was removed in 0.4.0 once `requires_env:` proved sufficient.

## Project slug resolution

Rembric scopes everything to a project slug. The provider and bridge use the same cascade — the **first valid match** wins:

1. `<cwd>/.rembric` → `PROJECT_SLUG=<slug>`.
2. `REMBRIC_PROJECT_SLUG` from the active profile's `get_secret` result (the separate bridge reads its explicitly mapped environment).
3. No valid slug → the provider skips lifecycle POSTs with one diagnostic, while the bridge uses path-less `/mcp`.

Every candidate is validated against the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Non-matching values are discarded and the cascade continues. The server URL remains the bare deployment URL; a `/mcp/<slug>` suffix is not a fallback.

## Lifecycle (what the plugin actually does)

The provider implements four lifecycle methods that map onto Rembric's HTTP session endpoints:

- `initialize(session_id, cwd)` → `POST /api/<slug>/sessions` with `{id, cwd, agent: "hermes"}`, then `POST /api/<slug>/sessions/<id>/resume`.
- `on_pre_compress(messages)` → joins messages into a transcript, caps at 20,000 chars, `POST /api/<slug>/sessions/<id>/summary`.
- `on_session_switch(new_id, ...)` → `POST /api/<slug>/sessions/<cached id>/end` when the id actually changed, then the same ensure-and-resume pair for the new id.
- `on_session_end(messages)` → `POST /api/<slug>/sessions/<id>/end`.

The resume runs once per session id per process, always straight after that id's first ensure. It revives a row a previous Hermes process left `ended` (or the stale sweep left `abandoned`) so a session resumed from the CLI keeps attaching memories to its own row instead of writing them with a null `session_id`; on a row that is already active the server treats it as a no-op. A failed ensure suppresses it.

`system_prompt_block()` returns the unified Rembric nudge — the same SAVE/RECALL/SUMMARIZE text the server hands MCP clients via the `initialize.instructions` block. Hermes does not consume that MCP block and exposes no per-turn hook, so this method is its only nudging surface; the text is kept byte-identical to the server's `buildInstructions()` BASE.

`queue_prefetch` warms a per-session recall cache, which `prefetch` returns with lifecycle hints. `sync_turn` sends the transcript summary and turn report on a context-preserving worker. These requests use the initialized profile binding. `on_memory_write` remains a no-op; agent-callable memory tools use the separate MCP bridge.

## Troubleshooting

`[rembric] scoped secrets API unavailable; update Hermes` or `context thread API unavailable; update Hermes` means the host is unsupported: update Hermes and restart the gateway. `profile secrets unavailable` means the active profile could not be resolved; fix the gateway/profile scope rather than exporting default-profile credentials. Missing profile URL/token diagnostics require configuring that profile. Error messages deliberately omit exception text and response bodies to avoid credential leaks.

| Symptom                                                                              | Likely cause                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes memory status` shows `rembric: Missing` after install                        | Verify the native install succeeded and `memory.provider: rembric` is selected; use `hermes memory setup rembric` if necessary, then restart Hermes.                                                                                                  |
| Native install didn't prompt for settings                                            | Hermes already has the required settings. Check the active profile without printing credentials; edit its settings and restart Hermes when necessary.                                                                                                 |
| stderr shows `[rembric] no project slug for session ...; skipping session POST`      | Neither `.rembric` nor `REMBRIC_PROJECT_SLUG` produced a valid slug. Confirm `REMBRIC_PROJECT_SLUG` is in `~/.hermes/.env`. Edit the file and restart Hermes.                                                                                         |
| stderr shows `[rembric] POST failed: HTTP 403`                                       | Token doesn't have `write` permission for the project. Inspect at `/dashboard/tokens` on the server; revoke and reissue scoped to the project with the default `write` permission.                                                                    |
| stderr shows `[rembric] POST failed: HTTP 404`                                       | `REMBRIC_SERVER_URL` is path-scoped (ends in `/mcp/<slug>`). The provider needs the bare server URL — use `REMBRIC_PROJECT_SLUG` for the slug, NOT the URL. Edit `~/.hermes/.env` and remove the `/mcp/<slug>` suffix.                                |
| MCP works (memory.save/search round-trip) but `/dashboard/sessions` never gets a row | The provider isn't loaded, scoped APIs are unavailable, or the active profile lacks credentials. Confirm `memory.provider: rembric` is in `~/.hermes/config.yaml`, then verify the three settings in the active profile without printing credentials. |
| You edited `~/.hermes/.env` and Hermes didn't pick up the new value                  | Hermes reads `.env` at startup, not on every session. Restart Hermes.                                                                                                                                                                                 |

For deeper agent-side debug (`hermes memory status`, plugin-load trace), see Hermes's docs at <https://hermes-agent.nousresearch.com/docs>.

## Updating

Use the TUI installer (`Plugins → hermes → update`, or `sh install.sh --agent=hermes --action=update --yes`). After successful native update it retains the recognized legacy MCP repair and backup behavior; complete current/custom blocks and their pins remain untouched. The bridge/config transport is unchanged.

Manual fallback:

```sh
hermes plugins update rembric
hermes gateway restart
```

The manual CLI does not run Rembric's legacy MCP repair. Use the TUI if that repair is needed.

**Update-check limitation:** Hermes v0.22.5 reports a fresh native subdirectory install as provenance `drift` because its source metadata exists without a local `.git` directory. Explicit native update was verified to succeed with an already-current result; an actual version advance was not tested. The TUI therefore reports Hermes update status as unknown and skips it in update-all, rather than claiming current/outdated from a manifest comparison. Use the explicit update action for source-tracked installs; copied installs need the transition above.

For a temporary rollback after a broken release, see the [emergency plugin rollback](../../../docs/agents.md#emergency-plugin-rollback) runbook.

## Uninstall

Use the TUI installer (`Plugins → hermes → uninstall`). It delegates removal only for a matching native-managed install. An absent target and absent source record are a successful no-op; inconsistent or copied installs are refused.

Manual fallback:

```sh
hermes plugins remove rembric
```

Hermes removes the **entire managed plugin directory**, clears its plugin selection/grants and resets `memory.provider` if it selected Rembric. Back up local data inside that directory first. Unrelated settings, MCP entries/bridge pins, credentials outside the plugin directory and `.rembric` markers remain in place. Native repeated remove returns an error; the TUI handles the already-absent case.
