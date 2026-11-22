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

Hermes records the repository/subdirectory source and installs under `${HERMES_HOME:-~/.hermes}/plugins/rembric`. `--enable` selects `memory.provider: rembric`, replacing any previous provider selection. This neither places the MCP bridge nor wires `mcp_servers.rembric`: the native install checks out only `.hermes-plugin/`, so the bridge files come from the TUI installer, which places them in `~/.config/rembric/bin/` on every install and update.

Native installation prompts for missing values declared in `plugin.yaml::requires_env` and stores them in `${HERMES_HOME:-~/.hermes}/.env`:

- **`REMBRIC_SERVER_URL`** — base URL of your deployment, **without** the `/mcp` suffix. The bridge appends `/mcp/<slug>` itself when you wire it.
- **`REMBRIC_API_TOKEN`** — Bearer token minted from the Rembric dashboard at `/dashboard/tokens` (plaintext shown exactly once). Marked `secret: true` in the manifest so the prompt hides the input.
- **`REMBRIC_PROJECT_SLUG`** — default project slug for the provider and bridge. Optional: while it is set it wins over every repository binding (see [Project slug resolution](#project-slug-resolution)).

The TUI prints native commands without executing them when Hermes is unavailable or a headless run lacks `--yes`. `--yes` authorizes invocation, not bypassing Hermes's dependency/security/capability consent.

Hermes mutations support only the default unpinned source: `REMBRIC_SRC`, `PLUGIN_SRC`, `REMBRIC_REF` and explicit `--ref` (including `main`, tags and SHAs) are rejected before mutation. Other clients keep their own source/ref behavior.

### Transition from a copied installation

Choose **Plugins → hermes → update**. A native installation uses `hermes plugins update rembric`; a recognized old Rembric copy offers a one-time migration.

Stop Hermes CLI/Desktop/gateway processes and automatic restarts first. The TUI checks for running Hermes processes, then requires typing `MIGRATE`; ordinary `--yes` cannot authorize this transition. Keep Hermes stopped until completion. The adapter verifies a private `rembric-backup-*` directory outside `plugins/`, preserving the whole old plugin, configuration, credentials and source metadata, then installs natively. Unknown local files stay in the backup rather than being copied over the new provider.

On an ordinary failed install, the adapter restores and verifies the old plugin/configuration. If native publication is pending, dependency state changed or activity is detected during recovery, it leaves the backup and `.rembric-migration.lock` for manual recovery instead of risking a destructive rollback. **Keep Hermes stopped and retain the printed backup in that case; do not blindly remove the lock or restore over a native journal.** A process check cannot prevent a later launch, so the maintenance window is an operator responsibility.

Unrecognized, linked, foreign-source, pinned or inconsistent installs remain refused. No `adopt`, `--force`, automatic stop/restart, or alternate copy installer is used.

## Configure

The plugin works in two complementary modes — **wire both** unless you really only want lifecycle without tool access:

| Mode                | What you get                                                 | Where it's configured                                                         |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Memory provider** | Auto session create / summary-on-compact / end-on-close      | `memory.provider: rembric` (this plugin)                                      |
| **MCP server**      | Full memory tool surface (save/search/get/context/judge/...) | `mcp_servers.rembric` (the bridge the TUI places in `~/.config/rembric/bin/`) |

Drop this block into `~/.hermes/config.yaml`. Replace `<HOME>` with your absolute home directory; the TUI installer prints the block with the path already filled in:

```yaml
mcp_servers:
  rembric:
    command: node
    args: ['<HOME>/.config/rembric/bin/cli.mjs']
    env:
      REMBRIC_SERVER_URL: ${REMBRIC_SERVER_URL}
      REMBRIC_API_TOKEN: ${REMBRIC_API_TOKEN}
      REMBRIC_PROJECT_SLUG: ${REMBRIC_PROJECT_SLUG}
    enabled: true

memory:
  provider: rembric
```

Configure these settings for each active Hermes profile. The provider resolves them through Hermes' `agent.secret_scope.get_secret` API; the explicit `env` map configures the separate MCP bridge. Both select the project with the same cascade, described under [Project slug resolution](#project-slug-resolution).

## Environment variables

| Variable               | Required | Description                                                                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `REMBRIC_SERVER_URL`   | ✓        | Base URL of your Rembric deployment, **without** the `/mcp` suffix. Example: `https://memory.example.com`. No trailing slash. |
| `REMBRIC_API_TOKEN`    | ✓        | Bearer token minted from the Rembric dashboard at `/dashboard/tokens`.                                                        |
| `REMBRIC_PROJECT_SLUG` | —        | Optional default project slug. Overridden by a valid `.rembric` file; overrides the repository binding when set.              |
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

Rembric scopes everything to a project slug. The provider and bridge use the same cascade, once per session — the **first valid match** wins:

1. The nearest `.rembric` → `PROJECT_SLUG=<slug>`: `<cwd>`, then each parent up to the git checkout root (outside git, only `<cwd>`).
2. `REMBRIC_PROJECT_SLUG` from the active profile's `get_secret` result (the separate bridge reads its explicitly mapped environment).
3. Inside a git repository: the project an admin bound the repository to, resolved by its root commit through `POST /api/repositories/resolve`.
4. No project → the provider skips lifecycle POSTs with one diagnostic. Outside git the bridge uses path-less `/mcp` (the server's default project). Inside git there is no default-project fallback: an unbound repository runs in unbound mode, where every memory tool answers `project_unbound` and the first memory hint explains how to bind it.

Because the install prompt stores `REMBRIC_PROJECT_SLUG` as a profile default, a set value pre-empts the binding in every repository. Leave it empty if you want bound repositories to pick their own project. The full rules, including how an admin binds a repository, are in [How a client selects its project](../../../docs/agents.md#how-a-client-selects-its-project).

Every candidate is validated against the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Non-matching values are discarded and the cascade continues. The server URL remains the bare deployment URL; a `/mcp/<slug>` suffix is not a fallback.

## Lifecycle (what the plugin actually does)

The provider implements four lifecycle methods that map onto Rembric's HTTP session endpoints:

- `initialize(session_id, cwd)` → `POST /api/<slug>/sessions` with `{id, cwd, agent: "hermes"}`, then `POST /api/<slug>/sessions/<id>/resume`.
- `on_pre_compress(messages)` → joins messages into a transcript, caps at 20,000 chars, `POST /api/<slug>/sessions/<id>/summary`.
- `on_session_switch(new_id, ...)` → `POST /api/<slug>/sessions/<cached id>/end` when the id actually changed, then the same ensure-and-resume pair for the new id.
- `on_session_end(messages)` → `POST /api/<slug>/sessions/<id>/end`.

**Declaring the session to the bridge.** `initialize` and `on_session_switch` also write `~/.cache/rembric/host-sessions/<pid>.json` for the Hermes process, naming the current session. The MCP bridge Hermes spawns reads it and sends the session on every request, so two Hermes processes in one repository each keep their own writes. The file is written only while the process serves exactly one live session. A gateway serving a second session at the same time removes it, because its MCP bridge is shared and could not tell the sessions apart; writes then fall back to the model's explicit `sessionId` or the sole active session. The file comes back once one session is left. `on_session_end` and `shutdown` remove the file only while it still names the session being closed. Sub-agent contexts write nothing and do not count, and a failure never reaches Hermes.

The resume runs once per session id per process, always straight after that id's first ensure. It revives a row a previous Hermes process left `ended` (or the stale sweep left `abandoned`) so a session resumed from the CLI keeps attaching memories to its own row instead of writing them with a null `session_id`; on a row that is already active the server treats it as a no-op. A failed ensure suppresses it.

`system_prompt_block()` returns the unified Rembric nudge — the same SAVE/RECALL/SUMMARIZE text the server hands MCP clients via the `initialize.instructions` block. Hermes does not consume that MCP block and exposes no per-turn hook, so this method is its only nudging surface; the text is kept byte-identical to the server's `buildInstructions()` BASE.

**Memories about the file in hand.** `register(ctx)` also registers two result transforms. When the agent's `read_file`, `write_file` or `patch` tool touches a file, or a `terminal` command names one (`cat`, `sed -n`, `grep`, `rg`, `git show`…), the provider asks `POST /api/<slug>/sessions/<id>/file-recall` for the memories linked to it and appends them to what the model sees: a `rembric_memories` field when the tool result is a JSON object, appended text otherwise. At most three memories per file, each file once per session, at most ten files per session. Only files the repository tracks are sent, as repo-relative paths resolved against the `cwd` `initialize()` received. Sub-agent tool calls are skipped, and any failure leaves the result exactly as the tool produced it.

**Learnings from delegated subagents.** `register(ctx)` also registers a `subagent_stop` hook, available from Hermes v2026.8.3. When a `delegate_task` child finishes, the provider sends its final summary to `POST /api/<slug>/sessions/<parent_session_id>/learnings` from a background worker. The server saves the items of the summary's `## Key Learnings` section into the session that delegated. Nothing reaches the model, and a failure is one diagnostic line.

`queue_prefetch` warms a per-session recall cache, which `prefetch` returns with lifecycle hints. `sync_turn` sends the transcript summary and turn report on a context-preserving worker. These requests use the initialized profile binding. `on_memory_write` remains a no-op; agent-callable memory tools use the separate MCP bridge.

## Troubleshooting

`[rembric] scoped secrets API unavailable; update Hermes` or `context thread API unavailable; update Hermes` means the host is unsupported: update Hermes and restart the gateway. `profile secrets unavailable` means the active profile could not be resolved; fix the gateway/profile scope rather than exporting default-profile credentials. Missing profile URL/token diagnostics require configuring that profile. Error messages deliberately omit exception text and response bodies to avoid credential leaks.

| Symptom                                                                              | Likely cause                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes memory status` shows `rembric: Missing` after install                        | Verify the native install succeeded and `memory.provider: rembric` is selected; use `hermes memory setup rembric` if necessary, then restart Hermes.                                                                                                                                                      |
| Native install didn't prompt for settings                                            | Hermes already has the required settings. Check the active profile without printing credentials; edit its settings and restart Hermes when necessary.                                                                                                                                                     |
| stderr shows `[rembric] no project slug for session ...; skipping session POST`      | No step of the cascade produced a project. Inside a git repository the reason in parentheses says why (for example `repository unbound`): ask an admin to bind the repository, or add a `.rembric`. Outside git, confirm `REMBRIC_PROJECT_SLUG` is in `~/.hermes/.env`, edit the file and restart Hermes. |
| stderr shows `[rembric] POST failed: HTTP 403`                                       | Token doesn't have `write` permission for the project. Inspect at `/dashboard/tokens` on the server; revoke and reissue scoped to the project with the default `write` permission.                                                                                                                        |
| stderr shows `[rembric] POST failed: HTTP 404`                                       | `REMBRIC_SERVER_URL` is path-scoped (ends in `/mcp/<slug>`). The provider needs the bare server URL — use `REMBRIC_PROJECT_SLUG` for the slug, NOT the URL. Edit `~/.hermes/.env` and remove the `/mcp/<slug>` suffix.                                                                                    |
| MCP works (memory.save/search round-trip) but `/dashboard/sessions` never gets a row | The provider isn't loaded, scoped APIs are unavailable, or the active profile lacks credentials. Confirm `memory.provider: rembric` is in `~/.hermes/config.yaml`, then verify the three settings in the active profile without printing credentials.                                                     |
| You edited `~/.hermes/.env` and Hermes didn't pick up the new value                  | Hermes reads `.env` at startup, not on every session. Restart Hermes.                                                                                                                                                                                                                                     |

For deeper agent-side debug (`hermes memory status`, plugin-load trace), see Hermes's docs at <https://hermes-agent.nousresearch.com/docs>.

## Updating

Use the TUI installer (`Plugins → hermes → update`, or `sh install.sh --agent=hermes --action=update --yes`). It places the bridge files in `~/.config/rembric/bin/` first; if any download fails, it stops before touching Hermes or its config. After the native update it migrates the `mcp_servers.rembric` blocks the installer wrote (the `mcp-remote` block, the incomplete pinned block and the complete `npx` block) to the `node` form above, keeping `env` and `enabled` and writing a one-time backup beside `config.yaml`. A block with any other shape, such as a hand-customised one, is left byte-identical and the updater prints the replacement. An `npx` block left in place keeps working on the version it names, because published versions stay on npm.

Manual fallback:

```sh
hermes plugins update rembric
hermes gateway restart
```

The manual CLI neither places the bridge nor migrates the MCP block. Use the TUI for that.

**Update-check limitation:** Hermes v0.22.5 reports a fresh native subdirectory install as provenance `drift` because its source metadata exists without a local `.git` directory. Explicit native update was verified to succeed with an already-current result; an actual version advance was not tested. The TUI therefore reports Hermes update status as unknown and skips it in update-all, rather than claiming current/outdated from a manifest comparison. Use the explicit update action for source-tracked installs; copied installs need the transition above.

For a temporary rollback after a broken release, see the [emergency plugin rollback](../../../docs/agents.md#emergency-plugin-rollback) runbook.

## Uninstall

Use the TUI installer (`Plugins → hermes → uninstall`). It delegates removal only for a matching native-managed install. An absent target and absent source record are a successful no-op; inconsistent or copied installs are refused.

Manual fallback:

```sh
hermes plugins remove rembric
```

Hermes removes the **entire managed plugin directory**, clears its plugin selection/grants and resets `memory.provider` if it selected Rembric. Back up local data inside that directory first. Unrelated settings, MCP entries, credentials outside the plugin directory and `.rembric` markers remain in place. The TUI removes the bridge files from `~/.config/rembric/bin/` only when opencode is not installed and `config.yaml` no longer runs `cli.mjs`, so a preserved `mcp_servers.rembric` block keeps working. Native repeated remove returns an error; the TUI handles the already-absent case.
