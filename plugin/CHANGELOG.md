# Changelog

All notable changes to the Rembric agent plugins (Claude Code, Codex CLI, Hermes Agent).

The plugin is versioned independently from the Rembric server. Versions stay in lock-step across all three per-client manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`); the version-bump rule in `CLAUDE.md::Plugin development discipline` covers the lot. Plugin releases use git tags of the form `plugin-vX.Y.Z` and are produced via `claude plugin tag --push` run from inside the `plugin/` directory.

## [unreleased]

### Changed (docs only — no version bump)

- **Repointed `userConfig` / `requires_env` descriptions to `/dashboard/tokens`.** The companion server change (`remove-cli-and-npm-distribution`) eliminates the operator CLI, including `rembric token create`. The three plugin manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`) now reference the dashboard mint path; `plugin/.codex-plugin/plugin.json` has no `userConfig` field (Codex does not support it). Companion README copy (`plugin/README.md`, `plugin/.hermes-plugin/README.md`) updated to match.
- **No bump of plugin manifest versions** — the bridge MCP surface, hooks, scripts, and lifecycle contract are unchanged. The change is text-only in user-facing wizard descriptions. Per `CLAUDE.md::Plugin development discipline`, bumping the plugin version would invalidate installer caches for a cosmetic-only delta without benefit.

## [0.6.0] — unreleased

### Changed

- **Hermes provider: `is_available()` now sends `Authorization: Bearer ${REMBRIC_API_TOKEN}` on its `GET /healthz` probe.** This matches the server's new `/healthz` auth contract (Rembric `0.13.0`): the endpoint requires a bearer token, runs a `SELECT 1` against SQLite, and returns `200 { ok, version }` on success or `503 { ok:false, code:"db_unavailable" }` if the DB is down. Without the header the server responds `401` and the Hermes provider degrades to `is_available() = False`, silently disabling the memory provider for that session.
- **No script or hook changes for Claude Code / Codex CLI.** Those plugins never called `/healthz` directly — their lifecycle posts go to `/api/<slug>/sessions(*)` and always carried the bearer header. They get the version bump for lock-step manifest discipline, nothing else.

### Compatibility

- **Operators upgrading from `0.5.x` MUST update the Rembric server AND the plugin together.** Running `0.5.x` Hermes against Rembric `0.13+` silently disables the memory provider (`is_available` returns `False` because the unauth probe is rejected). Running `0.6.x` Hermes against Rembric `<0.13` still works — the server tolerates the bearer header on the legacy unauth endpoint.

## [0.5.0] — unreleased

### Fixed

- **Sessions now always end with a non-null `summary`.** Three composing bugs are gone:
  1. `pre-compact.sh` used to POST the hook event metadata blob (`{session_id, transcript_path, hook_event_name, trigger}`) as the summary body. Script deleted; replaced by a `SessionStart matcher:"compact"` hook (`post-compact.sh`) that injects an imperative directing the model to call `memory.session_summary`. SessionStart is one of the three Claude Code events whose stdout enters the model's context (verified against `code.claude.com/docs/en/hooks`).
  2. Claude Code's `Stop` hook fires per agent turn, not per session. Wiring it to `POST /end` transitioned every session to `ended` on turn 1 and silently failed every subsequent call. `Stop` is gone from `hooks.json`; the new `SessionEnd` hook (`session-end.sh`) is the canonical per-session terminator. SessionEnd reads `transcript_path`, formats the JSONL conversation, derives a title from the first assistant message, and POSTs `/end {summary, title, final:false}`.
  3. Short sessions that never compact still get a summary via the `SessionEnd` fallback above. No more "agent forgot to call session_summary → row stays `summary=null` forever".
- **Codex sessions now refresh summary every turn via the `Stop` hook.** Codex has no `SessionEnd` event and no PostCompact equivalent; `Stop` is the only signal. The new `session-stop.sh` POSTs `/summary {transcript, title, final:false}` every turn (session stays `active`) and emits the required `{}` JSON on stdout per the Codex docs ("Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event."). Codex sessions remain `active` until the daily `abandonStale` sweep flips them to `abandoned` — expected steady state.
- **Hermes provider rotates session ids cleanly on context compression.** New `on_session_switch` override closes the OLD session row (`POST /end`) and registers the NEW one (`POST /sessions`). Before this fix, the provider's `self._session_id` went stale post-compression and every subsequent lifecycle POST hit the wrong row.

