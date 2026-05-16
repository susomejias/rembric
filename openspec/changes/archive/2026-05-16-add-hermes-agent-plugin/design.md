## Context

Rembric ships two agent-client plugins today:

- `plugin/.claude-plugin/` — Claude Code, shell hooks via `hooks/hooks.json`, MCP via per-plugin `mcp.json`, credentials via `userConfig` (keychain).
- `plugin/.codex-plugin/` — Codex CLI, shell hooks via `hooks/hooks.codex.json`, MCP via per-plugin `mcp.json`, credentials via shell env (`env_vars` forwarded by Codex's restricted subprocess env model).

Both consume `plugin/scripts/_api.sh` and shared bash session-lifecycle scripts (`session-start.sh`, `pre-compact.sh`, `session-stop.sh`) that POST to Rembric's HTTP API (`src/server/api-router.ts`, capability `http-api`). Both consume the shared `plugin/bin/rembric-bridge.mjs` for stdio↔HTTP MCP routing. The "Plugin development discipline" section in `CLAUDE.md` encodes the invariant: _shared logic lives in shared paths; per-client divergence only when the platform forces it._

Hermes Agent breaks the shell-hook assumption of that invariant. Hermes is implemented in Python; its plugin system loads Python modules whose `register(ctx)` function wires components into the agent runtime. The interesting surface for us is `agent/memory_provider.py::MemoryProvider`, an ABC with ten lifecycle methods (`name`, `is_available`, `initialize`, `get_tool_schemas`, `handle_tool_call`, `system_prompt_block`, `prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `shutdown`, plus optional `get_config_schema`, `save_config`, `queue_prefetch`). Memory providers are loaded with `kind: exclusive` — only one memory provider is active at a time per Hermes process, selected via `memory.provider: <name>` in `~/.hermes/config.yaml`.

A reference implementation exists: `rohitg00/agentmemory`'s `integrations/hermes/` directory contains a minimal `plugin.yaml` (~10 lines), a single-file `__init__.py` (~250 lines), and a README documenting the two install modes (MCP-only via `mcp_servers`, deep plugin via manual `cp -r`). The deep plugin implements eight of the lifecycle methods, ignores `get_tool_schemas` for its three-tool surface that overlaps with its MCP server, and resolves config from env + a `~/.agentmemory/.env` preload. agentmemory verified the install-from-monorepo problem first-hand: Hermes's `hermes plugins install owner/repo` does not support subpath syntax (`_resolve_git_url` only accepts a Git URL or `owner/repo` shorthand — verified by reading `NousResearch/hermes-agent/hermes_cli/plugins_cmd.py` at v0.4.x), so they ship `cp -r` as the documented install.

The author uses Hermes day-to-day and wants Rembric available as a memory provider plugin with the same UX caliber Claude Code and Codex get today.

## Goals / Non-Goals

**Goals:**

- Ship a Hermes Agent plugin that gives users the same session-lifecycle features Claude/Codex already enjoy: automatic session row creation, pre-compaction summary capture, and on-end status flip — all backed by Rembric's existing HTTP session endpoints. Memory context injection at session start is delegated to the MCP bridge (via the server's `initialize.instructions` handshake), not the provider, in v1.
- One-command install for end users: a curl-pipe-sh installer hosted in the rembric monorepo at `plugin/.hermes-plugin/install.sh`, fetching only the three plugin files (`plugin.yaml`, `__init__.py`, `README.md`) into `~/.hermes/plugins/rembric/`.
- Single source of truth: the plugin lives in this monorepo at `plugin/.hermes-plugin/`. No companion mirror repo, no submodule.
- Preserve the existing invariants for the other two clients. Bash scripts, hooks, the bridge, and the `_api.sh` helper SHALL NOT be modified. The HTTP API in `src/server/api-router.ts` SHALL NOT be modified.
- Reuse the bridge for tool surface: Hermes users who want the MCP tools register the bridge via `mcp_servers.rembric` in `~/.hermes/config.yaml`. The provider plugin contributes lifecycle only — `get_tool_schemas()` returns `[]` so there is no duplicate tool surface that could drift.
- Robust failure semantics matching the bash scripts: a plugin-side problem (missing slug, server unreachable, malformed input) SHALL log to stderr and degrade gracefully — never abort the Hermes session.
- Slug resolution that works for both author's typical setup (path-scoped MCP URL, no `.rembric`) and the typical mid-experience user (`.rembric` file checked into a project root).

**Non-Goals:**

- Publishing the plugin to npm, PyPI, or any package registry. The curl-installer is the primary path; the file lives in GitHub source.
- Maintaining a `susomejias/rembric-hermes-plugin` mirror repo. Rejected for maintainability — every change would require parallel context across two repos in Claude/Cursor sessions.
- Putting `plugin.yaml` and `__init__.py` at the rembric monorepo root to make `hermes plugins install susomejias/rembric` work. Rejected on root-pollution + monorepo-bloat grounds (Hermes would clone tens of MB into `~/.hermes/plugins/rembric/` for three useful files; the rembric repo root would gain a `plugin.yaml` and a Python `__init__.py` sitting next to `package.json`, confusing IDE indexers).
- Duplicating the full MCP tool surface as native Hermes provider tools. The provider stays lifecycle-only; the bridge handles tool calls.
- Adding session-tracking endpoints, dashboard columns, or DB schema for Hermes-specific data. The existing `/api/<slug>/sessions(*)` HTTP endpoints and the existing `sessions.agent` column (free-form text) cover everything; the provider sends `agent: "hermes"` and the dashboard renders it automatically.
- Exposing Rembric's MCP memory operations (`memory.save`, `memory.search`, `memory.context`, `memory.session_summary`, etc.) over HTTP. This is a separate, larger change with its own auth/scope/serialization concerns. In v1 the provider's memory-touching lifecycle methods (`system_prompt_block`, `prefetch`, `sync_turn`, `on_memory_write`) are intentional no-ops; users get memory operations via the MCP bridge registered alongside the provider.
- Modifying the bash hook scripts or the bridge to accommodate Python. Those are siblings, not consumers of each other.
- Opening an upstream PR to Hermes for monorepo subpath support inside this change. May be a follow-up; not blocking.

## Decisions

### Decision 1: Distribution via curl-installer, single monorepo path

A 15-line shell script lives at `plugin/.hermes-plugin/install.sh`. It downloads three files (`plugin.yaml`, `__init__.py`, `README.md`) into `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/`. The script honours `PLUGIN_SRC` so a developer with a cloned monorepo can run the same script against a local copy:

```sh
# End user:
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh

# Dev (same script, local source):
PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh
```

**Why over alternatives**:

- _`hermes plugins install susomejias/rembric`_ would clone the entire rembric monorepo (~tens of MB once dist/, node_modules, etc. are involved at install time) into `~/.hermes/plugins/rembric/`, and Hermes's loader expects `plugin.yaml` at the clone root — which requires putting it at the rembric repo root. Both costs (bloat + root pollution) are permanent for a working subset of three files.
- _Companion mirror repo_ (`susomejias/rembric-hermes-plugin`) gives a clean `hermes plugins install owner/repo` UX but splits maintenance across two repos — every behavior change requires opening both repos in the same Claude/Cursor session, breaking single-context editing.
- _`cp -r` only_ is what agentmemory does. It requires the user to clone rembric (which most Hermes users won't). The curl-installer is a strict superset: it covers the casual user (one command) and the developer (env override).

When/if Hermes adds subpath syntax upstream (e.g. `owner/repo:subdir`), the README flips in one line to `hermes plugins install susomejias/rembric:plugin/.hermes-plugin`. No code change to the plugin.

### Decision 2: Plugin source lives at `plugin/.hermes-plugin/`, siblings with `.claude-plugin/` and `.codex-plugin/`

Pattern-matches the existing per-client manifest split. The directory contains:

```
plugin/.hermes-plugin/
├── plugin.yaml       Hermes manifest
├── __init__.py       RembricMemoryProvider + register(ctx)
├── install.sh        curl-installer (15 lines)
└── README.md         install + config + slug resolution + troubleshooting
```

No subdirectories needed; the plugin is intentionally three flat files plus install script.

### Decision 3: Implement `MemoryProvider` ABC; provider does session-lifecycle, bridge does tool surface, memory-touching lifecycle methods are no-ops

Rembric's non-MCP HTTP API (`src/server/api-router.ts`) exposes exactly three endpoints today, all session-scoped:

- `POST /api/<slug>/sessions` — create/upsert (body: `{id, cwd, agent, description?}`)
- `POST /api/<slug>/sessions/<id>/summary` — pre-compact summary (body: `{summary}`)
- `POST /api/<slug>/sessions/<id>/end` — end-of-session (empty body)

All memory operations (`memory.save`, `memory.search`, `memory.context`, `memory.session_summary`, …) live exclusively on the MCP surface. There is no HTTP equivalent. Exposing memory operations over HTTP would be a separate, larger change touching auth, scope resolution, schemas, and dashboard, and is out of scope for this proposal.

The provider therefore implements the `MemoryProvider` ABC such that:

- Lifecycle methods that map cleanly to the existing HTTP session endpoints carry real behavior.
- Lifecycle methods that would require memory operations are intentional no-ops in v1. The agent still gets full memory access — through the `rembric-bridge.mjs` registered separately in `mcp_servers.rembric`. Hermes's normal LLM loop will call `memory.context` / `memory.search` / `memory.save` against the MCP bridge directly. The MCP server's `initialize.instructions` handshake (`src/mcp/instructions.ts`) already nudges the agent to do this proactively, so we lose nothing by having the provider stay silent on those moments.

| Method                | v1 Behavior                                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | `"rembric"`                                                                                                                                                                                                                                                                                                                 |
| `is_available`        | `GET ${REMBRIC_SERVER_URL}/healthz` (2s timeout). Returns `False` if URL/token unset or fetch fails.                                                                                                                                                                                                                        |
| `initialize`          | Resolve slug (cascade below). If valid: `POST /api/<slug>/sessions` with `{id: session_id, cwd, agent: "hermes"}`. Skip silently if no slug. Cache resolved slug on the instance for subsequent lifecycle calls.                                                                                                            |
| `get_tool_schemas`    | `[]` — no tools exposed via provider                                                                                                                                                                                                                                                                                        |
| `handle_tool_call`    | Returns `json.dumps({"error":"unknown_tool","hint":"register the rembric MCP bridge in mcp_servers"})` defensively (never invoked because schemas is empty, but kept for safety)                                                                                                                                            |
| `system_prompt_block` | `""` (no-op in v1; agent calls `memory.context` over MCP)                                                                                                                                                                                                                                                                   |
| `prefetch`            | `""` (no-op; agent calls `memory.search` over MCP)                                                                                                                                                                                                                                                                          |
| `queue_prefetch`      | no-op                                                                                                                                                                                                                                                                                                                       |
| `sync_turn`           | no-op (no `memory.capture_passive` HTTP route; agent invokes via MCP when needed)                                                                                                                                                                                                                                           |
| `on_pre_compress`     | If session was tracked (slug + session_id known): the host loop passes `messages`; we join them into a textual transcript (capped at the 20,000-char schema limit, oldest-first truncation) and `POST /api/<slug>/sessions/<session_id>/summary {summary}`. Discard response. Silent skip if session was never initialized. |
| `on_session_end`      | If session was tracked: `POST /api/<slug>/sessions/<session_id>/end` (empty body). Discard response.                                                                                                                                                                                                                        |
| `on_memory_write`     | no-op (Hermes's MEMORY.md mirror is not our concern; saves to Rembric go through MCP `memory.save`)                                                                                                                                                                                                                         |
| `shutdown`            | no-op                                                                                                                                                                                                                                                                                                                       |
| `get_config_schema`   | Returns three entries: `server_url`, `api_token` (secret), `project_slug` (optional, with description note about per-cwd `.rembric` override)                                                                                                                                                                               |
| `save_config`         | Writes `<hermes_home>/rembric.json` with the prompted values. Provider reads it lazily at the next `initialize`.                                                                                                                                                                                                            |

**Net effect for the user**: when both the provider and the MCP bridge are wired (the documented config), they get auto session capture + compaction summary + end marking from the provider, AND full tool access (save/search/get/judge/...) from the bridge. Same UX caliber as Claude/Codex today, delivered via two complementary channels (one Python-native, one stdio-MCP).

**Why no native tools**: the bridge exposes the canonical 25+ tool surface (memory.save/search/get/judge/confirm/compare/context/timeline/session\_\*). Re-exposing a subset (as agentmemory does with 3 native tools) creates two paths for the same operation that can drift in signature and behavior. Users who want tool access wire the bridge alongside the provider; the README leads with the combined config block so they don't miss it.

**Why memory-touching methods stay no-ops in v1**: exposing memory operations over HTTP is a meaningful auth/scope/serialization redesign. Keeping the provider lifecycle-only matches what the HTTP API offers today, ships value immediately (session tracking + compaction summary, which is the headline UX gap), and preserves a clean upgrade path: a future change ("expose memory operations over HTTP") can fill in `system_prompt_block`, `prefetch`, and `sync_turn` without breaking the v1 provider surface.

**Why defensive ABC stub** (the `try: from agent.memory_provider import MemoryProvider` pattern with a local fallback): lets the plugin file be importable for tests and linting without Hermes installed. Same pattern agentmemory uses.

### Decision 4: Slug resolution cascade

The provider needs the project slug to address `POST /api/<slug>/sessions(*)` and `POST /api/<slug>/memory/*`. Sources, evaluated in order:

```
1. REMBRIC_PROJECT_SLUG env var                      (explicit override)
2. <hermes_home>/rembric.json["project_slug"]         (from get_config_schema/save_config)
3. <cwd>/.rembric → PROJECT_SLUG=<slug>              (paridad with bash scripts)
4. urlparse(REMBRIC_SERVER_URL).path → final segment if /mcp/<slug>  (path-scoped users)
5. None → silent skip of all session/memory POSTs    (degraded; provider stays alive)
```

The same slug regex used by the bridge (`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`) is enforced. Resolution is performed once per `initialize` call and cached on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve. If the user `cd`s mid-session, they get a new slug only on next session.

**Why cascade rather than single source**: forces every deployment style to work without ceremony. Author's setup (path-scoped MCP URL, no .rembric file) hits step 4. Repo-pinned users hit step 3 (same as Claude/Codex today). Single-project users hit step 1 or 2.

### Decision 5: `~/.rembric/.env` preload (best-effort)

At module import time, before any other code, the provider attempts to read `~/.rembric/.env` and `${XDG_CONFIG_HOME:-~/.config}/rembric/.env`, parsing dotenv-style `KEY=VALUE` lines and calling `os.environ.setdefault(KEY, VALUE)`. The preload is silent on any failure (file absent, unreadable, malformed). Borrowed verbatim from agentmemory's solution to issue #250: when the Rembric server is launched by systemd with its own EnvironmentFile, those values are visible to the server process but not to the Hermes CLI process; preloading them at plugin import keeps both processes in sync without forcing a shell-rc edit. `os.environ.setdefault` means shell-set values always win — no surprise overrides.

### Decision 6: Invariant reformulation

The current CLAUDE.md section "Plugin development discipline" states:

> Shared plugin logic MUST live in shared paths. `plugin/scripts/`, `plugin/skills/`, and `plugin/bin/` are consumed by every per-client manifest...

This rule was written when all clients ran shell hooks. Hermes (Python lifecycle methods) cannot consume bash. The intent is preserved by reformulating the contract one level up:

> Shared plugin logic lives in **the HTTP API contract** in `src/server/api-router.ts` (capability `http-api`). Per-client adapters (bash for Claude/Codex, Python for Hermes, future client adapters) are siblings — they implement the same set of POSTs against the same endpoints and SHALL stay in lock-step on payload shape and failure semantics.

This stays in CLAUDE.md (it is project-discipline guidance, not a runtime contract). No spec capability change is needed because the rule never lived in a spec.

## Risks / Trade-offs

- **[Risk] User installs the provider but forgets the bridge → no tool access in agent**.
  _Mitigation_: README leads with the two-block config example (mcp_servers + memory.provider) before either alone. The provider's `handle_tool_call` defensive error message explicitly tells the model "register the rembric MCP bridge in mcp_servers" when it gets an unknown-tool call, so even if the user misconfigures, the model can self-diagnose.

- **[Risk] curl-pipe-sh perception. Some users refuse the pattern on security grounds**.
  _Mitigation_: the script is 15 lines, hosted in the source repo on GitHub, and inspectable via `curl URL | less` before piping to `sh`. The README documents the inspect-then-run idiom alongside the one-liner. The script also accepts `PLUGIN_SRC` pointing to a local directory, so anyone uncomfortable with the remote source can clone rembric and run it locally — same script, no companion documentation, no path divergence.

- **[Risk] Hermes adds subpath support upstream and our install path becomes the "old way"**.
  _Mitigation_: when that lands, README flips to `hermes plugins install susomejias/rembric:plugin/.hermes-plugin` (or whatever syntax they pick) in one line, install.sh stays as fallback for stale Hermes versions. Zero plugin code change. We may open an upstream issue tracking the use case as a side action; not part of this change.

- **[Risk] `MemoryProvider` ABC changes upstream (Hermes is pre-1.0)**.
  _Mitigation_: the `try: from agent.memory_provider import MemoryProvider` pattern catches missing imports; we use only documented public methods. The defensive stub ABC carries the same method names so tests run without Hermes. On real upstream signature changes we bump the plugin version and document the supported Hermes range in README. Hermes's `manifest_version` field (currently `1`, validated by `_install_plugin_core`) is the schema-level escape hatch they expose for breaking changes.

- **[Risk] Slug resolution returns the wrong slug for a developer who has multiple Rembric projects in nested directories**.
  _Mitigation_: cascade order (env > stored config > `.rembric` > URL) puts the most-explicit signal first. The `.rembric` check uses `cwd` only (not parent traversal), matching the bash bridge behavior. Users with overlapping projects either set `REMBRIC_PROJECT_SLUG` per-shell or maintain `.rembric` in each project root — same discipline as Claude/Codex today.

- **[Risk] Hermes provider and bridge talk to different scopes (provider via HTTP `/api/<slug>/`, bridge via MCP `/mcp/<slug>`)**.
  _Mitigation_: they MUST converge on the same slug. The provider's cascade is designed so that step 4 (parse from `REMBRIC_SERVER_URL`) catches path-scoped users automatically; for others, `REMBRIC_PROJECT_SLUG` is documented as authoritative for both. Mismatch is a config error the user creates, not a plugin defect; troubleshooting section in README covers it.

- **[Risk] Provider blocks the Hermes loop on a slow Rembric server**.
  _Mitigation_: the three real HTTP calls (`initialize`, `on_pre_compress`, `on_session_end`) all use a 3-second per-request timeout cap so the loop is never hung indefinitely. `is_available` uses a 2-second timeout. The methods that _would_ be high-frequency (`sync_turn`, `queue_prefetch`, `on_memory_write`) are no-ops in v1 and therefore cannot block at all. When/if we later promote them to real HTTP calls, they SHALL use the fire-and-forget thread pattern (`threading.Thread(target=_api, daemon=True).start()`) so the loop never blocks.

- **[Trade-off] No marketplace entry, no version cache in Hermes's plugin registry**.
  Users get updates by re-running the curl-installer. We accept this; it matches agentmemory's UX and the absence of upstream subpath support makes any "proper" install path strictly worse on other axes.

- **[Trade-off] The shared-logic invariant is now formulated as "HTTP API contract" rather than "shared shell scripts"**.
  Tracking adapter drift becomes a code-review concern (every payload change must update both bash and Python). The HTTP API capability spec (`http-api`) is the contract source. Future client adapters inherit the same rule — they implement against the spec, not against each other.
