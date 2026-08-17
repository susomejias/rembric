# hermes-agent-plugin Specification

## Purpose

TBD - created by archiving change add-hermes-agent-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, and `apps/plugin/.opencode-plugin/`. The directory SHALL contain exactly five files at the top level: `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, `README.md`. A nested `apps/plugin/.hermes-plugin/tests/` directory MAY exist for Python unittest sources and SHALL NOT ship to end users (the `install.sh` whitelist of three shipped files — `plugin.yaml`, `__init__.py`, `README.md` — is what guarantees this; nothing else under `apps/plugin/.hermes-plugin/` is copied). `uninstall.sh` is a local-execution maintenance script and, like `install.sh`, is NOT itself copied into the user's plugin directory.

#### Scenario: Plugin tree contains the five top-level files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.hermes-plugin/` lists `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, `README.md`, and the `tests/` directory
- **AND** the only nested directory permitted under `apps/plugin/.hermes-plugin/` is `tests/`, and its contents SHALL NOT be referenced by `install.sh` or `uninstall.sh`

### Requirement: Plugin manifest declares lifecycle hooks

`apps/plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (managed by the unified `plugin` release-please component via its `extra-files` updater — in lock-step with the other clients; all clients share the one `plugin` version), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued from the Rembric dashboard at /dashboard/tokens."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt: `hermes plugins install` asks the user for the three values, writes them to `${HERMES_HOME:-~/.hermes}/.env` via `save_env_value`, and exports them into the running process's `os.environ`. On subsequent Hermes launches the same `.env` is loaded before plugins import. Subprocesses Hermes spawns from `mcp_servers.*` (including the bundled MCP bridge) inherit the same env.

The `hooks` array SHALL include `on_session_switch` because the provider now overrides that method to rotate session ids on compression. Without listing it, Hermes does NOT call the override (the `hooks` array gates lifecycle method invocation).

#### Scenario: Manifest declares hooks and requires_env

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress, on_session_switch]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for any of those not already set in the parent shell env
- **AND** answered values land in `${HERMES_HOME:-~/.hermes}/.env` and become available to the plugin module at import time and to all `mcp_servers.*` subprocesses Hermes spawns

#### Scenario: Version is managed by the unified plugin release-please component

