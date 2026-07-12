# Changelog

All notable changes to the Rembric agent plugins (Claude Code, Codex CLI, Hermes Agent, opencode).

The plugin is versioned independently from the Rembric server. Versions stay in lock-step across all four per-client surfaces (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`, and the `// @rembric-plugin-version` comment in `plugin/.opencode-plugin/plugin.ts`); the version-bump rule in `CLAUDE.md::Plugin development discipline` covers the lot. Plugin releases use git tags of the form `plugin-vX.Y.Z` and are produced via `claude plugin tag --push` run from inside the `plugin/` directory.

## [0.18.0](https://github.com/susomejias/rembric/compare/plugin-v0.17.1...plugin-v0.18.0) (2026-07-12)


### Features

* **plugin:** unify save+summary nudges on one per-turn channel ([5a5cd9b](https://github.com/susomejias/rembric/commit/5a5cd9b6b949a521c5e4a0368da6b141b499746f))


### Bug Fixes

* **plugin:** document merge-commit requirement for release-please ([7be1784](https://github.com/susomejias/rembric/commit/7be178442800ba06bc3c3f60b0d80631be5f6f26))

## [0.17.1](https://github.com/susomejias/rembric/compare/plugin-v0.17.0...plugin-v0.17.1) (2026-07-12)


### Bug Fixes

* **installer:** drop the removed codex plugin_hooks step ([33c5ece](https://github.com/susomejias/rembric/commit/33c5ece10a864fa439e31cd48cc716f8cffb96cd))
* **plugin:** stop referencing user_config in shell-form hook commands ([42590d1](https://github.com/susomejias/rembric/commit/42590d11d31ed0a754506dc20e6e9bf1a8391529))

## [0.17.0](https://github.com/susomejias/rembric/compare/plugin-v0.16.2...plugin-v0.17.0) (2026-07-12)


### Features

* improve recall ranking and cross-client plugin parity ([#228](https://github.com/susomejias/rembric/issues/228)) ([42e9809](https://github.com/susomejias/rembric/commit/42e98093c6ea7c9364dcd3eddbd605379368ffd8))
* **plugin:** proactive save nudges across all four clients ([#232](https://github.com/susomejias/rembric/issues/232)) ([fd17431](https://github.com/susomejias/rembric/commit/fd17431514c61853774a9eb3d38dc8e07a53cd23))

## [0.16.2](https://github.com/susomejias/rembric/compare/plugin-v0.16.1...plugin-v0.16.2) (2026-07-08)


### Bug Fixes

* **plugin:** harden installer bring-up, hook transport, and bridge pinning ([#217](https://github.com/susomejias/rembric/issues/217)) ([77cbc2f](https://github.com/susomejias/rembric/commit/77cbc2fe6a775bfe5988f60a30950c4ea70a378e))
* **plugin:** redact &lt;private&gt; spans in bash and python clients ([#216](https://github.com/susomejias/rembric/issues/216)) ([c83bdcb](https://github.com/susomejias/rembric/commit/c83bdcb168bb3969c2471bf26b1aba1b309aa76b))

## [0.16.1](https://github.com/susomejias/rembric/compare/plugin-v0.16.0...plugin-v0.16.1) (2026-07-07)

### Bug Fixes

- **mcp:** align session summary cap description ([#212](https://github.com/susomejias/rembric/issues/212)) ([0a7b591](https://github.com/susomejias/rembric/commit/0a7b5914cfd14b829948f73ae264d1c9411a0af7))

## [0.16.0](https://github.com/susomejias/rembric/compare/plugin-v0.15.1...plugin-v0.16.0) (2026-06-23)

### ⚠ BREAKING CHANGES

- memory.save rejects calls without a title, and deployments re-embed the whole corpus once on first boot (search stays available via the lexical branch throughout the backfill).

### Features

- required, searchable memory titles ([#196](https://github.com/susomejias/rembric/issues/196)) ([90c57ce](https://github.com/susomejias/rembric/commit/90c57ce7875955f9fab499d4af3000438956f7e8))

## [0.15.1](https://github.com/susomejias/rembric/compare/plugin-v0.15.0...plugin-v0.15.1) (2026-06-18)

### Bug Fixes

- **plugin:** use real codex plugin add/remove verbs in installer ([#174](https://github.com/susomejias/rembric/issues/174)) ([d934fe7](https://github.com/susomejias/rembric/commit/d934fe78cabfa3db7bc0208a8408da2d49f7b6f0))

## [0.15.0](https://github.com/susomejias/rembric/compare/plugin-v0.14.0...plugin-v0.15.0) (2026-06-14)

### Features

- strengthen the memory protocol nudge (proactive save/recall/summarize) across all four clients ([#153](https://github.com/susomejias/rembric/issues/153)) ([c18d4b5](https://github.com/susomejias/rembric/commit/c18d4b58526d9d672e2083809c001750e1c2a52f))

## [0.13.0](https://github.com/susomejias/rembric/compare/plugin-shared-v0.12.1...plugin-shared-v0.13.0) (2026-06-14)

### Features

- **memory:** derived review state (needs_review) axis ([#141](https://github.com/susomejias/rembric/issues/141)) ([f0f4347](https://github.com/susomejias/rembric/commit/f0f4347dc408366f8798ab08be5e24fa3de42df3))

## [0.12.1](https://github.com/susomejias/rembric/compare/plugin-shared-v0.12.0...plugin-shared-v0.12.1) (2026-06-14)

### Bug Fixes

- **ci:** migrate plugin releases to node-workspace (independent claude/codex components) ([#136](https://github.com/susomejias/rembric/issues/136)) ([b53e2af](https://github.com/susomejias/rembric/commit/b53e2af325cb1e241fed70ec77d6daf4bb60ee55))

## [0.12.0](https://github.com/susomejias/rembric/compare/plugin-shared-v0.11.1...plugin-shared-v0.12.0) (2026-06-14)

### Features

- **plugin:** add --yes/-y flag to run Claude/Codex marketplace commands headlessly ([#132](https://github.com/susomejias/rembric/issues/132)) ([1428a16](https://github.com/susomejias/rembric/commit/1428a16b60021a28dbec962ca6699e8ee1be19e1))

### Bug Fixes

- **ci:** collapse plugin release components, drop linked-versions group ([#134](https://github.com/susomejias/rembric/issues/134)) ([0ae9303](https://github.com/susomejias/rembric/commit/0ae93034702fb9eb00981d1912db0d0d2d6f1cbb))

## [0.11.1](https://github.com/susomejias/rembric/compare/plugin-shared-v0.11.0...plugin-shared-v0.11.1) (2026-06-13)

### Bug Fixes

- **plugin:** correct the installer's per-agent update flow ([#127](https://github.com/susomejias/rembric/issues/127)) ([91d7465](https://github.com/susomejias/rembric/commit/91d74653e4416ee139d00ae118ccf898bb0ced16))
- **plugin:** opencode/claude update notes drop install-only wiring ([#128](https://github.com/susomejias/rembric/issues/128)) ([6d45255](https://github.com/susomejias/rembric/commit/6d452551002daa1d4397ac9c5cf885d1f8ca2290))

## [0.11.0](https://github.com/susomejias/rembric/compare/plugin-shared-v0.10.0...plugin-shared-v0.11.0) (2026-06-13)

### Features

- **plugin:** unified TUI installer for server + all clients ([#122](https://github.com/susomejias/rembric/issues/122)) ([3be359a](https://github.com/susomejias/rembric/commit/3be359aec1cc97a1d1623b30db76212a82fb2d59))

## [0.10.0](https://github.com/susomejias/rembric/compare/plugin-shared-v0.9.0...plugin-shared-v0.10.0) (2026-05-22)

### ⚠ BREAKING CHANGES

- **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87))
- public plugin install URLs move from .../main/plugin/.<client>-plugin/install.sh to .../main/apps/plugin/.<client>-plugin/install.sh. Old URLs return 404. Marketplace pointers in .claude-plugin/marketplace.json (source) and .codex-plugin/marketplace.json (source.path) change from "./plugin" to "./apps/plugin". Release-please tags now use component-prefixed format (server-vX.Y.Z, claude-code-vX.Y.Z, etc.); legacy vX.Y.Z tags stay in history but no new ones are minted.

### Features

- **plugin:** wire pre/post-compact hooks + opencode recall paridad ([#88](https://github.com/susomejias/rembric/issues/88)) ([e78b4e4](https://github.com/susomejias/rembric/commit/e78b4e43813b14138ff7c53d20d54ee9ad4d8c9b))
- restructure monorepo to apps/+packages layout ([#62](https://github.com/susomejias/rembric/issues/62)) ([368d4cc](https://github.com/susomejias/rembric/commit/368d4ccaba983a3eb1d445f20b91faab5c05e05a))
- **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87)) ([0af3b8a](https://github.com/susomejias/rembric/commit/0af3b8a36e4125c021fb5e6df811486016b24c73))

### Bug Fixes

- **plugin:** point per-client install URLs at apps/plugin after monorepo restructure ([#75](https://github.com/susomejias/rembric/issues/75)) ([bd26271](https://github.com/susomejias/rembric/commit/bd2627178e65ac46c8488d3e7b9cd3e405b489b2))
- **release-please:** add plugin-shared umbrella so client plugins cascade ([#91](https://github.com/susomejias/rembric/issues/91)) ([21754a6](https://github.com/susomejias/rembric/commit/21754a6fcf94753ed6a2a740556cd18e4fcb95f7))

## [0.8.0] — unreleased

### Added

- **opencode plugin: per-turn session summary flush.** Plugin now POSTs `/api/<slug>/sessions/<id>/summary` (with `final:false`) on every `session.idle` event (debounced 500ms). Dashboard always shows a current transcript without waiting on the agent to call `memory.session_summary`. Mirrors Codex CLI's per-turn `Stop` writer semantics. The session row stays `status='active'` until either the agent's `memory.session_summary({final:true})` or the server's `abandonStale` flips it.
- **opencode plugin: best-effort dispose flush.** Separate `server.instance.disposed` handler issues fire-and-forget `fetch(...)` for every known session. Pre-implementation spike confirmed opencode does NOT await async handlers at dispose time, so this is opportunistic. Documented in the `// dispose-spike-result: fire-and-forget` header.
- **opencode plugin: chat.message and message.updated handlers** re-introduced. They feed the in-memory transcript accumulator (`sessionMessages` Map) that backs the per-turn flush. NO HTTP POSTs from these handlers.
- **opencode install.sh: auto-configures `~/.config/opencode/opencode.json`.** Three branches: absent → create with `{env:REMBRIC_*}` substitution; with-rembric → leave alone; with-other-mcp → print manual-merge snippet. Users only need to `export REMBRIC_SERVER_URL` and `export REMBRIC_API_TOKEN` in their shell rc.

### Changed

- **opencode plugin: handler set grows from 2 to 5.** Spec `Event handler set` requirement modified accordingly.
- **No behaviour change for Claude Code, Codex CLI, or Hermes Agent.** Lock-step version bump only.

### Compatibility

- Operators upgrading from `0.7.1` re-run `curl -fsSL .../install.sh | sh`. Script overwrites the three installed files; existing `mcp.rembric` block in `opencode.json` is left untouched.

## [0.7.1] — unreleased

### Changed

- **opencode `install.sh`: switched to curl-pipe-sh.** Previously required a `git rev-parse`-resolved checkout and ran `cp` from the local source. Now downloads `plugin.ts` + `rembric-bridge.mjs` + `rembric-dotenv.mjs` from `main` via `curl -fsSL`, matching the Hermes installer pattern. End-user install becomes a single `curl … | sh` line with no clone required. Local-dev iteration is preserved via `PLUGIN_SRC` + `BIN_SRC` env vars (cp from a checkout). Docs swept in `README.md`, `docs/agents.md`, `plugin/README.md`, `plugin/.opencode-plugin/README.md`, and the `rembric-plugin-development` skill's `e2e-walkthrough.md`.
- **Hermes + opencode `install.sh`: PAT auth dropped.** With the repository public, the `GH_PAT` / `GH_TOKEN` / `GITHUB_TOKEN` fallback no longer adds value — `curl` against `raw.githubusercontent.com` works unauthenticated. Removed the auth-token logic and the corresponding usage comments in both installers and their READMEs.
- **Dashboard login footer**: added `OPENCODE` to the supported-clients strip; reordered to `CLAUDE CODE · OPENCODE · CODEX CLI · MCP CLIENTS · HERMES` to match the README's new "Supported agents" grid.

### Compatibility

- **Operators with an existing opencode install from `0.7.0`** can either re-run the new `curl | sh` to fetch the updated files (recommended) or do nothing — the deployed plugin/bridge/dotenv files from `0.7.0` are byte-identical to `0.7.1`. The only change is the install path.

## [0.7.0] — unreleased

### Added

- **opencode plugin (`plugin/.opencode-plugin/`).** New script-installed plugin for [opencode](https://opencode.ai). Single TypeScript file (`plugin.ts`) drops into `~/.config/opencode/plugins/rembric.ts` via `install.sh`. Reuses the shared MCP bridge (`plugin/bin/rembric-bridge.mjs`) verbatim — installed to `~/.config/rembric/bin/` so opencode doesn't auto-load it as a plugin. Two event handlers in v1: `event` (dispatching `session.created` / `session.deleted` with sub-agent filtering via `parentID || title.endsWith(" subagent)")` to avoid session inflation per engram issue #116) and `experimental.session.compacting` (pushes a post-compact `memory.session_summary` reminder to `output.context`). Path-scoping via `.rembric` (same file the bridge and other clients read). No system-prompt injection — relies on MCP `initialize.instructions` like Claude Code and Codex. Passive prompt/observation capture and recall-context-on-compact are deferred: their HTTP endpoints do not exist on `src/server/api-router.ts` yet.
- **Plan A / Plan B contract** for opencode cwd handling (see `openspec/changes/add-opencode-plugin/design.md` Decision 2). v0.7.0 ships Plan A: the spawned bridge uses its existing `CLAUDE_PROJECT_DIR > PWD > process.cwd()` resolution. The plugin file declares `// cwd-spike-result: plan-a`. If a follow-up spike shows opencode does not propagate the user's repo cwd, Plan B adds a `shell.env` handler injecting `REMBRIC_PROJECT_DIR` and the bridge gains a highest-precedence step.

### Changed

- **No behaviour change for Claude Code, Codex CLI, or Hermes Agent.** These three plugins receive a manifest version bump only (lock-step discipline) so installer caches refresh in tandem when users update.

### Compatibility

- Operators upgrading to plugin `0.7.0` who do not use opencode see no change. Operators who install the opencode plugin SHOULD pin opencode CLI ≥ the version recorded in `openspec/changes/add-opencode-plugin/tasks.md` task 0.1 once the spike runs.

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
