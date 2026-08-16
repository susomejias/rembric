# Agent integration

Rembric ships first-class plugins for **Claude Code**, **Codex CLI**, **Hermes Agent**, **opencode**, and **Pi**. **ChatGPT** connects as a custom MCP connector over OAuth 2.1 (no plugin) — see [ChatGPT](#chatgpt-custom-mcp-connector-over-oauth).

> **Install with the TUI — the single, recommended path.** [`install.sh`](../install.sh) (canonical URL `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh`) is one brand-styled menu that prepares the server and installs / updates / uninstalls every client plugin, detecting what you have and at which version. Inspect-first: `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh -o rembric-install.sh && less rembric-install.sh && sh rembric-install.sh`. Pin a release with `--ref=<tag>`. The per-client commands in the sections below are what the installer runs under the hood — documented here as the **manual fallback**.

> **Running Rembric itself?** The canonical install is Docker — see [`docs/docker.md`](./docker.md) for the operator guide (topologies, GHCR auth, upgrades, troubleshooting). This page covers the agent side: how each MCP client connects to a running Rembric instance.

## Connection shape

Every MCP client uses the same two values:

```
URL:    http(s)://your-host:8787/mcp[/<project-slug>]
Header: Authorization: Bearer <agent-token>
```

- `/mcp` → the default project. A project is always active; the agent switches with `project.use({slug})`.
- `/mcp/<slug>` → path-scoped. The agent's home project is fixed to that slug and cannot be switched for the life of the connection; every write lands there and no argument names another destination. Reads are the same as anywhere else — the opt-in `across_projects` search below works here too, because the path fixes which project is home, not which projects the token may read. If the slug names no project the handshake still succeeds, but every tool that resolves a scope is refused with `code: project_not_found` plus `suggestedSlugs[]` — it is never silently redirected to the default project. `project.use`/`project.list`/`project.current`/`memory.about` stay available so the connection can be repaired from inside the session.

Mint per-agent tokens from the dashboard at `/dashboard/tokens`. Plaintext shown exactly once.

Every tool call is authorized against the token's scope and the connection's effective (resolved) scope — not just at connection time. A call with insufficient scope fails with `forbidden`; a `memory.judge`/`memory.compare` target outside the effective scope fails with `not_found` (existence never leaks across scopes).

| Token scope         | Can call                                             | Cannot call                                                                          | `across_projects` reaches |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------- |
| `*`                 | Every tool, any scope                                | —                                                                                    | every project             |
| `read:*`            | Every read-classified tool, any scope                | Any write-classified tool (`memory.save`, `memory.judge`, `memory.session_start`, …) | every project             |
| `projects`          | Every tool, scoped to the projects the token names   | Any tool whose effective scope resolves outside that set                             | exactly those projects    |
| `read:projects`     | Read-classified tools, scoped to that same set       | Writes, and reads whose effective scope resolves outside that set                    | exactly those projects    |
| `project:<id>`      | Every tool, scoped to project `<id>` only            | Any tool whose effective scope resolves to another project                           | that one project          |
| `read:project:<id>` | Read-classified tools, scoped to project `<id>` only | Writes, and reads whose effective scope resolves to another project                  | that one project          |

Recommended: the shipped client plugins default to `*` or a matching `project:<id>` token so every tool works as documented. Reserve `read:*` / `read:project:<id>` for read-only integrations (dashboards, analytics) that must never write. Mint a `projects` / `read:projects` token by ticking two or more projects on the create form — see [Tokens that reach several projects](./updates.md#tokens-that-reach-several-projects).

**OAuth 2.1 — no static token.** OAuth-capable clients (Claude Code as a remote MCP server, ChatGPT custom connectors) can connect without minting a token: set `REMBRIC_PUBLIC_URL` (the https issuer; `http://localhost` allowed for local testing) and the server runs the authorization-code + PKCE flow itself. The client points at the same `…/mcp[/<slug>]` URL with **no `Authorization` header**; the first connect opens a consent screen where you sign in with the admin token and approve, after which the client manages the token (refresh included). It is off unless `REMBRIC_PUBLIC_URL` is set, and the static-token path above is unchanged — both kinds of token authenticate `/mcp` identically.

The MCP server emits a short `instructions` block at handshake teaching the proactive-save protocol (when to save, when to call `memory.judge`, when to call `memory.session_summary`). Clients that support `initialize.instructions` — Claude Code, Codex CLI and Pi among them — inject it into the system prompt. Other clients still get the same protocol via each tool's description.

## Searching across projects

One tool crosses the project boundary, and only when asked: `memory.search({across_projects: true})`. It is read-only, opt-in, and absent it behaves exactly as a server that does not implement it — the last column of the table above is the whole authorization rule, evaluated per candidate project, so a widened search never reaches a project the token could not open directly. Archived projects are never in the set: a connection at an archived project's slug is refused at authentication, so a widening that admitted one would serve rows the same token cannot ask for.

No other surface widens. `memory.context`, `memory.get`, `memory.timeline`, `memory.stats`, the automatic recall paths and the HTTP `/api/<slug>/memory/search` endpoint all stay on one project and accept no such argument.

The response says what actually happened rather than what was asked for:

- **`searchedProjects[]`** — the slugs actually read. Present whenever the argument was passed, so a page of home-project rows is distinguishable from "my token only reaches one project".
- **`widened: true`** — present only when more than one project was read. A `project:<id>` token that passes the argument gets its own slug in `searchedProjects` and **no** `widened` flag, because nothing widened; its page is byte-identical to its narrow one.

Two behaviours worth knowing before you turn it on:

- **A widened page can be _smaller_ than the narrow one, and can replace its rows entirely — by two different mechanisms, only one of which is flagged.** Ranking is pure relevance with no home-project preference, and the relevance gate is computed over the widened pool. Where the gate cuts rows the page comes back short and carries `gateShortened: true`; measured on a real two-project corpus, a query returning 6 home rows narrow returned 1 foreign row widened. Where foreign rows simply outrank yours the page comes back **full**, so there is no flag to read — `searchedProjects[]` and each row's own project are the only signal that your rows were outranked rather than absent.
- **It costs 2.2–3.0× a narrow search end to end**, measured through the real search path at 1 000 / 20 000 / 50 000 memories, widening from a project holding most of the corpus. From a small project it reaches 12×, because each authorized project contributes its own full candidate window and a small project's narrow search is very cheap to start with. That is why the tool's own description tells the model to widen only on an explicit ask or a genuinely broad exploration, rather than by habit.

A widened read changes nothing about where writes go: `memory.save` on the same connection still lands in the connection's own project, and `memory.get` still answers `not_found` for a memory in another project — including one a widened search just returned.

## Reading prior context

`memory.context` is the cheap awareness payload an agent reads at session start: recent sessions, memories, prompts, memories relevant to the work at hand (`relevantMemories[]`, ranked against `focus` or a server-derived seed), pending judgments, and memories needing review for the scope. Every text field it returns is bounded to a short snippet (≤350 chars) so the block stays token-light — a session `summary`, a prompt's `content`, and memory/relation snippets are all truncated for display.

Two of its lists ask the agent to act, and they are deliberately different shapes:

- `pendingJudgments[]` — **pairwise** conflicts (source ↔ target) surfaced at save time and aged past the orphan threshold; close each with `memory.judge`. See [docs/relations.md](./relations.md).
- `needsReview[]` — **unary** memories (one memory, no counterpart) that have not been re-affirmed within their type's shelf life. `reviewState` (also carried on every `memory.search` / `memory.get` row) flips to `needs_review` when the affirmation baseline — `max(created_at, last confirmation)` — plus the per-type TTL has elapsed. It is a read-time derivation: nothing is stored, no sweep runs. Resolve each entry with the verb that fits: `memory.confirm` if it's still true (records a confirmation, advancing the baseline), `memory.save` + `topic_key` if it changed, or `memory.judge` if it contradicts another memory. Reading a memory does **not** clear `needs_review` — only affirmation does.

When a session's snippet isn't enough — typically when **resuming work in another client (multi-agent / cross-client handoff)** — call `memory.session_get({ sessionId })` to fetch that session's **full, untruncated** summary on demand. It is read-only and scope-enforced: a session id outside the caller's scope (or soft-deleted) returns `not_found`. Truncation is display-only; the full summary always stays in storage (cap: the server-side `SUMMARY_MAX_CHARS`).

A curated summary write is merged section-wise: the `##` sections it carries replace their stored counterparts, and the ones it omits keep their stored text. `sessionId` is the tool's only property — an unknown one is refused, not ignored. There is no version history behind the merge: what a write does replace is gone, with no restore, so an agent that cannot see the earlier work should read the stored summary here before rewriting a section.

## Validated configs

### ChatGPT (custom MCP connector over OAuth)

ChatGPT connects as a **custom MCP connector** (no plugin, no static token) using the OAuth path above. Validated end-to-end (connect → consent → `memory.*`).

1. **Enable OAuth on the server**: set `REMBRIC_PUBLIC_URL` to the public **https** origin (e.g. `https://memory.example.com`) — the OAuth issuer, **without** the `/mcp` suffix. ChatGPT reaches the server from OpenAI's backend, so a public HTTPS endpoint is required (`http://localhost` works only for local clients, not ChatGPT). Recreate the container so it loads the env.
2. **Add the connector** in ChatGPT → Settings → Apps → Developer mode → new connector:
   - URL: `https://memory.example.com/mcp/<slug>` (the `/<slug>` binds it to that project; omit to land in the default project).
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

The marketplace `source` is `git-subdir` against `./apps/plugin`, so Codex clones the repo subtree on install. Repo access (SSH key / PAT) gates discovery, exactly like the Claude Code plugin.

What the plugin registers for Codex:

- The `rembric` MCP server (declared by `apps/plugin/.codex-plugin/mcp.json`, the Codex-specific sibling of Claude Code's `apps/plugin/.claude-plugin/mcp.json`), invoking the exact-pinned `@rembric/mcp-bridge` package with `npx`.
- A five-hook subset (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`) sharing scripts with the Claude Code plugin via `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh`. All hooks are `command`-type and POST to Rembric's `/api/<slug>/sessions(*)` HTTP API for session lifecycle — the agent never needs to call `memory.session_start`/`memory.session_summary`/`memory.session_end` manually; the hooks handle creation, summary-on-compact (pre + post), and end-on-stop.
- **No slash commands.** `/rembric:remember`, `/rembric:recall`, `/rembric:context` and `/rembric:summary` are Claude-Code-only: Claude Code auto-discovers them from `apps/plugin/commands/*.md`, and `.codex-plugin/plugin.json` declares only `mcpServers` and `hooks`. Under Codex, ask the agent in plain language instead ("remember that…", "what did we do last time") — it has the same MCP tools, and the protocol guidance arrives server-side via the `initialize.instructions` handshake.

After install, drop a `.rembric` file at the root of each project to path-scope the slug automatically:

```bash
echo "PROJECT_SLUG=my-app" > .rembric
```

Without that file the bridge connects path-less (`/mcp`) and operates in the default project.

#### Credentials — REQUIRED: shell env vars

Codex does **not** have a `userConfig` keychain prompt like Claude Code, and Codex does **not** substitute `${user_config.*}` placeholders in plugin manifests (verified against `developers.openai.com/codex/plugins/build` and `/codex/hooks`). The plugin therefore reads its credentials from process env.

You **must** `export` the following in the shell that launches `codex`:

```bash
# in ~/.zshrc (or .bashrc, etc.) — required for the Codex plugin to work
export REMBRIC_SERVER_URL="https://memory.example.com"     # no trailing slash, no /mcp suffix
export REMBRIC_API_TOKEN="$(cat ~/.rembric/codex-token)"   # token minted from /dashboard/tokens
```

Then restart your terminal (or `source ~/.zshrc`) before launching `codex`. The same two envs feed:

- The **MCP bridge** — `apps/plugin/.codex-plugin/mcp.json` declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`, Codex's native mechanism for reading specific env vars from the parent shell at MCP subprocess spawn time (`create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`). Codex does NOT inherit the full parent env automatically — `LocalStdioServerLauncher::launch_server` calls `Command::env_clear()` before applying the curated env, so only the names you list under `env_vars` are forwarded, on top of `DEFAULT_ENV_VARS`. The manifest uses `command: "npx"` with `args: ["-y", "@rembric/mcp-bridge@<exact-version>"]`; `env_vars` forwards the credentials and `PWD`.
- The **lifecycle hooks** — six event types under Codex (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`) across nine handler entries, since `SessionStart`, `UserPromptSubmit` and `Stop` each declare two — so sessions appear in `/dashboard/sessions`, a normal close reaches `ended` via `SessionEnd`, and PreCompact/PostCompact persist a summary across compaction without depending on the model calling `memory.session_summary` post-compact. Codex records trust per handler, so the `/hooks` panel may list more entries than event types.

Symptoms of missing envs:

- `/dashboard/sessions` stays empty even when MCP tool calls work fine.
- `codex --debug` shows `[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN` (bridge) or `[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST /api/...` (hooks).

#### Trust hooks (REQUIRED)

MCP authenticates after install + env exports. Hooks are stable and enabled by default as of `codex-cli 0.142.3+` (the earlier `plugin_hooks` feature flag some versions of this doc used to mention was removed upstream — do not run `codex features enable plugin_hooks`, that flag no longer exists). The only remaining one-time step is trusting the hooks inside Codex; skip it and `/dashboard/sessions` stays empty no matter how many Codex sessions you run.

**Trust the hooks inside Codex.** On startup Codex shows a banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ Open `/hooks` from inside Codex and approve each of Rembric's hook types (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, `SessionEnd`). Leaving `SessionEnd` untrusted is the one that shows up later as sessions never reaching `ended`. The trust persists in `~/.codex/config.toml` under `[hooks.state]`, so this is a one-time-per-hook step — subsequent Codex launches do not re-prompt.

After trusting the hooks, the `/plugins` panel for `rembric` shows the hook counts and the first new Codex session will POST to `/api/<slug>/sessions` against the Rembric server (visible at `/dashboard/sessions`).

##### Symptom → cause table

| Symptom in Codex                                                                                                                | Cause                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard/sessions` stays empty after Codex sessions                                                                          | Hooks have not been approved via `/hooks` yet. MCP can still work while hooks silently no-op.                                                                                                                                                                                            |
| `/plugins` panel shows `Hooks: No plugin hooks`                                                                                 | You're on a `codex-cli` release old enough to still gate hooks behind a feature flag — run `codex features list` to check, and upgrade Codex if so.                                                                                                                                      |
| Startup banner _"N hooks need review"_ keeps appearing across launches                                                          | Not all hooks approved yet. Open `/hooks` and approve any handler whose status is `Untrusted` or `Modified`.                                                                                                                                                                             |
| Hook fires but Codex reports `error: hook returned invalid session start JSON output` (or `... user prompt submit JSON output`) | Codex applies a `looks_like_json` heuristic to hook stdout and rejects anything it reads as malformed JSON. The scripts emit plain text prefixed `rembric:` precisely so the heuristic does not fire, so this points at a nudge whose prefix was dropped, not at a missing JSON wrapper. |

#### Using both Claude Code and Codex on the same machine

The two clients pick up credentials from different places — keep both configured:

| Client          | Where to put credentials                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code** | Install wizard (`/plugin install rembric@rembric`) → keychain. Hooks pick them up automatically via the `CLAUDE_PLUGIN_OPTION_*` env vars Claude Code injects into every hook subprocess. **No shell exports required.** |
| **Codex CLI**   | `export REMBRIC_SERVER_URL=…` and `export REMBRIC_API_TOKEN=…` in your shell rc. Bridge and hooks both read process env. **No wizard exists.**                                                                           |

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

| Piece                          | What it does                                               | Wired via                                                                 |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| **`memory.provider: rembric`** | Auto session create / summary-on-compact / end-on-close    | The Python provider plugin (this section)                                 |
| **`mcp_servers.rembric`**      | Full memory tool surface (save/search/get/context/judge/…) | The published `@rembric/mcp-bridge` package invoked as a stdio MCP server |

Install with one shell command — no `git clone` of rembric required:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

The script drops three files (`plugin.yaml`, `__init__.py`, `README.md`) into `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/`. Inspect before running with `curl … | less`. Developers iterating locally: same script, `PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh`.

> **Why curl-pipe-sh, not `hermes plugins install`?** Hermes's installer (`hermes_cli/plugins_cmd.py::_resolve_git_url` at v0.4.x) accepts only `owner/repo` shorthand or a full Git URL — it does NOT support monorepo subpaths. Cloning the whole rembric repo into `~/.hermes/plugins/rembric/` to extract three files would mean tens of MB of unrelated TS source. The curl-installer ships the right artifacts and nothing else.

Then drop this block into `~/.hermes/config.yaml`, replacing `<plugin-version>` with the exact version printed by the TUI installer (or in `~/.hermes/plugins/rembric/plugin.yaml`):

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

#### Credentials — install-time prompt writes `~/.hermes/.env`

The plugin's `plugin.yaml` declares its three runtime env vars via `requires_env:`. Running `hermes plugins install rembric` prompts the user at install time and writes the answers to `${HERMES_HOME:-~/.hermes}/.env` via Hermes's standard `save_env_value`. Hermes loads that file into `os.environ` for the provider; the explicit `mcp_servers.rembric.env` map forwards the values to the bridge.

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

1. `<cwd>/.rembric` → `PROJECT_SLUG=<slug>`.
2. `REMBRIC_PROJECT_SLUG` from the environment.
3. No valid slug → the provider skips session POSTs with one `[rembric] no project slug …` diagnostic; the bridge uses path-less `/mcp`.

Every candidate is validated against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`; invalid values fall through. Keep `REMBRIC_SERVER_URL` bare — a `/mcp/<slug>` URL suffix is not a fallback.

#### Symptom → cause table

| Symptom in Hermes                                                                         | Cause                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes plugins install rembric` skipped the env prompts                                  | The three `REMBRIC_*` vars are already set in the parent shell. This is by design — Hermes only prompts for vars not in env. To force re-prompts: `unset REMBRIC_SERVER_URL REMBRIC_API_TOKEN REMBRIC_PROJECT_SLUG` then re-run the install.                                          |
| MCP tools work but `/dashboard/sessions` never gets a row with `agent=hermes`             | Either the provider isn't loaded or `~/.hermes/.env` wasn't populated. Verify `memory.provider: rembric` in `~/.hermes/config.yaml` AND `cat ~/.hermes/.env \| grep REMBRIC_` shows all three vars.                                                                                   |
| `hermes memory status` lists `rembric` as available but `/dashboard/sessions` stays empty | Token doesn't have `write` permission for the project (visit `/dashboard/tokens` to inspect — `read` alone returns 403 on session POST, which the provider logs to stderr only). Revoke + reissue from `/dashboard/tokens` scoped to the project with the default `write` permission. |
| stderr shows `[rembric] no project slug for session …; skipping session POST`             | Neither `.rembric` nor `REMBRIC_PROJECT_SLUG` produced a valid slug. Set `REMBRIC_PROJECT_SLUG` in `~/.hermes/.env` (or re-run `hermes plugins install rembric` to be prompted).                                                                                                      |
| stderr shows `[rembric] POST /sessions failed: HTTPError 404`                             | `REMBRIC_SERVER_URL` is path-scoped (e.g. ends in `/mcp/<slug>`). The provider needs the bare server URL — use `REMBRIC_PROJECT_SLUG` for the slug, not the URL.                                                                                                                      |
| MCP tools fail and `hermes memory status` reports `rembric: Missing`                      | The Python provider isn't loaded. Confirm `memory.provider: rembric` in `~/.hermes/config.yaml`, then `hermes plugins enable rembric`. Restart Hermes.                                                                                                                                |
| Provider tracks slug `A`, MCP bridge tracks slug `B`                                      | Both resolve `.rembric` first, then `REMBRIC_PROJECT_SLUG`. Check that the working directory and the environment are the same for both processes; a per-directory `.rembric` overrides the default.                                                                                   |
| You edited `~/.hermes/.env` and Hermes didn't pick up the new value                       | Hermes reads `.env` at startup, not on every session. Restart Hermes.                                                                                                                                                                                                                 |
| `hermes plugins update rembric` reports nothing to update                                 | The provider was not installed via `hermes plugins install`. Re-run the curl-installer — it's idempotent and overwrites the three files.                                                                                                                                              |
| TUI Hermes update reports an MCP migration fallback                                       | The documented legacy block migrates automatically with a `.rembric-mcp-remote.bak` backup. For a custom block, replace it with the exact entry printed by the TUI, then restart the gateway.                                                                                         |

#### Using Hermes alongside Claude Code or Codex on the same machine

Credentials, slug source, and update flow are independent per client. The Rembric server side is identical — same token, same `/api/<slug>/sessions(*)` endpoints. The clients just configure their adapters differently:

| Client           | Credentials from                                          | Slug from                                     | Update                                                                                   |
| ---------------- | --------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Claude Code**  | Wizard → keychain (`${user_config.*}`)                    | `.rembric` file via the bridge                | `/plugin update rembric@rembric`                                                         |
| **Codex CLI**    | Shell env (`export REMBRIC_*`)                            | `.rembric` file via the bridge                | `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric` + restart |
| **Hermes Agent** | `${HERMES_HOME:-~/.hermes}/.env` + explicit MCP `env` map | `.rembric` first, then `REMBRIC_PROJECT_SLUG` | TUI update repairs recognized bridge blocks; custom blocks get an exact fallback         |

Hermes has no keychain equivalent; `${HERMES_HOME:-~/.hermes}/.env` is its canonical persisted env. The provider reads it directly, while the MCP bridge needs the explicit `mcp_servers.rembric.env` map.

### opencode (bundled plugin)

**Primary path: the TUI installer** (`sh install.sh` → Plugins → opencode). The `curl | sh` two-step below is the manual fallback. [opencode](https://opencode.ai) plugins are JS/TS modules loaded from `~/.config/opencode/plugins/`. Rembric ships as a single TypeScript file that handles session lifecycle (`session.created` with sub-agent filtering, `session.deleted`) and pushes a post-compact `memory.session_summary` reminder via `experimental.session.compacting`. MCP memory tools use the published zero-dependency `@rembric/mcp-bridge` package; the plugin's measured config hook upgrades legacy launcher entries in memory.

v1 scope explicitly excludes passive prompt capture (`chat.message`) and tool-output capture (`tool.execute.after`); their HTTP endpoints (`/api/<slug>/prompts/passive`, `/api/<slug>/observations/passive`) do not exist on Rembric's API yet and land in a follow-up change.

#### Install

One-line install — no checkout required:

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

The script fetches `plugin.ts` and the shared modules, then prints an MCP block using the exact pinned bridge package. It never writes `opencode.json`; the plugin config hook upgrades an existing launcher entry in memory. Inspect before running with `curl … | less`. Developers iterating locally: `PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" BIN_SRC="$(pwd)/apps/plugin/bin" MCP_BRIDGE_SRC="$(pwd)/apps/plugin/mcp-bridge" sh apps/plugin/.opencode-plugin/install.sh`.

#### Configure

The plugin adds its MCP entry in memory and leaves `opencode.json` untouched. Export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that starts opencode.

Per-project path-scoping uses `.rembric` in each repo (the same convention as every other client):

```
PROJECT_SLUG=my-app
```

The bridge subprocess reads `.rembric` at spawn time from its project directory and builds `/mcp/<slug>`. Existing configs that still name the old launcher are upgraded in memory by the plugin hook; `opencode.json` remains untouched.

#### Verify

1. Open opencode in a repo with a valid `.rembric`.
2. Trigger any MCP tool (e.g. ask the agent to call `memory.search`).
3. `/dashboard/sessions` shows a new row with `agent='opencode'`.
4. opencode's debug log contains one `[rembric] session.created id=...` line.

#### Troubleshooting

- **No session row appears.** Missing/invalid `.rembric`. Check stderr in opencode's debug log for `[rembric] no project slug` lines.
- **MCP connection error in opencode.** Confirm `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are available in the shell that starts opencode. Legacy launcher entries are upgraded by the plugin config hook.
- **Sub-agent inflation (too many session rows per conversation).** The plugin filters sub-agents via `parentID` or title ending in `subagent)`. If you see inflation, attach the `[rembric] session.created ...` log lines so the heuristic can be tightened.
- **Session never transitions to `'ended'`.** opencode has no `SessionEnd` event; closure relies on the agent calling `memory.session_summary` voluntarily, or the server's `abandonStale` flipping inactive rows. opencode is now the only client in this state — Codex CLI does have `SessionEnd` and reaches `ended` on a normal close.

#### Updating the plugin

opencode does not cache plugins by version. Re-run the curl-pipe-sh command above — the script fetches the latest files from `main` and overwrites the three installed files. Restart opencode.

### Pi (npm package)

**Primary path: the TUI installer** (`sh install.sh` → Plugins → pi). The `pi install` command below is the manual fallback. [Pi](https://pi.dev) is the only client whose Rembric plugin speaks MCP by itself, because Pi ships no MCP client on purpose — verbatim from its own docs (`packages/coding-agent/docs/usage.md:303`): _"It intentionally does not include built-in MCP…"_. So there is no `rembric-bridge.mjs` on this path: the extension opens Streamable HTTP against `${REMBRIC_SERVER_URL}/mcp/<slug>` with `Authorization: Bearer`, calls `tools/list` at startup, registers whatever comes back and proxies each invocation to `tools/call`. It enumerates no tool names, so adding or renaming a server tool needs no extension change.

Session lifecycle, per-turn nudges and `<private>` redaction come from the same shared module the opencode plugin uses (`apps/plugin/bin/rembric-plugin-core.mjs`), registering sessions with `agent='pi'`.

#### Install

```bash
pi install npm:@rembric/pi
```

**Never append a version.** A package spec that names a version is treated as pinned, and pinned extensions are skipped by both `pi update --extensions` and `pi update --all` — the update command reports success and freezes you at that version indefinitely.

#### Configure

Pi injects nothing from its own settings file, so the credentials live in the shell environment (as with Hermes and the in-process side of opencode). There is no settings-file alternative:

```bash
export REMBRIC_SERVER_URL=https://memory.example.com
export REMBRIC_API_TOKEN=pi-token-XXXXXXXX
```

Per-project path-scoping uses `.rembric` in each repo, the same convention as every other client:

```
PROJECT_SLUG=my-app
```

The extension reads it with the shared parser at startup and builds `/mcp/<slug>`, so the server pins the project on connect. A slug naming no project is refused with `project_not_found` rather than falling back to the default project.

The four shared command files (`apps/plugin/commands/{context,recall,remember,summary}.md`) are exposed as Pi prompt templates verbatim — same frontmatter, same `$ARGUMENTS`, no per-client copies.

#### Verify

1. Start Pi in a repo with a valid `.rembric`.
2. Ask the agent to list its tools. The Rembric ones appear with underscores (`memory_save`, not `memory.save`); the proxied call still reaches the server under its canonical dotted name.
3. Save a test memory, then check `/dashboard/memories` for the row.
4. `/dashboard/sessions` shows a new row with `agent='pi'`.

#### Tool output is collapsed by default

A Rembric tool result occupies one line — outcome marker, the canonical dotted tool name, the number of lines in the result and the key that expands it (`✓ memory.context · 170 lines · ctrl+o to expand`). A failed call carries a distinct marker and Pi paints its row on the error background. Expanding restores the complete result text unchanged, error diagnostics and their `code` field included.

The key is whatever `app.tools.expand` is bound to (`ctrl+o` by default, and the line names an override from `~/.pi/agent/keybindings.json`). The toggle is Pi's own and is **global**: one press moves every tool row in the transcript, not just Rembric's. Collapsing applies to every tool regardless of result size — there is no threshold.

#### Session close is awaited, and each exit path is named

Pi awaits its session-shutdown handler with no timeout, so the final summary POST completes instead of racing process exit (measured against Pi 0.84.1: a 10 s awaited fetch completes, and so does a full MCP `tools/call` issued from inside the handler). SIGTERM and SIGHUP both reach it; SIGKILL runs nothing.

Whether that shutdown also **closes** the session depends on the reason Pi reports. `quit`, `new`, `resume` and `fork` are real closes: the extension issues one `POST /api/<slug>/sessions/<id>/end` carrying the accumulated transcript (or an empty body when the session had no turns), so the row reaches `'ended'`. `reload`, a `resume` naming the session file already open, and any reason the extension does not recognise POST `/summary` instead and leave the row `'active'` — `reload` is the same session continuing, so an end issued there would cost `session_id = NULL` on every later `memory.save` until the next `before_agent_start` re-registers and resumes the row — a repairable fault, but one with no reason to incur it. Pi is the only client that picks its shutdown endpoint at runtime.

Ending on replacement is what keeps attribution working. Session resolution is sole-match-or-nothing, so a replaced row left `'active'` alongside its successor makes the successor resolve to nothing, and every `memory.save` that does not name a `sessionId` lands unattributed for the whole staleness window — the silent failure that follows a `/new`, `/resume` or `/fork`.

**Reopening a closed conversation restores it.** On the first `before_agent_start` of the new process the extension re-registers the id and then POSTs `/api/<slug>/sessions/<id>/resume`, which returns an `ended` or `abandoned` row to `'active'` with `ended_at` cleared — so `memory.save` auto-attaches again with no explicit `sessionId`, and `/dashboard/sessions` shows one row rather than two. All five clients do this, by the same rule. An exit that reaches no handler leaves the row `'active'` until `abandonStale` retires it as `abandoned`, the same steady state as opencode.

**Which interrupts reach that handler.** In the interactive TUI, with the prompt focused and on the default `app.clear` binding, **two Ctrl-C presses within 500 ms** run the same awaited shutdown Ctrl-D runs, so the session is closed and nothing beyond the current turn is at risk — measured against Pi 0.84.1 with timed stdin: that arm fired the handler at **5809 ms**, against a no-keys baseline (stdin EOF alone) of **10577 ms**, while two presses 1500 ms apart landed on that EOF at **11839 ms**. A **single** press therefore exits nothing; it clears the prompt and arms the window. Print mode never registers SIGINT — `dist/modes/print-mode.js:32-44` registers `["SIGTERM"]` plus SIGHUP and names `SIGINT` nowhere — which is read from Pi's source, not executed. Ctrl-D stays the simplest exit: one keystroke, no timing window, and it works in both modes.

#### Troubleshooting

- **No Rembric tools registered, one stderr line naming missing configuration.** `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` is unset in the shell that launched Pi. Pi will not read them from its settings file.
- **`project_not_found` on connect.** `.rembric` names a `PROJECT_SLUG` with no matching project. Create it at `/dashboard/projects` or fix the slug — the server refuses rather than widening the scope.
- **No session row appears.** Missing or invalid `.rembric`; check stderr for the `[rembric] no project slug` line.
- **The session row stays `active` and its summary is one turn stale.** The process exited without reaching the shutdown handler: a `SIGKILL`, an OS-level crash, or an interrupted print-mode run. Nothing closes the row from the client side — `abandonStale` retires it as `abandoned` later — and the per-turn flush bounds the summary loss to the final turn.
- **`pi update --all` reports nothing to update.** The extension was installed with a version suffix and is therefore pinned. Re-run `pi install npm:@rembric/pi` with no version.

#### Updating the extension

Re-run `pi install npm:@rembric/pi` — idempotent, and it always resolves the latest published version. Restart Pi afterwards.

## Emergency plugin rollback

<details>
<summary>Temporarily return one client plugin to a previous <code>plugin-vX.Y.Z</code> release</summary>

Use this only to mitigate a broken plugin release while its fix is being prepared. Pick an existing unified `plugin-vX.Y.Z` tag, restart the affected client after the rollback, and return to `main` as soon as the fix is available. A tag is a pin: it does not receive later plugin updates.

### Claude Code

Do **not** remove the marketplace: replacing its source preserves the installed plugin and its enabled state.

```sh
claude plugin marketplace add susomejias/rembric@plugin-vX.Y.Z
claude plugin update rembric@rembric
```

Restart Claude Code. When the fix is available, replace `plugin-vX.Y.Z` with `main` in the first command and run the update again.

### Codex CLI

Codex requires the marketplace source to be replaced. The plugin is inactive between the removal and the final install, so run all three commands together. If either of the last two fails, repeat the same sequence with `main` to recover.

```sh
codex plugin marketplace remove rembric
codex plugin marketplace add susomejias/rembric@plugin-vX.Y.Z
codex plugin add rembric@rembric
```

Restart Codex and review hooks again if prompted. When the fix is available, repeat the sequence with `main` instead of the tag.

### Hermes Agent and opencode

The canonical installer already accepts a release ref. Replace `<agent>` with `hermes` or `opencode`:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/plugin-vX.Y.Z/install.sh \
  | REMBRIC_NONINTERACTIVE=1 sh -s -- --agent=<agent> --action=update --ref=plugin-vX.Y.Z
```

Restart the client. After the fix, run its ordinary TUI-installer update without `--ref` to return to `main`.

### Pi

This is the only intentional exception to Pi's normal unpinned install:

```sh
pi install npm:@rembric/pi@X.Y.Z
```

Restart Pi. A versioned npm spec is pinned and Pi skips it during normal updates. After the fix, unpin it with `pi install npm:@rembric/pi` and restart Pi again.

</details>

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

If your client is stdio-only, use `npx -y @rembric/mcp-bridge@<exact-version>` as a stdio↔HTTP shim, with `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the environment. The package accepts no URL, header, or token arguments.

## Roots-discovered slugs that name no project

When you connect to `/mcp` (path-less) and roots-based discovery surfaces a slug that does not yet exist as a project, writes land in the default project rather than being refused. Nothing is lost and nothing leaks: the destination is an ordinary project, `project.current` names it, and the corpus is append-only, so a misfiled memory is re-saved under the right project.

To file the work under its own project, `project.use({slug, autocreate: true})` first. Never autocreate or autopin silently — minting a project is the user's call.

Earlier releases refused these writes with `project_suggestion_pending`, on the stated reasoning that write tools would otherwise "fall through to global" silently. `memory.save` never did — its `scope` argument defaulted to `project` and a path-less save was refused loudly. The gate was load-bearing for `memory.session_start`, `memory.save_prompt` and `memory.capture_passive`, which without it wrote user-wide rows silently. That scope no longer exists, so neither does the gate.

## Surviving compaction

Long-running agents compact their context. To survive that, two tools fire at specific moments:

- **Before "done" / before compaction**: `memory.session_summary({summary, title?, sessionId?})` persists the state. It does **not** close the session — `memory.session_end` is what ends it, and the summary write deliberately leaves the row `active` so a later turn can rewrite it. Those three are the whole schema — an unknown property is refused — so put the summary in Markdown with exactly these level-2 headings, each on its own line: `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, `## Files`. The `##` sections you send REPLACE their stored counterparts; the ones you omit STAY. Each section you do send is still its full current state, never a fragment of one.
- **After compaction / new session**: `memory.context({sessions, prompts, memories})` restores it.

The proactive-save protocol embedded in `initialize.instructions` already tells agents to do this. If your client ignores the field, paste the equivalent into the client's rules file (`AGENTS.md`, `.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `~/.gemini/system.md`, etc.).

## Private content redaction (`<private>` tags)

All five bundled plugins (Claude Code, Codex CLI, Hermes Agent, opencode, Pi) redact `<private>…</private>` spans to `[REDACTED]` in every transcript-derived upload — session summaries, pre/post-compact snapshots, and derived titles — **before the payload leaves the client**. Matching is case-insensitive and spans newlines; each span closes at the first `</private>`, and an unclosed `<private>` redacts through end-of-text (fail closed). The server never sees the marked content and does not strip the tags itself, so clients connecting without a bundled plugin do not get this redaction.

## Verifying

After registering, ask the agent to list its tools — you should see the `memory.*` and `project.*` families. Save a test memory, then check `/dashboard/memories` for the row.

## Cross-references

- Tool surface and parameters: each tool's MCP description (call `tools/list` from your client).
- Relation graph and `memory.judge` cadence: [docs/relations.md](./relations.md).
- Session deletion / undelete: dashboard `/dashboard/sessions` (toggle `?include_deleted=1` to surface soft-deleted rows).
