# Agent integration

Rembric ships first-class plugins for **Claude Code**, **Codex CLI**, **Hermes Agent**, and **opencode**. **ChatGPT** connects as a custom MCP connector over OAuth 2.1 (no plugin) — see [ChatGPT](#chatgpt-custom-mcp-connector-over-oauth).

> **Install with the TUI — the single, recommended path.** [`install.sh`](../install.sh) (canonical URL `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh`) is one brand-styled menu that prepares the server and installs / updates / uninstalls every client plugin, detecting what you have and at which version. Inspect-first: `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh -o rembric-install.sh && less rembric-install.sh && sh rembric-install.sh`. Pin a release with `--ref=<tag>`. The per-client commands in the sections below are what the installer runs under the hood — documented here as the **manual fallback**.

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

Every tool call is authorized against the token's scope and the connection's effective (resolved) scope — not just at connection time. A call with insufficient scope fails with `forbidden`; a `memory.judge`/`memory.compare` target outside the effective scope fails with `not_found` (existence never leaks across scopes).

| Token scope          | Can call                                               | Cannot call                                                                          |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `*`                   | Every tool, any scope                                  | —                                                                                     |
| `read:*`              | Every read-classified tool, any scope                  | Any write-classified tool (`memory.save`, `memory.judge`, `memory.session_start`, …) |
| `project:<id>`        | Every tool, scoped to project `<id>` only              | Any tool whose effective scope resolves to another project or to global             |
| `read:project:<id>`   | Read-classified tools, scoped to project `<id>` only   | Writes, and reads whose effective scope resolves to another project or to global    |

Recommended: the shipped client plugins default to `*` or a matching `project:<id>` token so every tool works as documented. Reserve `read:*` / `read:project:<id>` for read-only integrations (dashboards, analytics) that must never write.

**OAuth 2.1 — no static token.** OAuth-capable clients (Claude Code as a remote MCP server, ChatGPT custom connectors) can connect without minting a token: set `REMBRIC_PUBLIC_URL` (the https issuer; `http://localhost` allowed for local testing) and the server runs the authorization-code + PKCE flow itself. The client points at the same `…/mcp[/<slug>]` URL with **no `Authorization` header**; the first connect opens a consent screen where you sign in with the admin token and approve, after which the client manages the token (refresh included). It is off unless `REMBRIC_PUBLIC_URL` is set, and the static-token path above is unchanged — both kinds of token authenticate `/mcp` identically.

The MCP server emits a short `instructions` block at handshake teaching the proactive-save protocol (when to save, when to call `memory.judge`, when to call `memory.session_summary`). Clients that support `initialize.instructions` (Claude Code, Codex CLI) inject it into the system prompt. Other clients still get the same protocol via each tool's description.

## Reading prior context

`memory.context` is the cheap awareness payload an agent reads at session start: recent sessions, memories, prompts, pending judgments, and memories needing review for the scope. Every text field it returns is bounded to a short snippet (≤350 chars) so the block stays token-light — a session `summary`, a prompt's `content`, and memory/relation snippets are all truncated for display.

Two of its lists ask the agent to act, and they are deliberately different shapes:

- `pendingJudgments[]` — **pairwise** conflicts (source ↔ target) surfaced at save time and aged past the orphan threshold; close each with `memory.judge`. See [docs/relations.md](./relations.md).
- `needsReview[]` — **unary** memories (one memory, no counterpart) that have not been re-affirmed within their type's shelf life. `reviewState` (also carried on every `memory.search` / `memory.get` row) flips to `needs_review` when the affirmation baseline — `max(created_at, last confirmation)` — plus the per-type TTL has elapsed. It is a read-time derivation: nothing is stored, no sweep runs. Resolve each entry with the verb that fits: `memory.confirm` if it's still true (records a confirmation, advancing the baseline), `memory.save` + `topic_key` if it changed, or `memory.judge` if it contradicts another memory. Reading a memory does **not** clear `needs_review` — only affirmation does.

When a session's snippet isn't enough — typically when **resuming work in another client (multi-agent / cross-client handoff)** — call `memory.session_get({ sessionId })` to fetch that session's **full, untruncated** summary on demand. It is read-only and scope-enforced: a session id outside the caller's scope (or soft-deleted) returns `not_found`. Truncation is display-only; the full summary always stays in storage (cap: the server-side `SUMMARY_MAX_CHARS`).

## Validated configs

### ChatGPT (custom MCP connector over OAuth)

ChatGPT connects as a **custom MCP connector** (no plugin, no static token) using the OAuth path above. Validated end-to-end (connect → consent → `memory.*`).

1. **Enable OAuth on the server**: set `REMBRIC_PUBLIC_URL` to the public **https** origin (e.g. `https://memory.example.com`) — the OAuth issuer, **without** the `/mcp` suffix. ChatGPT reaches the server from OpenAI's backend, so a public HTTPS endpoint is required (`http://localhost` works only for local clients, not ChatGPT). Recreate the container so it loads the env.
2. **Add the connector** in ChatGPT → Settings → Apps → Developer mode → new connector:
   - URL: `https://memory.example.com/mcp/<slug>` (the `/<slug>` binds it to that project; omit for global).
   - Authentication: **OAuth**. Leave the advanced panel alone — the server advertises Dynamic Client Registration, so ChatGPT registers itself automatically (no client id/secret).
3. **Consent**: the browser lands on the Rembric consent screen → sign in with your `REMBRIC_ADMIN_TOKEN` → **Authorize**. ChatGPT manages the token (refresh included) from then on.
4. **Disable ChatGPT's native memory** _(optional but recommended)_: in Settings → Personalization → Memory, turn off **Reference saved memories** (and **Reference chat history**). This stops ChatGPT from falling back to its own store, so it leans on Rembric as the single source of truth — fewer stale or duplicated facts, and the custom instruction below has nothing to compete with. Leave it on if you deliberately want both stores.

Per-project = one connector per `/mcp/<slug>`. Developer mode is a beta ChatGPT feature; on Business/Enterprise an admin can publish the connector workspace-wide.

ChatGPT has no session-lifecycle hooks (those are plugin-only), so drive the flow from the model with a custom instruction. Recommended (Settings → Personalization → Custom instructions), tuned to use Rembric as the long-term memory:

```text
Use Rembric MCP as my canonical long-term memory, above built-in memory.

Non-negotiable first step before every answer: call memory.search with a query
derived from the latest user request, regardless of topic. Do not answer from
built-in memory, current chat context, inference, location/IP, web, or
memory.context before checking memory.search.

Use relevant memory.search results to ground the answer; ignore irrelevant
results. If no relevant memory exists, continue normally and say so only when
the user asked for remembered/personal context.

memory.context is only optional auxiliary background for high-level recap of past
sessions/work; it is not a source of truth and must never replace memory.search.

Save durable facts/preferences/decisions/configs with memory.save; use topic_key
when updating. Resolve candidates with memory.judge. If built-in memory conflicts
with Rembric, Rembric wins. Before closing work topics, call
memory.session_summary.
```

> ChatGPT calls MCP tools when it judges them relevant, not on every turn — occasionally you'll still nudge it ("save that to Rembric"). The tool descriptions already prompt proactive use; the instruction reinforces it.

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

**Primary path: the TUI installer** (`sh install.sh` → Plugins → codex). The marketplace commands below are the manual fallback the installer runs for you — the plugin ships from the same `apps/plugin/` directory as the Claude Code plugin (one source tree, two manifests):

```bash
codex plugin marketplace add https://github.com/susomejias/rembric.git
codex plugin add rembric@rembric
```

The marketplace `source` is `git-subdir` against `./plugin`, so Codex clones the repo subtree on install. Repo access (SSH key / PAT) gates discovery, exactly like the Claude Code plugin.

What the plugin registers for Codex:

- The `rembric` MCP server (declared by `apps/plugin/.codex-plugin/mcp.json`, the Codex-specific sibling of Claude Code's `apps/plugin/.claude-plugin/mcp.json`), invoking the bundled bridge at `plugin_root/bin/rembric-bridge.mjs` (resolved via the manifest's `cwd: "."` + relative args).
- A five-hook subset (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`) sharing scripts with the Claude Code plugin via `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh`. All hooks are `command`-type and POST to Rembric's `/api/<slug>/sessions(*)` HTTP API for session lifecycle — the agent never needs to call `memory.session_start`/`memory.session_summary`/`memory.session_end` manually; the hooks handle creation, summary-on-compact (pre + post), and end-on-stop.

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

- The **MCP bridge** — `apps/plugin/.codex-plugin/mcp.json` declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`, Codex's native mechanism for reading specific env vars from the parent shell at MCP subprocess spawn time (`create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`). Codex does NOT inherit the full parent env automatically — `LocalStdioServerLauncher::launch_server` calls `Command::env_clear()` before applying the curated env, so only the names you list under `env_vars` are forwarded, on top of `DEFAULT_ENV_VARS`. The same manifest also uses `cwd: "."` + `args: ["./bin/rembric-bridge.mjs"]` to anchor the bridge path to the plugin root — `${CLAUDE_PLUGIN_ROOT}` substitution does NOT work in MCP args under Codex (only in hook commands), so future contributors should not "simplify" the path back to the Claude Code form.
- The **lifecycle hooks** (`SessionStart`, `PreCompact`, `PostCompact`, `Stop`) so sessions appear in `/dashboard/sessions` and PreCompact/PostCompact persist a summary across compaction without depending on the model calling `memory.session_summary` post-compact.

Symptoms of missing envs:

- `/dashboard/sessions` stays empty even when MCP tool calls work fine.
- `codex --debug` shows `[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN` (bridge) or `[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST /api/...` (hooks).

#### Trust hooks (REQUIRED)

MCP authenticates after install + env exports. Hooks are stable and enabled by default as of `codex-cli 0.142.3+` (the earlier `plugin_hooks` feature flag some versions of this doc used to mention was removed upstream — do not run `codex features enable plugin_hooks`, that flag no longer exists). The only remaining one-time step is trusting the hooks inside Codex; skip it and `/dashboard/sessions` stays empty no matter how many Codex sessions you run.

**Trust the hooks inside Codex.** On startup Codex shows a banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ Open `/hooks` from inside Codex and approve each of Rembric's hook types (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`). The trust persists in `~/.codex/config.toml` under `[hooks.state]`, so this is a one-time-per-hook step — subsequent Codex launches do not re-prompt.

After trusting the hooks, the `/plugins` panel for `rembric` shows the hook counts and the first new Codex session will POST to `/api/<slug>/sessions` against the Rembric server (visible at `/dashboard/sessions`).

##### Symptom → cause table

| Symptom in Codex                                                                                                                | Cause                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dashboard/sessions` stays empty after Codex sessions                                                                          | Hooks have not been approved via `/hooks` yet. MCP can still work while hooks silently no-op.                                                       |
| `/plugins` panel shows `Hooks: No plugin hooks`                                                                                 | You're on a `codex-cli` release old enough to still gate hooks behind a feature flag — run `codex features list` to check, and upgrade Codex if so.                                                             |
| Startup banner _"N hooks need review"_ keeps appearing across launches                                                          | Not all hooks approved yet. Open `/hooks` and approve any handler whose status is `Untrusted` or `Modified`.                                                                                  |
| Hook fires but Codex reports `error: hook returned invalid session start JSON output` (or `... user prompt submit JSON output`) | Known plugin bug, separate change. Codex requires hook stdout to be JSON `{ hookSpecificOutput: { additionalContext: "..." } }`; plugin scripts currently emit plain text. Tracked for plugin `0.2.3`. |

#### Using both Claude Code and Codex on the same machine

The two clients pick up credentials from different places — keep both configured:

| Client          | Where to put credentials                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Install wizard (`/plugin install rembric@rembric`) → keychain. Hooks pick them up automatically via the `CLAUDE_PLUGIN_OPTION_*` env vars Claude Code injects into every hook subprocess. **No shell exports required.** |
| **Codex CLI**   | `export REMBRIC_SERVER_URL=…` and `export REMBRIC_API_TOKEN=…` in your shell rc. Bridge and hooks both read process env. **No wizard exists.**                      |

If you only use one client, set up just that one. If you use both, you need both — the wizard input does NOT propagate to Codex's process, and the shell exports are NOT consumed by Claude Code's hooks (Claude Code substitutes from the keychain, not from `process.env`). Same Rembric server, same token, two configuration surfaces.

#### Updating the plugin

Codex caches plugins by `version` under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, so the cache invalidates when we bump `apps/plugin/.codex-plugin/plugin.json`. Official commands (`developers.openai.com/codex/plugins`):

```shell
# refresh the marketplace snapshot, then re-install from it (the snapshot
# refresh alone does NOT pull the new version into the local cache)
codex plugin marketplace upgrade rembric
codex plugin add rembric@rembric
```

The Codex CLI has no dedicated per-plugin `update` verb, so re-running `codex plugin add` against the refreshed snapshot is the upgrade mechanism — this is exactly what the TUI installer's Update action runs for you. (`codex plugin marketplace upgrade` with no argument refreshes ALL configured marketplaces.) Restart `codex` after the update so the bridge and hooks re-spawn from the new cache path.

### Hermes Agent (memory provider plugin)

**Primary path: the TUI installer** (`sh install.sh` → Plugins → hermes). The `curl | sh` flow below is the manual fallback. Hermes Agent (Nous Research) loads Rembric as a native Python `MemoryProvider` from `apps/plugin/.hermes-plugin/`. Two pieces compose:

> **Plugin `0.6.0+` required against Rembric `0.13.0+`.** The provider's `is_available()` now sends `Authorization: Bearer ${REMBRIC_API_TOKEN}` to `/healthz` (the server made the endpoint bearer-gated in `0.13.0`). The env var was already required for every other call; this just tightens an existing requirement. Running plugin `0.5.x` against server `0.13+` will silently disable the memory provider — upgrade in lock-step.


| Piece                            | What it does                                                | Wired via                                                                  |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **`memory.provider: rembric`**   | Auto session create / summary-on-compact / end-on-close     | The Python provider plugin (this section)                                  |
| **`mcp_servers.rembric`**        | Full memory tool surface (save/search/get/context/judge/…)  | The shared `bin/rembric-bridge.mjs` invoked as a stdio MCP server          |

Install with one shell command — no `git clone` of rembric required:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

The script drops three files (`plugin.yaml`, `__init__.py`, `README.md`) into `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/`. Inspect before running with `curl … | less`. Developers iterating locally: same script, `PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh`.

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
| **Codex CLI**   | Shell env (`export REMBRIC_*`)                     | `.rembric` file via the bridge                                     | `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric` + restart       |
| **Hermes Agent**| Shell env OR `~/.rembric/.env` preload             | Cascade (env / `rembric.json` / `.rembric` / URL parse)            | Re-run the curl-installer                                                                     |

Both the Hermes MCP bridge entry (`mcp_servers.rembric`) and the Hermes provider read the same shell env, so a single shell rc edit covers them. No keychain (Hermes has no `userConfig` equivalent; `get_config_schema()` is provider-managed storage in `~/.hermes/rembric.json`).

### opencode (bundled plugin)

**Primary path: the TUI installer** (`sh install.sh` → Plugins → opencode). The `curl | sh` two-step below is the manual fallback. [opencode](https://opencode.ai) plugins are JS/TS modules loaded from `~/.config/opencode/plugins/`. Rembric ships as a single TypeScript file that handles session lifecycle (`session.created` with sub-agent filtering, `session.deleted`) and pushes a post-compact `memory.session_summary` reminder via `experimental.session.compacting`. MCP memory tools are served by the same `rembric-bridge.mjs` Claude Code and Codex CLI use — one bridge, four clients.

v1 scope explicitly excludes passive prompt capture (`chat.message`) and tool-output capture (`tool.execute.after`); their HTTP endpoints (`/api/<slug>/prompts/passive`, `/api/<slug>/observations/passive`) do not exist on Rembric's API yet and land in a follow-up change.

#### Install

One-line install — no checkout required:

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

The script fetches `plugin.ts`, `rembric-bridge.mjs`, and the shared `rembric-dotenv.mjs` from `main` and drops them at `~/.config/opencode/plugins/rembric.ts` + `~/.config/rembric/bin/rembric-{bridge,dotenv}.mjs` (the bridge + dotenv lib live outside opencode's plugin dir so opencode doesn't try to load them as plugins; the bridge imports the dotenv lib by sibling-relative path at runtime). It prints the MCP block you paste in the next step. Inspect before running with `curl … | less`. Developers iterating locally: `PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" BIN_SRC="$(pwd)/apps/plugin/bin" sh apps/plugin/.opencode-plugin/install.sh`.

#### Configure

Paste the printed MCP block into `~/.config/opencode/opencode.json` (or per project `./opencode.json`):

```json
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "<HOME>/.config/rembric/bin/rembric-bridge.mjs"],
      "environment": {
        "REMBRIC_SERVER_URL": "https://memory.example.com",
        "REMBRIC_API_TOKEN": "oc-token-XXXXXXXX"
      },
      "enabled": true
    }
  }
}
```

Per-project path-scoping uses `.rembric` in each repo (same convention as Claude / Codex / Hermes):

```
PROJECT_SLUG=my-app
```

The bridge subprocess reads `.rembric` at spawn time from its cwd, builds `/mcp/<slug>`, and the agent is locked to that project automatically.

#### Verify

1. Open opencode in a repo with a valid `.rembric`.
2. Trigger any MCP tool (e.g. ask the agent to call `memory.search`).
3. `/dashboard/sessions` shows a new row with `agent='opencode'`.
4. opencode's debug log contains one `[rembric] session.created id=...` line.

#### Troubleshooting

- **No session row appears.** Missing/invalid `.rembric`. Check stderr in opencode's debug log for `[rembric] no project slug` lines.
- **MCP connection error in opencode.** Verify the bridge is reachable: `REMBRIC_SERVER_URL=... REMBRIC_API_TOKEN=... node ~/.config/rembric/bin/rembric-bridge.mjs`. Should print one diagnostic line and connect via `mcp-remote`.
- **Sub-agent inflation (too many session rows per conversation).** The plugin filters sub-agents via `parentID` or title ending in ` subagent)`. If you see inflation, attach the `[rembric] session.created ...` log lines so the heuristic can be tightened.
- **Session never transitions to `'ended'`.** opencode has no `SessionEnd` event; closure relies on the agent calling `memory.session_summary` voluntarily, or the server's `abandonStale` flipping inactive rows. Same steady state as Codex CLI.

#### Updating the plugin

opencode does not cache plugins by version. Re-run the curl-pipe-sh command above — the script fetches the latest files from `main` and overwrites the three installed files. Restart opencode.

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

Cursor, Windsurf, VS Code Copilot Chat, Gemini CLI, etc. — they all speak Streamable HTTP with the same URL + Bearer shape. Locate their MCP config file in the client's docs and drop in the same block, adjusting field names (`type`, `transport`, `httpUrl`, plain `url`) to match.

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

## Private content redaction (`<private>` tags)

All four bundled plugins (Claude Code, Codex CLI, Hermes Agent, opencode) redact `<private>…</private>` spans to `[REDACTED]` in every transcript-derived upload — session summaries, pre/post-compact snapshots, and derived titles — **before the payload leaves the client**. Matching is case-insensitive and spans newlines; each span closes at the first `</private>`, and an unclosed `<private>` redacts through end-of-text (fail closed). The server never sees the marked content and does not strip the tags itself, so clients connecting without a bundled plugin do not get this redaction.

## Verifying

After registering, ask the agent to list its tools — you should see the `memory.*` and `project.*` families. Save a test memory, then check `/dashboard/memories` for the row.

## Cross-references

- Tool surface and parameters: each tool's MCP description (call `tools/list` from your client).
- Relation graph and `memory.judge` cadence: [docs/relations.md](./relations.md).
- Session deletion / undelete: dashboard `/dashboard/sessions` (toggle `?include_deleted=1` to surface soft-deleted rows).