- **WHEN** a commit modifies any file under `apps/plugin/`
- **THEN** the unified `plugin` component SHALL stage a version bump for `apps/plugin/.hermes-plugin/plugin.yaml` (alongside every other client carrier)
- **AND** every client SHALL share the one `plugin` version (independent only of `server`)
- **AND** a `plugin-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

### Requirement: Provider class implements the MemoryProvider ABC

`apps/plugin/.hermes-plugin/__init__.py` SHALL define a class `RembricMemoryProvider` extending `agent.memory_provider.MemoryProvider`. The file SHALL guard the import with `try: from agent.memory_provider import MemoryProvider / except ImportError:` falling back to a local stub ABC defining the same method names, so the file is importable for tests and linting without Hermes installed.

The file SHALL expose a module-level `register(ctx)` function that calls `ctx.register_memory_provider(RembricMemoryProvider())`. No other registrations.

#### Scenario: Plugin loads under Hermes

- **WHEN** Hermes loads the plugin from `~/.hermes/plugins/rembric/`
- **THEN** `register(ctx)` runs and registers the provider via `ctx.register_memory_provider`
- **AND** no other registration (tools, hooks, skills, commands, CLI subcommands) occurs

#### Scenario: Plugin file is importable without Hermes

- **WHEN** the file is imported in a Python environment that lacks the `agent.memory_provider` module
- **THEN** the `try/except ImportError` branch defines a local stub ABC and the import succeeds
- **AND** the file's classes and helper functions can be unit-tested

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` performs `GET ${REMBRIC_SERVER_URL}/healthz` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and a 2-second timeout, returning `True` only on HTTP 200. It SHALL return `False` if `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are unset, or if the request fails for any reason (including HTTP 401 when the token is invalid and HTTP 503 when the server's database is unavailable).
- `initialize(session_id, **kwargs)` SHALL:
  - Resolve the project slug via the cascade defined in "Slug resolution cascade order".
  - Read `kwargs.get("agent_context", "primary")` and cache `self._suppressed = agent_context in {"subagent", "cron", "flush"}` on the provider instance for the lifetime of the session. When suppressed, skip the session-creation POST below (same silent-skip pattern already used when no slug resolves) — the provider SHALL still register and cache the resolved slug/cwd, and `self._suppressed` SHALL gate every subsequent lifecycle call's HTTP work for this session (`sync_turn`, `on_pre_compress`, `on_session_end`, `on_session_switch`), not just this initial POST. When the kwarg is absent or `"primary"`, behavior is unchanged from before this requirement's revision.
  - When a valid slug is resolved AND the context is primary (or unspecified), `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, and body `{"id": session_id, "cwd": kwargs.get("cwd", os.getcwd()), "agent": "hermes"}`. Timeout 3 seconds. Discard response body. The server writes the placeholder title.
  - When no slug is resolvable, skip the POST and log a single-line stderr diagnostic of the form `[rembric] no project slug for session <session_id>; skipping session POST`. The provider SHALL still register; subsequent lifecycle calls SHALL silently skip their HTTP work.
  - Cache the resolved slug, session id, and cwd on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve.
  - `initialize` SHALL NOT attempt to warm the prefetch cache: Hermes calls `prefetch` with the real first user message before `queue_prefetch` ever runs (`queue_prefetch` only warms the _next_ turn's cache), so there is no meaningful query available at `initialize` time. The first turn's `prefetch` call therefore returns `""` by construction — an accepted, documented at-most-one-turn-behind tradeoff, not a bug.
- `on_pre_compress(messages, **kwargs)` SHALL, if a slug and session id were cached at `initialize` AND `self._suppressed` is false, build a textual transcript from `messages` via `_format_transcript(messages)` (conversational roles ONLY — messages whose `role` is not `user` or `assistant`, e.g. `system` or tool payloads, SHALL be skipped; oldest-first `role: content` lines, truncated from the head if the result exceeds 20,000 characters — figure corrected from the prior spec's 19,500, which never matched the code's `_SUMMARY_MAX_CHARS = 20_000`; the server's 10,000-char cap remains the authoritative trimmer), and `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript>, "final": false}`. The provider SHALL NOT include `title` in THIS (compaction-path) POST; per-turn title derivation is handled by `sync_turn` (see below), and `on_session_end` plus the server-side placeholder cover the remaining cases. Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT mutate the `messages` argument. The provider's return value SHALL be `""` (empty string — the docstring promises it goes into the compressor prompt; we contribute nothing yet).
- `on_session_end(messages, **kwargs)` SHALL, if a slug and session id were cached AND `self._suppressed` is false, build a transcript via `_format_transcript(messages)` (same conversational-roles-only filtering as `on_pre_compress`), derive a title from the first non-empty assistant message in `messages` (truncated to 100 chars; falling back to empty string if no assistant message exists), and `POST /api/<slug>/sessions/<session_id>/end` with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`. When the transcript is empty (no messages), the body SHALL be `{}` (degraded end). Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT call `memory.session_end` over MCP.
- `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)` SHALL override per the "Provider MUST override on_session_switch to track the agent's current session id" requirement, including its suppression scenario.
- `get_tool_schemas` SHALL return `[]`. The provider contributes no agent-callable tools.
- `handle_tool_call(name, args)` SHALL return `json.dumps({"error": "unknown_tool", "hint": "register the rembric MCP bridge in mcp_servers.rembric to access memory tools"})`.
- `system_prompt_block` SHALL return the unified Rembric nudge — the SAME text as the server's `initialize.instructions` BASE (the SAVE/RECALL/SUMMARIZE flows defined by the `mcp-api` capability), kept byte-identical across the TS/Python boundary. It SHALL therefore direct the agent to SAVE proactively (`memory.save` the moment something noteworthy happens — with the required short `title` headline plus the `content`, and the `topic_key` supersede and `candidates[]`→`memory.judge` paths), RECALL on-demand (`memory.context`/`memory.search` when starting/resuming work, after `/compact`, or asked "what did we do", only if prior detail is missing), and SUMMARIZE at the end of every working turn (`memory.session_summary({title, summary})`, never ending a working turn silent — phrased as a calibrated imperative conditioned on real memorable work, the trigger SHALL NOT be bound to the literal word "done"; title ≤100 chars, NOT the cwd; summary uses exactly the separate-line Markdown headings `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`), plus the `memory.about` update pointer. The block SHALL be ≤1000 chars — a self-imposed token-budget ceiling matching the server's `INSTRUCTIONS_MAX_LENGTH`, NOT a Hermes contract: upstream `agent/memory_manager.py::build_system_prompt` joins provider blocks with no truncation or length cap. Hermes additionally exposes a real per-turn recall surface via `prefetch`/`queue_prefetch` (see below); `system_prompt_block` remains a necessary complementary surface because Hermes does NOT consume the MCP server's `initialize.instructions` block, and because the per-turn surface only carries recalled memory context, not the SAVE/SUMMARIZE protocol guidance.
- `prefetch(query, **kwargs)` SHALL return the provider's cached recall result for the current session (populated by `queue_prefetch`), formatted as a `<memory-context>...</memory-context>` block ready for injection, or `""` if no cache entry exists yet for the session. `prefetch` SHALL NOT make a network call — it only reads the in-memory cache.
- `queue_prefetch(query, **kwargs)` SHALL, given a cached slug and session id, `POST ${REMBRIC_SERVER_URL}/api/<slug>/memory/recall` with body `{"query": query, "limit": 5}` and a 3-second timeout, and on success cache the response's `formatted` string keyed by session id for the next `prefetch` call to read. Failures are silent stderr diagnostics and leave the prior cache entry (if any) in place. When no slug is resolvable, `queue_prefetch` SHALL be a no-op.
- `sync_turn(user, assistant, **kwargs)` SHALL, on EVERY call (no throttle, no modulo counter), if a slug and session id were cached AND `self._suppressed` is false, dispatch `POST /api/<slug>/sessions/<session_id>/summary` on a background thread with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`, where `<transcript>` is built via `_format_transcript` from the session's accumulated turns (same conversational-roles-only filtering) and `<derived_title>` is `_derive_title_from_messages(messages)` over the same accumulated turns (first non-empty assistant message, ≤100 chars). The `title` key SHALL be OMITTED from the body when the derivation yields an empty string (no assistant message yet). This per-turn title write gives Hermes parity with Claude Code, Codex, and opencode (which all send a derived title every turn) so the placeholder title is replaced from turn 1 even when `on_session_end` never fires; `final:false` keeps it subordinate to any later model-authored `final:true` title via `applyPrecedence`. The background-thread discipline is unchanged: before starting a new one, IF the provider's previously-spawned sync thread (if any) `.is_alive()`, `.join(timeout=5.0)` it; THEN spawn a new `daemon=True` `threading.Thread` targeting the POST call and start it without joining. Inside that background thread, the provider SHALL attempt to acquire its sync lock with `timeout=5.0`; if the acquire fails (a prior POST is still in flight past the timeout), the thread SHALL return WITHOUT building the transcript or POSTing — it SHALL NOT proceed unsynchronized, and it SHALL NOT release a lock it never acquired. A skipped write here is not a lost write: the next `sync_turn` call resends the full accumulated transcript. This follows Hermes's own documented "Threading Contract" (`memory-provider-plugin.md`) for provider-initiated background work — it does not fight an event loop, because `MemoryProvider` has none. Timeout on the POST itself remains 3 seconds; failures are silent stderr diagnostics, observed only by whichever thread's join (if any) surfaces them.
- `on_memory_write(action, target, content, **kwargs)` SHALL be a no-op.
- `shutdown(**kwargs)` SHALL be a no-op.

The provider SHALL NOT implement `get_config_schema` or `save_config`. Credentials live in `~/.hermes/.env`. The provider SHALL NOT preload any plugin-specific dotenv file.

#### Scenario: is_available with both envs set and a healthy server returns True

(Unchanged from the prior spec.)

#### Scenario: is_available with a missing token returns False without making a request

(Unchanged from the prior spec.)

#### Scenario: is_available with an invalid token returns False

(Unchanged from the prior spec.)

#### Scenario: is_available with the server's database unavailable returns False

(Unchanged from the prior spec.)

#### Scenario: Session initialize POSTs to the sessions endpoint with agent: hermes

(Unchanged from the prior spec.)

#### Scenario: Pre-compress posts a transcript summary

(Unchanged from the prior spec.)

#### Scenario: Session end posts to the end endpoint with summary and derived title

(Unchanged from the prior spec.)

#### Scenario: Session end with empty messages degrades to `{}`

(Unchanged from the prior spec.)

#### Scenario: Session end when model already wrote a final summary

(Unchanged from the prior spec.)

#### Scenario: Lifecycle calls without a resolved slug skip silently

(Unchanged from the prior spec.)

#### Scenario: system_prompt_block emits the proactive session-close protocol AND memory.context recovery guidance

- **WHEN** Hermes calls `provider.system_prompt_block()`
- **THEN** the returned string SHALL be non-empty and SHALL contain the substring `memory.session_summary`
- **AND** SHALL contain a reference to `title` and exactly the six canonical `##` headings defined in `sessions`, with an instruction to put each on its own line
- **AND** SHALL phrase the trigger as firing at the end of every working turn (never silent) and SHALL NOT bind it solely to the literal word "done"
- **AND** SHALL contain the substrings `memory.context`, `memory.save`, and `memory.about` (the unified RECALL / SAVE / update flows)
- **AND** SHALL be ≤1000 chars total (self-imposed budget matching the server's `INSTRUCTIONS_MAX_LENGTH`; Hermes applies no truncation)

#### Scenario: handle_tool_call returns a defensive error

(Unchanged from the prior spec.)

#### Scenario: Provider does not manage credential storage

(Unchanged from the prior spec.)

#### Scenario: queue_prefetch warms the cache and prefetch returns it

- **GIVEN** a resolved slug and session id
- **WHEN** `queue_prefetch("how did we handle auth", session_id=<id>)` is called and the recall endpoint responds successfully
- **THEN** the provider's cache for `<id>` SHALL hold the response's `formatted` string
- **AND** a subsequent `prefetch("how did we handle auth", session_id=<id>)` call SHALL return that cached string without making a network call

#### Scenario: prefetch returns empty string before any cache warm

- **GIVEN** a session that has not yet had a successful `queue_prefetch` call
- **WHEN** `prefetch(query, session_id=<id>)` is called
- **THEN** it SHALL return `""` and SHALL NOT make a network call

#### Scenario: sync_turn dispatches a background POST on every call

- **GIVEN** a resolved slug and session id, and no previously-spawned sync thread
- **WHEN** `sync_turn` is called once with accumulated turns whose first assistant message is non-empty
- **THEN** exactly one background `threading.Thread` SHALL be spawned targeting `POST /api/<slug>/sessions/<session_id>/summary`
- **AND** the POST body SHALL include `summary`, `final:false`, AND a `title` derived from the first non-empty assistant message (≤100 chars)
- **AND** `sync_turn` itself SHALL return without blocking on that thread

#### Scenario: sync_turn omits title before any assistant message exists

- **GIVEN** a resolved slug and session id, and accumulated turns with no non-empty assistant message yet
- **WHEN** `sync_turn` is called
- **THEN** the POST body SHALL contain `summary` and `final:false` but SHALL OMIT the `title` key (derivation yielded an empty string)

#### Scenario: sync_turn joins the prior thread before spawning a new one

- **GIVEN** a resolved slug and session id, and a previously-spawned sync thread that is still `.is_alive()`
- **WHEN** `sync_turn` is called again
- **THEN** the provider SHALL `join(timeout=5.0)` the prior thread before spawning and starting the new one
- **AND** at most one sync thread SHALL be alive per provider instance at a time (modulo the bounded 5-second overlap during the join)

#### Scenario: Transcript serialization excludes non-conversational roles

- **GIVEN** a `messages` list containing a large `role: system` message (e.g. Hermes's toolset documentation), a `role: user` message, and a `role: assistant` message
- **WHEN** `_format_transcript(messages)` runs (via `sync_turn`, `on_pre_compress`, or `on_session_end`)
- **THEN** the resulting transcript SHALL contain ONLY the `user:` and `assistant:` lines
- **AND** no fragment of the system message SHALL appear in the POSTed `summary`, regardless of tail-truncation
- **AND** `_derive_title_from_messages` SHALL continue to derive the title from the first non-empty assistant message, unchanged

#### Scenario: initialize skips session creation for a subagent context

- **GIVEN** `initialize(session_id, agent_context="subagent", ...)` is called with a resolvable slug
- **THEN** the provider SHALL NOT POST to `/api/<slug>/sessions`
- **AND** the provider SHALL still cache the resolved slug and register normally for subsequent lifecycle calls
- **AND** `self._suppressed` SHALL be `True` for the lifetime of this session

#### Scenario: initialize creates a session when agent_context is absent or primary

- **GIVEN** `initialize(session_id, ...)` is called with no `agent_context` kwarg (or `agent_context="primary"`) and a resolvable slug
- **THEN** the provider SHALL POST to `/api/<slug>/sessions` exactly as before this requirement's revision
- **AND** `self._suppressed` SHALL be `False`

#### Scenario: Suppression propagates to every lifecycle HTTP call, not just the initial POST

- **GIVEN** `initialize(session_id, agent_context="subagent", ...)` was called with a resolvable slug (so `self._suppressed` is `True`)
- **WHEN** `sync_turn`, `on_pre_compress`, and `on_session_end` are each called in turn
- **THEN** NONE of them SHALL make an HTTP request
- **AND** this holds even though slug, base URL, and session id are all present (the ONLY reason for the no-op is suppression, not a missing prerequisite)

#### Scenario: sync_turn's background thread aborts on a lock-acquire timeout instead of proceeding unsynchronized

- **GIVEN** a resolved slug and session id, and the provider's sync lock is already held by another in-flight operation for longer than 5 seconds
- **WHEN** `sync_turn` is called and its background thread attempts to acquire the lock
- **THEN** the thread SHALL return without building a transcript or making the POST
- **AND** the thread SHALL NOT call `release()` on a lock it never acquired

### Requirement: Distribution via curl-installer

The plugin SHALL be installable through a single shell script hosted at `apps/plugin/.hermes-plugin/install.sh` in the rembric monorepo. The script SHALL:

- Default to `PLUGIN_SRC="https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin"`.
- Honour an overriding `PLUGIN_SRC` environment variable that points at any local directory (for developers with a cloned monorepo) or any other reachable URL prefix.
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Create the target directory `${HERMES_HOME}/plugins/rembric/` if it does not exist.
- Copy or fetch exactly three files into the target directory: `plugin.yaml`, `__init__.py`, `README.md`. When `PLUGIN_SRC` resolves to a local path that contains these files, the script SHALL prefer local `cp`; otherwise the script SHALL `curl -fsSL` from the prefix.
- Exit non-zero on any unrecoverable error (target directory cannot be created; all sources for a required file fail). Print a clear `[rembric] error: <reason>` line to stderr before exiting.
- Print a one-line success message identifying the install location and the next step to stdout: `✓ rembric installed at <path>\n  enable: hermes plugins enable rembric`.

The recommended public install command in `README.md` SHALL be:

```
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
```

The legacy URL `https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh` SHALL return HTTP 404 — no shim file is kept under `plugin/.hermes-plugin/`. The breakage is communicated via the first post-restructure `hermes-plugin-vX.Y.Z` release notes (BREAKING), and via the install command published in `README.md`, `docs/agents.md`, and `apps/plugin/.hermes-plugin/README.md`.

The plugin's README and docs SHALL NOT recommend a `git clone + cp -r` two-step install as a parallel path. The curl-installer with `PLUGIN_SRC` covers both the casual-user and the developer-with-clone case.

#### Scenario: Default install fetches the three files via curl

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` in a fresh shell with `HERMES_HOME` unset
- **THEN** the script creates `${HOME}/.hermes/plugins/rembric/` and writes `plugin.yaml`, `__init__.py`, `README.md` into it
- **AND** stdout includes `✓ rembric installed at` followed by the resolved path

#### Scenario: Developer install reads from local clone

- **WHEN** a developer with a clone of rembric runs `PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh`
- **THEN** the three files in the target directory are byte-identical to the files in the local source
- **AND** no network request is issued by the script

#### Scenario: Missing remote file fails loudly

- **WHEN** the script runs with the default `PLUGIN_SRC` and the upstream `plugin.yaml` returns HTTP 404
- **THEN** the script writes `[rembric] error:` to stderr and exits with a non-zero status
- **AND** the target directory may exist but does not contain a half-written `plugin.yaml`

#### Scenario: Legacy install URL returns 404

- **WHEN** a user runs the legacy command `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh`
- **THEN** `curl -fsSL` SHALL fail with a 404 from `raw.githubusercontent.com` and exit non-zero
- **AND** no plugin files SHALL be installed
- **AND** the user SHALL find the corrected install command in the README / docs / release notes

### Requirement: Uninstall via local script

The plugin SHALL be removable through a script at `apps/plugin/.hermes-plugin/uninstall.sh`, mirroring the conservative, idempotent semantics of `apps/plugin/.opencode-plugin/uninstall.sh`. The script SHALL:

- Be POSIX-compatible and run cleanly such that re-running it on an already-clean system is a no-op that still exits zero (idempotent).
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Remove the three installed plugin files (`plugin.yaml`, `__init__.py`, `README.md`) from `${HERMES_HOME}/plugins/rembric/` if present, then `rmdir` the `rembric` plugin directory when it is empty.
- Run `hermes plugins disable rembric` on a best-effort basis (failure SHALL NOT abort the uninstall).
- NOT remove operator-owned state: it SHALL leave `${HERMES_HOME}/.env`, any stored credentials, and any `.rembric` project markers untouched.
- Print which files were removed, which were already absent, and an explicit list of what it deliberately left in place (the `.env` credentials and `.rembric` files), so the operator can remove them manually if desired.

#### Scenario: Uninstall removes plugin files and reports

- **WHEN** the plugin is installed at `${HOME}/.hermes/plugins/rembric/` and the user runs `sh apps/plugin/.hermes-plugin/uninstall.sh`
- **THEN** the three plugin files SHALL be removed and the now-empty `rembric` directory SHALL be `rmdir`-ed
- **AND** stdout SHALL list the removed files and the deliberately-left-behind state

#### Scenario: Uninstall is idempotent

- **WHEN** `uninstall.sh` runs against a system where the plugin is already absent
- **THEN** it SHALL exit zero
- **AND** it SHALL report the files as already absent without erroring

#### Scenario: Uninstall preserves credentials and project markers

- **WHEN** `uninstall.sh` completes
- **THEN** `${HERMES_HOME}/.env` and any `.rembric` files SHALL remain on disk
- **AND** stdout SHALL name them as deliberately left in place

### Requirement: User documentation

The plugin's `README.md` (at `apps/plugin/.hermes-plugin/README.md`) SHALL include, in this order:

1. The **TUI installer** as the primary install/upgrade instruction (the root `install.sh` shim, canonical URL `.../main/install.sh`, or `--agent=hermes`). The per-client manual install — `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` followed by `hermes plugins install rembric` to trigger the `requires_env` prompts — SHALL be retained below under an explicitly-labelled "Manual install" heading, not as the lead instruction.
2. A description of what Hermes prompts for during install (the three `requires_env` vars) and where the answers are persisted (`${HERMES_HOME:-~/.hermes}/.env`).
3. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
4. A short "Project slug resolution" section explaining the `.rembric` → `REMBRIC_PROJECT_SLUG` → no-slug fallback in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, `~/.hermes/.env` edited manually after install.

Hermes is the one client whose MCP entry is **documented** rather than shipped as a manifest, so the transport contract other clients get from a tracked file has to be carried by this README instead — and a documented block that violates the contract teaches users to opt out of it. The `mcp_servers.rembric` block SHALL therefore satisfy four properties, each of which the block violated before this requirement:

- It SHALL name `@rembric/mcp-bridge` at an **exact pinned version**, never `mcp-remote` and never a floating tag such as `@latest`. `npx` re-resolves a floating tag on every session start, so a compromised or broken publish reaches the user immediately.
- Its `args` SHALL be exactly the `-y` flag and the pinned package specifier. There SHALL be **no** URL argument, **no** `--header` argument and **no** `--allow-http` argument: the bridge takes no arguments and reads its whole configuration from the environment.
- The bearer SHALL reach the process through explicit `env` mappings for `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`, and `REMBRIC_PROJECT_SLUG`, never through `args`. Hermes MCP subprocesses SHALL NOT be documented as inheriting `${HERMES_HOME:-~/.hermes}/.env` implicitly. A token in an argument vector is readable by any local process via `ps` and `/proc/<pid>/cmdline`.
- The slug SHALL be expressed as `REMBRIC_PROJECT_SLUG` in the environment, not as a `/mcp/<slug>` URL suffix. With no URL argument the environment variable is the only way to express a default slug — and it is the variable this plugin's own `requires_env` already collects, resolved by the bridge with the same precedence this capability's cascade defines (`.rembric` first, the environment variable second).

Any `node`-instead-of-`npx` variant the README shows SHALL point at a current path; the pre-monorepo `plugin/bin/…` path SHALL NOT appear.

The README SHALL NOT mention `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, or `~/.hermes/rembric.json`. Those mechanisms were removed; documenting them would mislead users into setting up files the plugin ignores.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code, Codex CLI, and opencode, with a link to the plugin README at `apps/plugin/.hermes-plugin/README.md`.

`docs/agents.md` SHALL gain (or retain, after path swap) a "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, leading with the TUI installer and covering install (including the `requires_env` prompt flow as the manual fallback), config, env vars, slug resolution, and a pointer to the plugin README at the new path.

That section's `mcp_servers.rembric` block SHALL satisfy the same four properties as the plugin README's, since it is the same block shown twice.

`apps/plugin/README.md` and `apps/plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside the other clients.

#### Scenario: README leads with the TUI, manual curl-installer retained below

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` top-to-bottom
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `curl … install.sh | sh` + `hermes plugins install rembric` flow SHALL appear under an explicit "Manual install" heading

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`

#### Scenario: The documented MCP block pins an exact transport version

- **WHEN** every `mcp_servers.rembric` block in `apps/plugin/.hermes-plugin/README.md` and `docs/agents.md` is read
- **THEN** each SHALL name `@rembric/mcp-bridge@<x.y.z>` with an exact version
- **AND** no occurrence of `mcp-remote` SHALL remain
- **AND** no `@latest` or other floating tag SHALL appear in either block

#### Scenario: The documented MCP block passes no arguments beyond the specifier

- **WHEN** the `mcp_servers.rembric` block is read
- **THEN** its `args` SHALL be exactly `-y` and the pinned package specifier
- **AND** it SHALL contain no URL entry, no `--header` entry and no `--allow-http` entry

#### Scenario: The documented MCP block keeps the token and the slug in the environment

- **WHEN** the block is read
- **THEN** the bearer SHALL be supplied through the explicit `env` mapping to the subprocess, not through `args`
- **AND** the default project slug SHALL be expressed as `REMBRIC_PROJECT_SLUG`, not as a `/mcp/<slug>` suffix on `REMBRIC_SERVER_URL`

#### Scenario: A per-directory `.rembric` still wins over the documented default

- **GIVEN** a documented block setting `REMBRIC_PROJECT_SLUG=alpha` and a working directory containing `.rembric` with `PROJECT_SLUG=gamma`
- **WHEN** the transport resolves the slug
- **THEN** it SHALL use `gamma`
- **AND** the resolution SHALL match the precedence this capability's slug cascade defines for the provider, so the two surfaces cannot disagree

#### Scenario: No stale bridge path is documented

- **WHEN** any local-checkout alternative to `npx` is shown
- **THEN** it SHALL NOT name the pre-monorepo `plugin/bin/rembric-bridge.mjs` path

### Requirement: Version coupling with other client manifests

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by the single unified `plugin` release-please component (covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`), via an `extra-files` updater on `plugin.yaml`. Hermes is NO LONGER a separate release-please component, and there is no `node-workspace` cascade.

All plugin clients (claude, codex, opencode, hermes, pi) share the single `plugin` version — Hermes's `plugin.yaml::version` always equals the current `plugin` version. The `CLAUDE.md` "Releasing a new plugin version" guidance SHALL describe the two-track model (`server` · unified `plugin`), not the former six-component cascade. A client that is additionally published to a package registry does NOT get its own component or its own version line; it is one more `extra-files` carrier of the same `plugin` version.

Hermes users still receive shared-asset updates on their next `curl … install.sh | sh` (the installer re-fetches from `main`); the unified version is bookkeeping/changelog, independent of how shared code reaches an install.

#### Scenario: A Hermes-only change bumps the unified plugin component

- **WHEN** a contributor merges a `fix:` commit modifying only files under `apps/plugin/.hermes-plugin/`
- **THEN** release-please SHALL open a release PR for the `plugin` component (tag `plugin-vX.Y.Z`), updating `plugin.yaml::version` alongside the other client carriers
- **AND** the `server` version SHALL remain unchanged and the server image SHALL NOT be rebuilt
- **AND** no separate `hermes-plugin` component / `hermes-plugin-v*` tag SHALL exist

#### Scenario: A shared-bin change bumps the one plugin version

- **WHEN** a contributor merges a `feat:` commit modifying `apps/plugin/mcp-bridge/`
- **THEN** release-please SHALL bump the single `plugin` component, moving `plugin.yaml::version` to the same new version as every other client
- **AND** Hermes users SHALL receive the updated bridge on their next re-run of the installer from `main`

#### Scenario: A change to a registry-published client still bumps Hermes's carrier

- **WHEN** a contributor merges a commit modifying only `apps/plugin/.pi-plugin/`
- **THEN** `plugin.yaml::version` SHALL be moved to the same new `plugin` version in the same release PR
- **AND** the changelog entry, scoped by conventional commit, SHALL identify which client actually changed

### Requirement: The Hermes provider SHALL report each turn from `sync_turn` and print the server's notice from `prefetch`, plus a pre-compaction save reminder

The Hermes `MemoryProvider` (`apps/plugin/.hermes-plugin/__init__.py`) SHALL reinforce curation through `prefetch()` (whose return is injected as `<memory-context>` every turn), report each finished turn through `sync_turn()`, and keep observing `remaining_tokens` in `on_turn_start()`. This is the only per-turn reinforcement Hermes has, since it does not consume the server's `initialize.instructions`.

**The periodic save and summary reminders are no longer composed here and no longer keyed on a turn counter.** `_SAVE_HINT_EVERY`, `_SUMMARY_HINT_EVERY`, `_SAVE_HINT` and `_SUMMARY_HINT` are removed. The firing decision belongs to the server, which composes one stretch-close notice from the session's own state (`session-nudges`); `prefetch()` prints what the previous turn's report returned. `_turn_number` survives only for the one thing that still needs it — the first-turn relevance line — and for nothing else.

- `on_turn_start(turn_number, message, **kwargs)` SHALL remain listed in `plugin.yaml`'s `hooks:` array (the array gates override invocation). It SHALL record the turn number and, when `remaining_tokens` is an int below `_COMPACTION_TOKEN_FLOOR` and no urgent reminder has yet fired this session, arm an urgent flag.
- **`sync_turn(user, assistant, **kwargs)`SHALL additionally issue the turn report** to`POST /api/<slug>/sessions/<session_id>/turn`, on the SAME background thread as the transcript POST it already dispatches, and SHALL cache the returned lines for the next `prefetch()`. It SHALL be suppressed by the same `self.\_suppressed`guard that gates every other lifecycle call. The transcript POST itself is UNCHANGED and SHALL NOT be removed: the compaction and session-end paths depend on the same`messages` list, and this client's convergence guarantee rests on them.
- **Hermes is the one client that does NOT report on every finished turn, and the deviation SHALL be published rather than left to be discovered.** The host skips its memory fan-out entirely on an interrupted turn (`run_agent.py:4345-4346` returns before `sync_all`), and again when the flattened user or assistant text is empty. `sync_turn` is therefore not called at all on those turns, so this client issues no report for them. Two consequences follow and neither is a defect this change can repair from the plugin side: no notice can be delivered for an interrupted turn, and — the one that matters — `last_activity_at` is not stamped, so a session interrupted on every turn for longer than the abandonment threshold is retired by the stale-active sweep while its user is still working. A client-side workaround (reporting from `on_turn_start`, or a timer) SHALL NOT be added for this: it would report turns that did not complete, which is the opposite of what the field means, and the host's own skip is deliberate — its comment reasons that a partial or aborted turn "is not durable conversational truth".
- **The two conditions SHALL be evaluated over the LAST TURN of `messages`, never over the whole list.** The kwarg is the agent loop's own working list — the same property that makes its content trustworthy makes it a CONVERSATION, not a turn — so a scan of all of it reports `usedTools: true` for every turn after the first tool call the session ever made, and the gate then fires on conversation-only turns for the rest of the run. The turn SHALL be taken as the suffix beginning at the LAST message whose `role` is `user`; where the list carries no `user` message the whole list SHALL be scanned, since nothing narrower is available. The transcript POST is unaffected and SHALL keep using the whole list.
- **The tool observation SHALL be read from `sync_turn`'s `messages` kwarg, and it SHALL test TWO conditions rather than one.** The flag is set when EITHER a message's `role` is outside `{user, assistant, system}`, OR a message with `role: "assistant"` carries a non-empty `tool_calls` field. **A role-only test detects results and misses calls**: in the OpenAI message shape a tool CALL lives in the `tool_calls` field of an `assistant` message while the RESULT is a separate `role: "tool"` message, so a call that produced no result message — an aborted turn, a tool that errored before returning, a provider that batches differently — would be silently invisible to a role check alone. A `system` role SHALL NOT count as a tool.
- **When the kwarg is absent the provider SHALL report `true`, and the reason is structural rather than cautious.** The kwarg exists only on Hermes ≥ 2026.5.29; on older hosts the provider takes its own fallback branch (`apps/plugin/.hermes-plugin/__init__.py:552-557`), which synthesises the list as exactly `[{"role": "user", …}, {"role": "assistant", …}]` from the two positional strings. Both conditions above are then unsatisfiable **by construction**, so a count over that list does not mean "no tool ran" — it means "nothing was observable", and reporting `false` would turn every turn on an older Hermes into a silent false negative. This is the fail-open rule in `session-nudges` applied to a case where the negative is known to be uninformative, not a general precaution.
- **The kwarg's DELIVERY is settled and SHALL NOT be re-litigated; only its runtime CONTENT is open.** The host's `MemoryProvider` ABC declares `sync_turn(self, user_content, assistant_content, *, session_id="", messages=None)`, and the dispatcher selects per provider by signature inspection: a provider declaring a `VAR_KEYWORD` parameter is passed `messages`. This provider's signature is `sync_turn(self, user, assistant, **kwargs)` (`apps/plugin/.hermes-plugin/__init__.py:543`), so it qualifies as written and SHALL keep its `**kwargs` — narrowing that signature to named parameters would fail the inspection and silently stop the kwarg arriving. The host passes the two leading values POSITIONALLY, so this provider's parameter names (`user`, `assistant`) diverging from the ABC's (`user_content`, `assistant_content`) is harmless and SHALL NOT be treated as a defect to repair.
- **The list's CONTENT is traced in upstream source, and the role half of the condition is traced to its literal.** `messages` is the agent loop's own working list rather than one assembled for memory: the tool executor appends tool-result messages into it at seven sites, `make_tool_result_message` sets `"role": "tool"`, the turn finaliser carries `messages` as a first-class parameter distinct from `conversation_history`, and the runtime forwards it into `sync_all` when non-`None`. So a turn that ran a tool puts a `role: "tool"` message in the list the provider receives. What remains is corroboration in execution, not discovery: a single dump of the roles present on a tool turn against a running Hermes ≥ 2026.5.29. That check SHALL gate closing this change and SHALL NOT gate implementing it.
- **The `tool_calls` half is the one clause with no trace behind it, and SHALL be labelled as such rather than presented alongside the traced half.** It was not followed to an append. It stays because it is the correct rule for the OpenAI shape, and its worst case is narrow: a tool call that produced no result message reports `false`, costing one notice. If a running Hermes never populates it, the clause MAY be dropped, and dropping it SHALL NOT be treated as weakening the rule.
- `prefetch()` SHALL return the cached recall context and SHALL additionally append, as separate lines:
  - the **first-turn relevance** hint when `_turn_number == 1`;
  - the **session opening** when the session-ensure reported a newly created session and it has not yet been emitted (`session-nudges`);
  - the **urgent pre-compaction** save reminder when its flag is armed, marking itself warned so it fires at most once per session;
  - the **post-compaction** directive when armed by `on_pre_compress`, superseding the resumed-read line on a shared turn, unchanged by this requirement;
  - the **cached server lines** from the last turn report, verbatim, wrapped in `<memory-hint>…</memory-hint>` per this provider's established convention and otherwise unaltered. Reading the cache SHALL clear it, so a notice is injected exactly once.
- Every line SHALL remain mutually independent; none SHALL overwrite another.
- **`prefetch()` SHALL make no network call.** It reads two caches — the recall cache and the pending-lines cache — and returns. The request that produced the lines was made by `sync_turn` on the previous turn.
- The urgent/warned flags, the turn counter and the pending-lines cache SHALL reset on session end and session switch.

#### Scenario: prefetch injects the server's notice, once, wrapped

- **GIVEN** an initialized provider whose last `sync_turn` report returned notice lines
- **WHEN** `prefetch` is next called
- **THEN** the returned string SHALL contain those lines, wrapped in `<memory-hint>…</memory-hint>` and otherwise byte-identical to the response
- **AND** a subsequent `prefetch` with no new report SHALL NOT contain them again

#### Scenario: The provider composes no periodic reminder and counts no cadence

- **WHEN** `apps/plugin/.hermes-plugin/__init__.py` is read at HEAD
- **THEN** it SHALL contain no `_SAVE_HINT_EVERY`, no `_SUMMARY_HINT_EVERY`, no `_SAVE_HINT` and no `_SUMMARY_HINT`
- **AND** the only remaining use of `_turn_number` SHALL be the first-turn relevance line

#### Scenario: sync_turn reports the turn and keeps its transcript POST

- **GIVEN** an initialized, unsuppressed provider
- **WHEN** `sync_turn` is called once
- **THEN** the background thread SHALL issue BOTH the `/summary` transcript POST and the `/turn` report
- **AND** `sync_turn` SHALL return without blocking on that thread
- **AND** a suppressed provider (`agent_context` in the non-primary set) SHALL issue neither

#### Scenario: A tool RESULT message in the messages kwarg is reported as work

- **GIVEN** a `sync_turn` call whose `messages` kwarg carries a message with `role: "tool"`
- **WHEN** the report is built
- **THEN** it SHALL carry `usedTools: true`
- **AND** the control SHALL pass in the same run: a list of only `user`, `assistant` and `system` roles, none carrying `tool_calls`, SHALL report `usedTools: false`

#### Scenario: A tool used in an earlier turn is not reported for a later chat turn

- **GIVEN** a `messages` list whose first turn carries a `tool_calls` assistant message and a `role: "tool"` result, followed by a second turn of `user` and `assistant` messages only
- **WHEN** the report for that second turn is built
- **THEN** it SHALL carry `usedTools: false`
- **AND** the control SHALL pass in the same run: the same two turns in the opposite order SHALL report `usedTools: true`

#### Scenario: A tool CALL with no result message is still reported as work

- **GIVEN** a `sync_turn` call whose `messages` kwarg carries an `assistant` message with a non-empty `tool_calls` field and NO `role: "tool"` message anywhere in the list
- **WHEN** the report is built
- **THEN** it SHALL carry `usedTools: true`
- **AND** a role-only test SHALL be shown to return `false` on the same input, which is why both conditions are required

#### Scenario: An interrupted turn produces no report, and that is the published behaviour

- **GIVEN** a Hermes turn the user interrupts before it completes
- **WHEN** the host finalises it
- **THEN** `sync_turn` SHALL NOT be called, so no turn report SHALL be issued
- **AND** `last_activity_at` SHALL NOT be stamped by that turn
- **AND** no client-side substitute SHALL be issued from `on_turn_start`, from a timer, or from any other handler

#### Scenario: The provider's signature keeps the kwarg arriving

- **WHEN** `apps/plugin/.hermes-plugin/__init__.py`'s `sync_turn` signature is read at HEAD
- **THEN** it SHALL declare a `**kwargs` parameter
- **AND** it SHALL NOT be narrowed to named parameters only, which would fail the host's signature inspection and stop `messages` being passed with no error anywhere

#### Scenario: An empty `tool_calls` field is not a tool call

- **GIVEN** an `assistant` message whose `tool_calls` is an empty list, or absent, or `None`
- **WHEN** the report is built
- **THEN** that message alone SHALL NOT set the flag

#### Scenario: An absent messages kwarg fails open because the negative is uninformative

- **GIVEN** a Hermes older than 2026.5.29, so `sync_turn` receives no `messages` kwarg and the provider synthesises the list from the two positional strings
- **WHEN** the report is built
- **THEN** it SHALL carry `usedTools: true`
- **AND** the synthesised list SHALL be shown to admit only `user` and `assistant` roles and no `tool_calls` field, so a `false` from that branch would report "no tool ran" on evidence that could never have shown one

#### Scenario: prefetch appends the relevance hint on turn 1

- **GIVEN** an initialized Hermes provider with an empty recall cache
- **WHEN** `prefetch` is called on the 1st turn
- **THEN** it SHALL return a non-empty string containing the first-turn relevance hint

#### Scenario: on_turn_start arms the urgent reminder only below the floor

- **WHEN** `on_turn_start` is called with `remaining_tokens` above `_COMPACTION_TOKEN_FLOOR`
- **THEN** no urgent flag SHALL be armed
- **WHEN** it is later called with `remaining_tokens` below the floor
- **THEN** the urgent flag SHALL be armed

#### Scenario: The pre-compaction reminder fires once and does not suppress a pending notice

- **GIVEN** the urgent flag is armed and notice lines are cached
- **WHEN** `prefetch` is next called
- **THEN** it SHALL return the urgent pre-compaction save reminder AND the cached notice, as separate lines
- **AND** a subsequent `prefetch` on a later low-token turn SHALL NOT repeat the urgent reminder (warned once per session)

#### Scenario: prefetch makes no network call

- **WHEN** `prefetch` is executed
- **THEN** no HTTP request SHALL be issued from it
- **AND** the lines it injects SHALL come from caches populated by `queue_prefetch` and `sync_turn`

### Requirement: Slug resolution cascade order

The provider SHALL resolve the project slug in `initialize` using this strict precedence chain. The chain SHALL stop at the first source that yields a slug that matches the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (identical to the bridge's regex in `apps/plugin/mcp-bridge/`):

1. The `PROJECT_SLUG` value parsed from `<kwargs.cwd>/.rembric`, using the same dotenv-style parser as the bridge: trim whitespace, skip blank lines and lines starting with `#`, accept `KEY=VALUE`, and strip matched outer single or double quotes from the value.
2. `REMBRIC_PROJECT_SLUG` environment variable (populated by Hermes from `~/.hermes/.env` via the `requires_env` install flow, or set directly in the parent shell) — a fallback default for a cwd that has no `.rembric` file.
3. The final path segment of `urlparse(REMBRIC_SERVER_URL).path` if the path matches `/mcp/<slug>`.
4. `None` — degraded mode, all session-related POSTs are skipped silently.

This order matches the `requires_env` manifest's own description of `REMBRIC_PROJECT_SLUG` ("Default project slug. Overridden per-cwd if a .rembric file is present.") — a user who sets the env var once via the install flow and then works across multiple repos, each with its own `.rembric`, gets correct per-repo project scoping instead of every repo silently collapsing onto the one env-configured project.

The resolved slug SHALL be validated against the slug regex; non-matching candidates SHALL be discarded and the cascade continues to the next source. The provider SHALL NOT walk parent directories looking for `.rembric` — only the literal `cwd` is checked.

#### Scenario: .rembric wins over env

- **WHEN** `REMBRIC_PROJECT_SLUG=alpha` is set and `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`
- **THEN** the provider resolves the slug as `gamma`

#### Scenario: env wins when no .rembric file is present

- **WHEN** `<cwd>/.rembric` does not exist, `REMBRIC_PROJECT_SLUG=alpha` is set, and `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `alpha`

#### Scenario: URL parse is the final source

- **WHEN** `.rembric` and env are both absent, and `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `delta`

#### Scenario: Invalid candidate is skipped

- **WHEN** `<cwd>/.rembric` contains `PROJECT_SLUG=Has_Underscores` (does not match the slug regex) and `REMBRIC_PROJECT_SLUG=gamma` is set
- **THEN** the provider rejects the `.rembric` value and resolves the slug as `gamma`

#### Scenario: All sources empty yields None

- **WHEN** no source produces a valid slug
- **THEN** the provider's resolved slug is `None`
- **AND** all session-related POSTs in subsequent lifecycle calls are skipped silently

### Requirement: Provider MUST override `on_session_switch` to track the agent's current session id

`RembricMemoryProvider` SHALL override `on_session_switch(new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs)`. Hermes fires this method on context compression, `/resume`, `/branch`, `/reset`, `/new`, `/undo` and the gateway rewind — every path that reassigns or re-anchors `AIAgent.session_id` without tearing the provider down. Without overriding, our `self._session_id` becomes stale and all subsequent lifecycle posts target the wrong row.

**The session id does NOT always change, and the previous wording of this requirement asserted that it did.** Measured against `hermes_agent` 0.19.0, three of the seven call sites pass a `new_session_id` equal to the id the provider already holds:

- in-place context compression (`agent/conversation_compression.py:1403`, whose own comment records that the hook "Fires in BOTH modes: in-place uses the same id as parent");
- `/undo` (`cli.py:7517`), which passes `rewound=True` with `parent_session_id=""` and the unchanged `self.session_id` — the ABC documents `rewound` as "`True` if session_id is unchanged but the transcript was truncated";
- the gateway rewind (`tui_gateway/server.py:13396`), identical in shape.

The provider SHALL therefore compare against its own cached id and SHALL NOT assume a rotation. Behaviour:

1. If `self._suppressed` is `True` for the session being switched away from, skip ALL of the following steps except updating `self._session_id` — a subagent/cron/flush session that switches is still non-primary, and `self._suppressed` carries forward unchanged onto the new session id (Hermes does not re-run `initialize` on a switch, so there is no new `agent_context` to read).
2. Otherwise, when the cached `self._session_id` is non-empty AND differs from `new_session_id` AND a slug is resolved: `POST /api/<slug>/sessions/<cached_id>/end` with body `{}` to close the old row. Empty body — no summary write here, because the per-turn sync and `on_pre_compress` have already written one. The discriminator SHALL be the cached id, NOT `parent_session_id`: keying off equality with the cached id is what makes the same-id calls above no-ops, and `parent_session_id` cannot serve as the discriminator because it is populated on paths that are not continuations and empty on paths that are.
3. Update `self._session_id = new_session_id`.
4. Unless suppressed (step 1), `POST /api/<slug>/sessions` with body `{"id": <new_session_id>, "cwd": <cached cwd or os.getcwd()>, "agent": "hermes"}` to register the new row. The server writes the placeholder title. This step SHALL run even when the id did not change, because the ensure is idempotent and it is the carrier for step 5.
5. Unless suppressed, and only when `new_session_id` was not already in a process-scoped set of ids this provider has ensured, add it to that set and `POST /api/<slug>/sessions/<new_session_id>/resume` with body `{}`. `initialize` SHALL use the same set for the id it registers, so the pair "ensure then resume" fires at most once per id for the lifetime of the process. This is the uniform cross-client rule specified in `plugin-session-protocol`'s lifecycle mapping; Hermes implements the set itself because it is the Python client and does not import the shared JS core.

**A second false claim SHALL be retired with this requirement.** The provider's source carries the comment "`/reset` and `/new` use `parent_session_id=""` by upstream contract (clean restart, no continuation lineage)". Measured: `cli.py:7292` passes `parent_session_id=old_session_id or ""` on the `/new` path, and `agent/memory_manager.py:905` forwards the same value on the with-history path, so `parent_session_id` arrives **populated** on exactly the case the comment says it is empty. The genuine clean-restart discriminator is `reset=True`, which those two sites pass and no other site does. The comment SHALL be corrected to state the cached-id rule and its real justification; the behaviour it describes does not change.

The host additionally passes a `reason` keyword — `"new_session"`, `"resume"`, `"branch"` or `"compression"`, from five of the seven call sites, absent from the two that pass `rewound=True` — which is not part of the `MemoryProvider` ABC signature and reaches the provider only through `**kwargs`. The provider SHALL NOT consume `reason` or `rewound`, and SHALL continue to discard `**kwargs`. Consuming `reason` could only be used to skip a resume that is already a no-op on an `active` row, at the cost of coupling this provider to a keyword the ABC does not declare and only some call sites send; and `reason="resume"` fires only for an in-process switch, never for the cold start this rule exists to cover, so it would not buy the case that matters.

All HTTP-making steps SHALL silently swallow HTTP errors (single-line stderr diagnostic) — provider failure SHALL NOT crash the host Hermes process.

#### Scenario: Context compression rotates session id

- **GIVEN** the provider is initialized with `self._session_id = "01OLD"` and slug `"foo"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=False)` mid-process
- **THEN** the provider SHALL POST `/api/foo/sessions/01OLD/end` with `{}`
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/foo/sessions` with `{"id":"01NEW","cwd":<cached>,"agent":"hermes"}`
- **AND** SHALL POST `/api/foo/sessions/01NEW/resume` with `{}`

#### Scenario: An in-place switch keeps the id and closes nothing

- **GIVEN** the provider holds `self._session_id = "01SAME"` and a resolved slug
- **WHEN** Hermes calls `on_session_switch(new_session_id="01SAME", parent_session_id="01SAME", reset=False)` (in-place compression), or `on_session_switch(new_session_id="01SAME", parent_session_id="", reset=False, rewound=True)` (`/undo` or the gateway rewind)
- **THEN** the provider SHALL NOT POST `/end` for `01SAME`
- **AND** `self._session_id` SHALL still be `"01SAME"`
- **AND** the ensure POST SHALL still be issued, and the resume SHALL be issued only if `01SAME` was not already in the provider's ensured-id set
- **AND** the control SHALL pass in the same run: the rotating case above DOES POST `/end`

#### Scenario: /reset switches with a populated parent lineage

- **GIVEN** the provider initialized with `self._session_id = "01OLD"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=True)` — the shape `/reset` and `/new` actually send, contrary to the retired claim that `parent_session_id` is empty there
- **THEN** the provider SHALL POST `/end` for `01OLD`, because the discriminator is the cached id and it differs from the new one
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/<slug>/sessions` with the new id, then the resume for it

#### Scenario: Switch when slug never resolved is a no-op

- **GIVEN** `initialize` ran with no resolvable slug (provider in degraded mode)
- **WHEN** Hermes calls `on_session_switch` for any reason
- **THEN** the provider SHALL only update `self._session_id` (no HTTP calls, including no resume)

#### Scenario: Switch from a suppressed context makes no HTTP calls for the new session either

- **GIVEN** the provider was initialized with `agent_context="cron"` (so `self._suppressed` is `True`), with `self._session_id = "01OLD"` and a resolved slug
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=False)`
- **THEN** the provider SHALL NOT POST `/end` for `01OLD`
- **AND** SHALL NOT POST `/sessions` for `01NEW`
- **AND** SHALL NOT POST the resume for `01NEW`
- **AND** SHALL still update `self._session_id = "01NEW"`

#### Scenario: The provider ignores `reason` and `rewound`

- **WHEN** Hermes calls `on_session_switch` with any `reason` value, with `rewound=True`, or with neither
- **THEN** the provider's HTTP behaviour SHALL be identical in all three cases for the same `(cached id, new id, slug, suppressed)` tuple
- **AND** the provider SHALL NOT read either keyword

#### Scenario: A cold-started Hermes session re-attaches its memories

- **GIVEN** session `<S>` was registered by a previous Hermes process and its row is now `ended` (`on_session_end` fired) or `abandoned` (the sweep retired it)
- **WHEN** a new Hermes process initializes against the same session id
- **THEN** `initialize` SHALL POST the ensure and then the resume, and the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** the control SHALL pass in the same run: without the resume the row stays terminal and a subsequent `memory.save` on that transport persists `session_id = NULL`

### Requirement: Hermes MCP bridge configuration

The documented and updater-generated `mcp_servers.rembric` entry SHALL use an exact `@rembric/mcp-bridge` pin, pass no URL or bearer argument, explicitly map `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`, and `REMBRIC_PROJECT_SLUG` into the MCP subprocess, and set `enabled: true`. `${HERMES_HOME:-~/.hermes}/.env` persists provider values, but MCP subprocesses SHALL NOT be documented as inheriting them implicitly.

On update, the installer SHALL back up and replace only its recognized legacy `mcp-remote` block or the exact incomplete npx bridge block it previously emitted. It SHALL leave canonical and custom Rembric blocks byte-for-byte unchanged and print the canonical block when manual configuration is required.

#### Scenario: Incomplete updater bridge entry is repaired

- **GIVEN** an exact-pinned npx bridge entry with no `env` or `enabled` field
- **WHEN** the Hermes updater runs
- **THEN** it SHALL preserve a backup and replace the entry with the canonical block

#### Scenario: Custom or canonical bridge entries are preserved

- **GIVEN** a custom or canonical Rembric MCP entry
- **WHEN** the Hermes updater runs
- **THEN** a custom entry SHALL remain unchanged and print the manual fallback; a canonical entry SHALL make no config write or backup