### Added

- **New `title` column in the dashboard sessions list.** Cascade fallback: `row.title ?? row.description ?? shortId(row.id)`. Title is written at row insert as a placeholder `basename(cwd) · HH:MM UTC` and overwritten by either the model's `memory.session_summary({title})` (final:true, locked against bash fallback) or by the bash hook fallback at SessionEnd / Codex Stop (final:false, derived from first assistant message).
- **`memory.session_summary` accepts an optional `title`** (≤100 chars). When provided, it's persisted with `title_final = true`.

### Changed (BREAKING — server contract)

- **`POST /api/<slug>/sessions/<id>/summary` no longer transitions status.** Body shape extended to `{summary, title?, final?: boolean}`. Writes summary/title only; the row stays `active`. Useful for the Codex per-turn `Stop` writer and for the model wanting to checkpoint without ending.
- **`POST /api/<slug>/sessions/<id>/end` is the sole transition.** Body shape extended to `{summary?, title?, final?: boolean}`. Atomically writes summary/title (subject to precedence) AND transitions to `ended`. Idempotent on already-ended rows (returns the existing row; honours summary/title writes subject to precedence).
- **Write precedence: `final: true` locks a field against subsequent `final: false` writes.** Model writes via `memory.session_summary` always send `final:true`; bash/Python hook fallbacks always send `final:false`. Last-final-wins among final writes; last-write-wins among non-final writes. This is how a high-quality model summary beats a noisy raw-transcript fallback even when both arrive.
- **`memory.session_summary` (MCP) no longer ends the session.** Use `memory.session_end` for the transition. Existing in-tree callers updated; no third-party callers known.

### Changed (plugin layout)

- `plugin/hooks/hooks.json`: removed `Stop` entry; removed `PreCompact` entry; split `SessionStart` into two matcher groups (`startup|resume|clear` → existing `session-start.sh`, new `compact` → new `post-compact.sh`); added `SessionEnd` entry → new `session-end.sh`.
- `plugin/hooks/hooks.codex.json`: removed `PreCompact` entry (Codex has no equivalent); `Stop` now invokes the new Codex-only `session-stop.sh` which POSTs `/summary` and emits required JSON.
- `plugin/scripts/pre-compact.sh`: DELETED.
- `plugin/scripts/session-stop.sh`: REWRITTEN — now Codex-only (Claude Code does not invoke it).
- `plugin/scripts/post-compact.sh`: NEW.
- `plugin/scripts/session-end.sh`: NEW.
- `plugin/scripts/_transcript.sh`: NEW shared helper for parsing transcript JSONL.
- `plugin/scripts/_api.sh`: gains `rembric_transcript_path_from_stdin_json`.
- `plugin/.hermes-plugin/plugin.yaml`: `hooks:` adds `on_session_switch`.
- `plugin/.hermes-plugin/__init__.py`: `on_session_end` posts summary+title; `on_pre_compress` posts with explicit `final:false`; `system_prompt_block` returns a non-empty protocol nudge; new `on_session_switch` override; new `_derive_title_from_messages` helper.

### Versions

- `plugin/.claude-plugin/plugin.json`: `0.4.0` → `0.5.0`
- `plugin/.codex-plugin/plugin.json`: `0.4.0` → `0.5.0`
- `plugin/.hermes-plugin/plugin.yaml`: `0.4.0` → `0.5.0`

## [0.4.0] — unreleased

### Changed (Hermes plugin)

- **Credentials now live exclusively in `${HERMES_HOME:-~/.hermes}/.env`.** `plugin/.hermes-plugin/plugin.yaml` declares `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` (token marked `secret: true`). Running `hermes plugins install rembric` now prompts for the three values and writes them via Hermes's standard `save_env_value` to `~/.hermes/.env`. Hermes loads that file into `os.environ` AND propagates the same env to `mcp_servers.*` subprocesses — the bundled MCP bridge sees the credentials the same way the in-process provider does. Single source of truth, no parallel files. Verified live in the author's Hermes LXC install: removing `~/.rembric/.env` and re-running `hermes plugins install rembric` produces a working setup that the previous `get_config_schema` flow could not.
- **Slug resolution cascade is now four steps (was five).** Step 2 — reading `<hermes_home>/rembric.json` written by `save_config` — is gone because `save_config` no longer exists. New cascade: `REMBRIC_PROJECT_SLUG` env → `<cwd>/.rembric` → trailing `/mcp/<slug>` of `REMBRIC_SERVER_URL` → degraded silent skip. Same coverage for every documented setup, simpler mental model.

