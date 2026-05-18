## Why

Rembric already ships first-class plugin trees for Claude Code (`plugin/.claude-plugin/`) and Codex CLI (`plugin/.codex-plugin/`), giving those clients automatic session lifecycle (start/end/compact), MCP tool surface via the bundled bridge, and credential keychain integration. Hermes Agent (Nous Research) is a Python-based agent with growing adoption in the open-source community and is the author's day-to-day agent for some workflows. Hermes exposes a native `MemoryProvider` ABC (`agent/memory_provider.py`) with Python lifecycle callbacks that match what our shell-hook plugins do for the other two clients. Without a Hermes plugin, users get only the manual MCP-server path (edit `~/.hermes/config.yaml` by hand, no session tracking, no compaction summaries, no auto context injection); shipping a deep-integration plugin closes that gap and reinforces Rembric's positioning as the cross-agent memory layer.

## What Changes

- **NEW** Plugin tree at `plugin/.hermes-plugin/` containing:
  - `plugin.yaml` — Hermes manifest declaring lifecycle hooks
  - `__init__.py` — `RembricMemoryProvider(MemoryProvider)` + `register(ctx)` entry point
  - `install.sh` — curl-pipe-sh installer that downloads the 3 files into `~/.hermes/plugins/rembric/` (works both from remote raw URL and from a local `PLUGIN_SRC` env override for devs with a cloned monorepo)
  - `README.md` — install + config docs
- **NEW** `RembricMemoryProvider` implementing Hermes's `MemoryProvider` ABC: lifecycle methods (`initialize`, `prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `system_prompt_block`, `shutdown`, `is_available`) talking to Rembric's existing HTTP API endpoints; `get_tool_schemas()` returns `[]` and `handle_tool_call()` returns a JSON error string steering callers to the MCP bridge — no duplication of the tool surface.
- **NEW** Defensive ABC stub pattern (mirroring agentmemory): `try: from agent.memory_provider import MemoryProvider` with a local abstract fallback so the plugin file is importable for tests/linting without Hermes installed.
- **NEW** Project-slug resolution cascade for session-lifecycle POSTs: `REMBRIC_PROJECT_SLUG` env → stored config via `save_config` → `<cwd>/.rembric` PROJECT_SLUG → URL parse if `REMBRIC_SERVER_URL` ends in `/mcp/<slug>` → degraded silent skip.
- **NEW** `~/.rembric/.env` preload (best-effort, `os.environ.setdefault` semantics) so values written by systemd or other process managers reach the Hermes CLI process. Optional, applies only to the Python provider; bash hooks for Claude/Codex are unaffected.
- **DOCS** Update root `README.md` and `docs/agents.md` with a Hermes section; update `plugin/README.md` and `plugin/CHANGELOG.md`.
- **INVARIANT** Reformulate the "shared plugin logic lives in shared paths" rule (CLAUDE.md "Plugin development discipline") so shared logic refers to **the HTTP API contract in `src/server/api-router.ts`**; per-client adapters MAY be written in any language. Bash and Python adapters are siblings, not duplicates. This unblocks the Python provider without weakening the underlying intent.

## Capabilities

### New Capabilities

- `hermes-agent-plugin`: distribution, manifest, lifecycle-method, and project-scope contract for Rembric's Hermes Agent plugin. Parallel in shape to `claude-code-plugin` and `codex-distribution`.

### Modified Capabilities

None. The invariant reformulation lives in CLAUDE.md and is not load-bearing spec material; the change is captured in `design.md` for posterity.

## Impact

- **New files**:
  - `plugin/.hermes-plugin/plugin.yaml`
  - `plugin/.hermes-plugin/__init__.py`
  - `plugin/.hermes-plugin/install.sh`
  - `plugin/.hermes-plugin/README.md`
  - `openspec/specs/hermes-agent-plugin/spec.md` (created on archive)
- **Modified files**:
  - `README.md` (root) — add Hermes to supported-clients section
  - `docs/agents.md` — new "Hermes Agent" section: install one-liner, config block, env vars, slug resolution, troubleshooting
  - `plugin/README.md` — add Hermes section mirroring Claude/Codex
  - `plugin/CHANGELOG.md` — version bump entry
  - `CLAUDE.md` — reformulate "shared plugin logic" invariant (small wording change)
- **Untouched** (intentionally):
  - `plugin/bin/rembric-bridge.mjs` — same bridge serves Hermes in MCP-only mode via `mcp_servers.rembric` in `config.yaml`
  - `plugin/scripts/*` — bash session scripts unchanged; Hermes provider posts to the same HTTP API
  - `plugin/hooks/hooks.json`, `plugin/hooks/hooks.codex.json` — unchanged
  - `src/server/api-router.ts` — Hermes provider consumes existing `/api/<slug>/sessions(*)` endpoints
  - DB schema — no changes
  - Runtime dependencies — no new server-side dependencies
- **Distribution**:
  - Primary install path: `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh`
  - Dev install path (same script, env override): `PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh`
  - Future: when Hermes accepts subpath syntax in `hermes plugins install owner/repo:subdir` upstream, docs flip in one line; no code change.
- **No marketplace entry** required. Hermes's `hermes plugins install` does not support monorepo subpaths in `v0.4.x` (verified in `hermes_cli/plugins_cmd.py::_resolve_git_url`), so the curl-installer is the practical UX path. Companion mirror repo was considered and rejected on maintainability grounds (parallel context required for Claude/Cursor when editing).
