# Rembric plugin for opencode

Memory + session lifecycle for [opencode](https://opencode.ai), backed by a self-hosted Rembric server.

This plugin shares the same HTTP API and MCP bridge as the Claude Code, Codex CLI, and Hermes Agent plugins. It selects the project the same way they do. Its config hook runs the bridge the installer places in `~/.config/rembric/bin/`.

**Scope**: the plugin handles session lifecycle and compaction signals via the `event` dispatcher (`session.created`, `session.deleted`, `session.compacted`, `server.instance.disposed`), accumulates transcripts via `chat.message` and `message.updated`, flushes summaries on `session.idle` (per-turn debounced) and `session.compacted` (compaction milestone), and injects post-compaction guidance via `experimental.session.compacting`. The `chat.message` handler also appends a recall nudge to `output.parts` when the user prompt matches the cross-client recall regex (`remember|recall|acuérdate|qué hicimos|what did we do`), for paridad with the Claude Code / Codex CLI `UserPromptSubmit` hook.

**Session attribution**: one opencode process can run several root sessions at once (`opencode serve`, the web UI) through one shared MCP bridge, so the plugin attributes each call rather than the process. A `tool.execute.before` hook (1.x) or `ctx.tool.hook('execute.before')` (2.x) sets `sessionId` on every Rembric tool that declares it for attribution (`memory.save`, `memory.confirm_batch`, `memory.merge`, `memory.save_prompt`, `memory.capture_passive`, `memory.session_summary`, `memory.session_end`) to the root session that issued the call, resolving a subagent through its parents, and replaces any id the model passed. Other tools, `memory.session_resume` and the `memory.search_prompts` filter are never touched, and a call whose root session the plugin has not registered is left as it is. The plugin publishes no host binding.

## opencode 1.x and 2.x

The module carries two entry points and they serve different opencode majors.

`RembricPlugin` is the **named** export and serves **1.x**, which resolves a plugin by calling each named export as a function with `{ project, client, $, directory, worktree }` and subscribing to the handlers it returns.

The **default** export is an opencode **2.x** plugin: an object `{ id: 'rembric.lifecycle', setup }` that the host drives through its `ctx` domains. 2.x does not read the V1 shape, so without it a 2.x host registers nothing and silently captures no sessions. The V2 entry point is deliberately not a named export — 1.x would otherwise try to run it as a plugin and it would dereference `ctx.location`, which does not exist in a 1.x context.

Both are built on the same shared core and the same project selection, so a project configured for one works for the other. Two behaviours differ by necessity:

- **Nudges ride the system context.** 2.x has no user-message part array to append to, so recall and session-opening nudges are pushed as transient system text. They never enter the persisted turn.
- **The injected block is cached per session.** A 2.x system part lives for one model request, so the block is re-pushed on every request, rebuilt from the server if the cache is empty, and dropped when the session is compacted.
- **Learnings from subagent reports (2.x only).** When a subagent finishes, opencode delivers its report back to the parent session, and the plugin sends it to `POST /api/<slug>/sessions/<id>/learnings`. The server saves the items of the report's `## Key Learnings` section. Nothing reaches the model, and the 1.x plugin has no equivalent.
- **Memories about the file in hand (2.x only).** When the agent's `read`, `edit` or `write` tool touches a file, or a `shell` command names one (`cat`, `sed -n`, `grep`, `rg`, `git show`…), the plugin starts asking `POST /api/<slug>/sessions/<id>/file-recall` for the memories linked to it, without holding the tool up. The next model request of that session waits for the answer and carries it as one transient system part. At most three memories per file, each file once per session, at most ten files per session; only files the repository tracks are sent, as repo-relative paths. Sub-agent sessions are skipped, any failure adds nothing, and the 1.x plugin has no equivalent.

## Install

Use the **TUI installer** — the single recommended path. It runs both manual steps below for you (and handles update/uninstall):

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh
# → Plugins → opencode → install
```

### Manual install

Two steps. Run them in order.

#### 1. Run the install script

One-line install — no checkout required:

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

The script fetches the plugin, its shared modules and the MCP bridge from the rembric `main` branch and drops them in place:

- `plugin.ts` → `~/.config/opencode/plugins/rembric.ts` (with shared-module imports patched to their absolute installed paths before writing).
- `rembric-dotenv.mjs` → `~/.config/rembric/bin/rembric-dotenv.mjs` (single source of truth for slug parsing).
- `rembric-project.mjs` → `~/.config/rembric/bin/rembric-project.mjs` (the shared project resolver).
- `rembric-plugin-core.mjs` → `~/.config/rembric/bin/rembric-plugin-core.mjs`.
- The bridge modules `slug.mjs`, `rembric-host-binding.mjs`, `bridge.mjs` and `cli.mjs` → `~/.config/rembric/bin/`, beside the two modules above that the bridge also imports.

Each module is written under a temporary name and renamed into place. `cli.mjs` is placed after the other bridge modules and `rembric.ts` is written after all of them, so an interrupted run never leaves a new plugin with a half-installed bridge. Existing `opencode.json` files are never edited. Idempotent — re-run any time to upgrade.

Inspect before running with `curl … | less`. Developers iterating locally:

```bash
PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" \
BIN_SRC="$(pwd)/apps/plugin/bin" \
MCP_BRIDGE_SRC="$(pwd)/apps/plugin/mcp-bridge" \
  sh apps/plugin/.opencode-plugin/install.sh
```

#### 2. Export credentials and restart

The plugin's config hook sets `mcp.rembric.command` to `['node', '~/.config/rembric/bin/cli.mjs']` (as an absolute path) in memory, adding the entry when there is none, without changing `opencode.json`. If `cli.mjs` is missing, the hook leaves any existing command as it is and logs one hint to re-run the installer. Export:

- `REMBRIC_SERVER_URL` — your Rembric base URL, e.g. `http://127.0.0.1:8787` (no trailing `/mcp`).
- `REMBRIC_API_TOKEN` — bearer token issued from `/dashboard/tokens` (plaintext shown exactly once).

Restart opencode.

## Per-project path-scoping

The plugin and the bridge subprocess each select the project once, at session start and at spawn time: the nearest `.rembric` up to the git checkout root, then `REMBRIC_PROJECT_SLUG`, then, inside a git repository, the project an admin bound the repository to. A bound repository needs no file. To select a project explicitly, drop a `.rembric` file at the repo root:

```
PROJECT_SLUG=my-app
```

The bridge then connects to `/mcp/my-app`. Every client Rembric ships a plugin for selects the project the same way; the full rules are in [How a client selects its project](../../../docs/agents.md#how-a-client-selects-its-project).

Outside a git repository, without a `.rembric` or `REMBRIC_PROJECT_SLUG`, the plugin skips lifecycle POSTs, the MCP bridge uses path-less `/mcp`, and the agent still works — that connection resolves to the server's default project. Inside a git repository there is no default-project fallback: an unbound repository skips lifecycle POSTs and every memory tool answers `project_unbound`, and a repository that cannot be resolved (an older server, a timeout, several bound projects) keeps the bridge from connecting. In each case one stderr line names the cause and the remedy.

The slug regex is `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Invalid slugs are rejected silently with a stderr diagnostic.

## Verify

1. Open opencode in a bound repository, or one with a valid `.rembric`.
2. Send a message that triggers an MCP-tool call (e.g. "search rembric memory for recent decisions").
3. Open the Rembric dashboard at `/dashboard/sessions`. A new row with `agent='opencode'` should appear.
4. opencode's debug log (path varies by version) should contain one `[rembric] session.created id=…` line per session.

## Update

Use the TUI installer (`Plugins → opencode → update`). Manual fallback — opencode does not cache plugins by version, so re-run the curl-pipe-sh command above; it fetches the latest files from `main` and overwrites the installed files. Restart opencode.

For a temporary rollback after a broken release, see the [emergency plugin rollback](../../../docs/agents.md#emergency-plugin-rollback) runbook.

## Uninstall

Use the TUI installer (`Plugins → opencode → uninstall`). Manual fallback:

```bash
bash plugin/.opencode-plugin/uninstall.sh
```

Removes the plugin, its shared modules and the bridge. The bridge modules (and the two shared modules it imports) stay while Hermes's `config.yaml` still runs `~/.config/rembric/bin/cli.mjs`, and the script names them as kept. It does **not** touch `opencode.json` or legacy launcher files — remove the `mcp.rembric` block manually if you want it gone.

## Troubleshooting

- **Sessions don't appear in the dashboard.** No project was selected. Check stderr in opencode's debug log for the `[rembric] … plugin disabled` line: inside a git repository it names the cause (an unbound repository, an ambiguous one, or a failed resolve) and the remedy; outside git, add a valid `.rembric` to the repo root.
- **Every memory tool fails with `project_unbound`.** The git repository is not bound to a project. Ask an admin to bind it from the dashboard, or add a `.rembric`; either applies from the next session.
- **opencode reports an MCP connection error.** Confirm `~/.config/rembric/bin/cli.mjs` exists; if it does not, the debug log has a `MCP bridge not found` line, and re-running the installer places it. Then confirm `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are exported in the shell that starts opencode. An older `npx -y @rembric/mcp-bridge@<version>` entry keeps working on the version it names until the installer places the bridge, after which the hook replaces it in memory.
- **Session never transitions to `'ended'`.** Expected. opencode has no `SessionEnd` event; closure relies on the agent calling `memory.session_summary` voluntarily, or the server's `abandonStale` flipping inactive rows. opencode is now the only client in this state — Codex CLI does have `SessionEnd` and reaches `ended` on a normal close.
- **Tested with**: opencode CLI ≥ 1.15.5. If you run an older opencode, the event handler API may not match — the plugin will fail to load and opencode will log a TypeScript error.

## Files this plugin owns

```
~/.config/opencode/plugins/rembric.ts        ← session lifecycle + post-compact reminder (JS)
~/.config/rembric/bin/rembric-{dotenv,project,plugin-core}.mjs ← shared modules
~/.config/rembric/bin/{cli,bridge,slug,rembric-host-binding}.mjs ← MCP bridge (kept while Hermes runs it)
~/.config/opencode/opencode.json             ← MCP block (user-edited)
<repo>/.rembric                              ← optional explicit slug (user-created)
```

opencode.json and `.rembric` files are user-owned. The install/uninstall scripts never edit them.