### Removed (Hermes plugin)

- **`RembricMemoryProvider.get_config_schema()`** — the wrong abstraction. It only reached the in-process provider; the MCP bridge subprocess was left without env. `requires_env:` covers both consumers via Hermes's standard mechanism. Default no-op (`[]`) inherits from the ABC.
- **`RembricMemoryProvider.save_config()`** — companion to `get_config_schema`. Hermes manages credential storage now; the plugin no longer writes `~/.hermes/rembric.json`.
- **`_preload_rembric_dotenv()` helper + `~/.rembric/.env` / `${XDG_CONFIG_HOME}/rembric/.env` candidate paths.** Workaround for the missing `requires_env:`. With Hermes loading `~/.hermes/.env` before the plugin module imports, the preload is redundant.
- **`_slug_from_stored_config()` cascade step.** Tied to the removed `save_config`.

### Other client manifests

- **Versions bumped to 0.4.0** in `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` per the lock-step rule. No behavior change in those clients.

## [0.3.1] — unreleased

### Documentation

- **Hermes plugin: `~/.rembric/.env` is now the recommended credential path** (was previously listed as Option B alongside shell exports). Verified live in a Hermes LXC install (2026-05-16): Hermes does NOT consistently propagate shell env to the Python provider subprocess, so `export REMBRIC_*` in `~/.zshrc` could leave `initialize()` running with an empty env and silently skipping every session POST. The `.env` preload via `os.environ.setdefault` at module import time is bulletproof regardless of how Hermes is launched (systemd, tmux, plain shell). Documented in `plugin/.hermes-plugin/README.md::Where to put the values` and the matching `docs/agents.md::Credentials` section.
- **New troubleshooting row in both READMEs** for the "MCP works but `/dashboard/sessions` never gets a row" symptom — root cause is almost always the env-propagation issue above, fix is the `.env` file.
- **New troubleshooting row** for `[rembric] POST /sessions failed: HTTPError 404` — root cause is `REMBRIC_SERVER_URL` accidentally path-scoped (ending in `/mcp/<slug>`). Documented why provider needs the bare base URL while the bridge needs the full path-scoped URL, and how to keep them separate.
- **Updated `Where to put the values`** in `plugin/.hermes-plugin/README.md` to lead with the `.env` recommendation instead of presenting it as an alternative.

### No code changes

`__init__.py`, `install.sh`, `plugin.yaml` (other than the version bump), and `plugin/scripts/*` are unchanged. This is a docs-only release; the env-propagation behavior was always present, just under-documented.

## [0.3.0] — unreleased

### Added

- **Hermes Agent plugin** at `plugin/.hermes-plugin/` — a Python `MemoryProvider` implementation that POSTs session lifecycle (`initialize`, `on_pre_compress`, `on_session_end`) to Rembric's existing HTTP API. Tool surface is delegated to the bundled bridge via `mcp_servers.rembric` in `~/.hermes/config.yaml` (no native tools on the provider — `get_tool_schemas() → []`), so the dual-channel setup matches the lifecycle+MCP UX Claude Code and Codex users get.
- **Curl-pipe-sh installer** at `plugin/.hermes-plugin/install.sh`. Honours `PLUGIN_SRC` so the same script covers both casual users (remote fetch from `raw.githubusercontent.com`) and developers with a local rembric clone (`PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh …`). The choice avoids cloning the entire rembric monorepo into `~/.hermes/plugins/rembric/` (Hermes's `hermes plugins install owner/repo` does not support monorepo subpaths in v0.4.x — verified against `hermes_cli/plugins_cmd.py::_resolve_git_url`).
- **`~/.rembric/.env` preload** (Hermes provider) — fills missing env values via `os.environ.setdefault` at plugin import. Resolves the systemd case: when the Rembric server runs under systemd with an `EnvironmentFile`, the server process inherits the values but the user's Hermes CLI shell does not — leaving the provider unable to find `REMBRIC_SERVER_URL` / `REMBRIC_API_TOKEN` unless they're also exported in shell rc. The dotenv preload closes that gap.
- **Project slug resolution cascade** in the Hermes provider: `REMBRIC_PROJECT_SLUG` env → `<hermes_home>/rembric.json` (via `save_config`) → `<cwd>/.rembric` `PROJECT_SLUG` → trailing segment of `REMBRIC_SERVER_URL` if it ends in `/mcp/<slug>` → degraded silent skip.

### Changed

- **Version-bump rule extended to three manifests.** Any client-visible change in `plugin/` now bumps the `version` field in `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, AND `plugin/.hermes-plugin/plugin.yaml` in the same commit. Documented in `CLAUDE.md::Plugin development discipline::Releasing a new plugin version`.
- **`README.md` (root + plugin)** and **`docs/agents.md`** updated to list Hermes Agent alongside Claude Code and Codex CLI under "Supported clients" / "Hooking up …".
- **Shared-logic invariant reformulated** in `CLAUDE.md`: the anchor is now the HTTP API contract in `src/server/api-router.ts`, not "shared shell scripts" — per-client adapters MAY be in any language (bash for Claude/Codex, Python for Hermes are siblings). No runtime behaviour change; the wording catches up to the Python provider's existence.

### Unchanged (intentionally)

- `plugin/bin/rembric-bridge.mjs`, `plugin/scripts/*`, `plugin/hooks/*`, `plugin/.claude-plugin/mcp.json`, `plugin/.codex-plugin/mcp.json` — Hermes consumes the same bridge for tool surface (via `mcp_servers.rembric` in user-side `~/.hermes/config.yaml`) and the same HTTP session endpoints. No bash, hook, or server changes ship with this release.

## [0.2.3] — unreleased

### Fixed

- **Codex SessionStart and UserPromptSubmit hooks no longer fail.** Previously both fired with `error: hook returned invalid session start JSON output` (and the matching UserPromptSubmit variant). Root cause: the `[rembric]` badge prefix in hook stdout triggered Codex's `looks_like_json` heuristic (`codex-rs/hooks/src/engine/output_parser.rs`) — anything starting with `{` or `[` is treated as a JSON attempt, and our plain-text nudges aren't valid JSON. Codex's per-event handler (`codex-rs/hooks/src/events/session_start.rs` and siblings) then raised the misleading "invalid JSON output" error. Switching the badge from `[rembric]` to `rembric:` keeps the visual marker while staying in Codex's plain-text branch — stdout is now injected as `additional_context` into the agent's turn.

### Changed

- **Hook stdout prefix is `rembric:` (was `[rembric]`).** Visible in `claude --debug` and `~/.codex/log/codex-tui.log`. Same content, ASCII-only, no leading `[` so Codex doesn't try to parse it.

### Notes

- Codex users on `0.2.2` who saw `invalid ... JSON output` errors: `codex plugin marketplace upgrade rembric` followed by a Codex restart will pull `0.2.3` and the hooks succeed. Claude Code users: `claude plugin update rembric@rembric`; the nudge text changes prefix but behaviour is unchanged.

## [0.2.2] — unreleased

### Fixed

- **Bridge path-scoping under Codex.** Bridge `projectDir` resolution chain now includes `PWD` between `CLAUDE_PROJECT_DIR` and `process.cwd()` — under Codex, `CLAUDE_PROJECT_DIR` is never set and `process.cwd()` is the plugin cache dir (consequence of the manifest's `cwd: "."`), so the bridge fell back to path-less `/mcp` and ignored `.rembric`. With `PWD` forwarded from the user's shell, path-scoping works again when `codex` is launched from a directory containing a valid `.rembric`.
- **Empty-string env vars no longer trip the resolution chain.** The bridge now uses `||` instead of `??` to skip empty `CLAUDE_PROJECT_DIR=""` (latent bug — previously produced a buggy relative `.rembric` lookup against process cwd).

### Changed

- **Bridge startup diagnostic.** `[rembric-bridge] cwd=<dir> url=<url>` becomes `[rembric-bridge] projectDir=<dir> (from <CLAUDE_PROJECT_DIR|PWD|process.cwd()>) url=<url>` — names the source step that won the precedence chain, useful for debugging path-scoping issues.
- **`plugin/.codex-plugin/mcp.json:env_vars`** gains `"PWD"` so Codex (which `env_clear`s the subprocess) forwards the user's shell `PWD` to the bridge. Claude Code's `plugin/.claude-plugin/mcp.json` is unchanged.

### Notes

- Codex users on `0.2.1` who saw `No .rembric in /Users/.../.codex/plugins/cache/...`: `codex plugin marketplace upgrade rembric` followed by a Codex restart from the project root (where `.rembric` lives) will pick up `0.2.2` and resolve path-scoping correctly.

## [0.2.1] — unreleased

### Fixed

- **Codex bridge: path resolution.** Under Codex the bridge previously failed at module resolution with `Cannot find module '…${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs'`. Codex does not substitute `${CLAUDE_PLUGIN_ROOT}` in MCP server `args` — `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` only resolves the `cwd` field against `plugin_root`; `command` and `args` pass verbatim. The new Codex-specific MCP config uses `cwd: "."` (normalised to the plugin root) + `args: ["./bin/rembric-bridge.mjs"]` so node resolves the bridge path against the spawned cwd.
- **Codex bridge: credential injection.** The shared MCP config used `env: { REMBRIC_*: "${user_config.*}" }` — Claude-Code-specific interpolation. Codex passes `env` map values verbatim AND calls `Command::env_clear()` on the subprocess (`codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server`), so shell env is NOT inherited. The new Codex-specific MCP config uses `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]` — Codex's documented mechanism for forwarding shell env vars to MCP subprocesses (`create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`). The Claude Code plugin path is unchanged.

### Changed

- **MCP config files relocated.** `plugin/mcp.json` moves to `plugin/.claude-plugin/mcp.json`. The new `plugin/.codex-plugin/mcp.json` ships alongside it. Each client's MCP config now lives next to its plugin manifest. Manifests reference them via `mcpServers: "./.claude-plugin/mcp.json"` and `mcpServers: "./.codex-plugin/mcp.json"` respectively (Codex requires `./`-prefixed paths relative to `plugin_root` per `resolve_manifest_path` in `codex-rs/core-plugins/src/manifest.rs`; Claude Code accepts the same form).

### Notes

- Existing Codex users who saw `Cannot find module` errors: `codex plugin marketplace upgrade rembric` followed by re-launching `codex` will pull `0.2.1` and resolve the issue (provided `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are exported in the launching shell).

## [0.2.0] — unreleased

### Changed

- **Sessions now auto-managed via HTTP hooks.** `SessionStart`, `PreCompact`, and `Stop` now POST directly to Rembric's `/api/<slug>/sessions(*)` endpoints. The agent no longer needs to call `memory.session_start`/`memory.session_summary`/`memory.session_end` over MCP — those tools remain available for clients without hook support, but the canonical path is HTTP. `/dashboard/sessions` is now populated automatically.
- **PreCompact hook reworked.** Was `type: mcp_tool` calling `memory.session_summary({auto:true})` (the `auto:true` argument was speced but never implemented, so the hook silently failed). Now a `command` script that POSTs the compact transcript as the literal summary.
- **PostCompact hook removed.** Its prior job (nudge to call `memory.context`) is folded into `SessionStart`, which Claude Code already fires on the `compact` matcher.
- **Stop hook added.** Async POST to `/api/<slug>/sessions/<id>/end` so sessions close cleanly when the agent stops.
- New shared helper `plugin/scripts/_api.sh`; new shared scripts `session-start.sh` (engordado from the prior nudge-only version), `pre-compact.sh`, `session-stop.sh`. Codex and Claude Code use the same scripts via `${CLAUDE_PLUGIN_ROOT}`.

## [0.1.0] — unreleased

### Added

- Initial plugin manifest with userConfig for `server_url` and `api_token` (sensitive).
- MCP server declaration pointing at `${user_config.server_url}/mcp` with bearer auth.
- Single skill `rembric-memory` documenting the proactive-save protocol, recall triggers, and the project-resolution algorithm for the first turn of a session.
- Four slash commands under `/rembric:*`: `remember`, `recall`, `context`, `summary`.
- Four lifecycle hooks:
  - `SessionStart`, `UserPromptSubmit` (matcher), `PostCompact` as prompt-nudges via `command` scripts.
  - `PreCompact` as `mcp_tool` invocation of `memory.session_summary` (side effect).
- Slug resolution algorithm: manifest files first (package.json, Cargo.toml, pyproject.toml, go.mod, composer.json, deno.json), git as an optional signal when present, basename as fallback.
- Always-on token budget ≤75 tokens; on-invoke cost ≤500 tokens for the skill body and ~20 tokens per hook fire.
