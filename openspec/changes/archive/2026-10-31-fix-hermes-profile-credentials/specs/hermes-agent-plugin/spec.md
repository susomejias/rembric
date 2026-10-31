## MODIFIED Requirements

### Requirement: Plugin manifest declares lifecycle hooks

`apps/plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (managed by the unified `plugin` release-please component via its `extra-files` updater — in lock-step with the other clients; all clients share the one `plugin` version), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three profile-scoped settings the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued from the Rembric dashboard at /dashboard/tokens."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt for the three values. Hermes owns their profile-scoped storage and resolution; the provider SHALL obtain them through `agent.secret_scope.get_secret`, not by reading dotenv files or process environment at import time. MCP subprocess configuration remains separate and SHALL use the explicit environment mappings required by "Hermes MCP bridge configuration".

The `hooks` array SHALL include `on_session_switch` because the provider now overrides that method to rotate session ids on compression. Without listing it, Hermes does NOT call the override (the `hooks` array gates lifecycle method invocation).

#### Scenario: Manifest declares hooks and requires_env

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress, on_session_switch]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for missing settings through Hermes's profile-scoped configuration flow
- **AND** the provider resolves those settings through `agent.secret_scope.get_secret` during availability checks and initialization, without import-time credential reads or implicit MCP subprocess inheritance

#### Scenario: Version is managed by the unified plugin release-please component

- **WHEN** a commit modifies any file under `apps/plugin/`
- **THEN** the unified `plugin` component SHALL stage a version bump for `apps/plugin/.hermes-plugin/plugin.yaml` (alongside every other client carrier)
- **AND** every client SHALL share the one `plugin` version (independent only of `server`)
- **AND** a `plugin-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` uses the initialized server/token binding when available; otherwise it resolves settings through `agent.secret_scope.get_secret`. It performs `GET ${REMBRIC_SERVER_URL}/healthz` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and a 2-second timeout, returning `True` only on HTTP 200. Missing required settings or scoped-secret API failures SHALL return `False` with a safe diagnostic. HTTP failures (including HTTP 401 when the token is invalid and HTTP 503 when the server's database is unavailable) SHALL continue to return `False`. The provider SHALL NOT fall back to process environment.
- `initialize(session_id, **kwargs)` SHALL:
  - Resolve `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and `REMBRIC_PROJECT_SLUG` through `agent.secret_scope.get_secret` and bind the server and token on the provider instance. Missing required settings or scoped-secret/thread APIs, or scope-resolution errors, SHALL produce safe diagnostics and skip affected requests without raising into Hermes or using process environment fallback.
  - Resolve the project slug via the cascade defined in "Slug resolution cascade order".
  - Read `kwargs.get("agent_context", "primary")` and cache `self._suppressed = agent_context in {"subagent", "cron", "flush"}` on the provider instance for the lifetime of the session. When suppressed, skip the session-creation POST below (same silent-skip pattern already used when no slug resolves) — the provider SHALL still register and cache the resolved slug/cwd, and `self._suppressed` SHALL gate every subsequent lifecycle call's HTTP work for this session (`sync_turn`, `on_pre_compress`, `on_session_end`, `on_session_switch`), not just this initial POST. When the kwarg is absent or `"primary"`, behavior is unchanged from before this requirement's revision.
  - When a valid slug is resolved AND the context is primary (or unspecified), `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, and body `{"id": session_id, "cwd": kwargs.get("cwd", os.getcwd()), "agent": "hermes"}`. Timeout 3 seconds. Discard response body. The server writes the placeholder title.
  - When no slug is resolvable, skip the POST and log a single-line stderr diagnostic of the form `[rembric] no project slug for session <session_id>; skipping session POST`. The provider SHALL still register; subsequent lifecycle calls SHALL silently skip their HTTP work.
  - Cache the resolved slug, session id, and cwd on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve. The initialized server, token and slug SHALL remain bound across session switches without re-reading secrets or process environment.
  - `initialize` SHALL NOT attempt to warm the prefetch cache: Hermes calls `prefetch` with the real first user message before `queue_prefetch` ever runs (`queue_prefetch` only warms the _next_ turn's cache), so there is no meaningful query available at `initialize` time. The first turn's `prefetch` call therefore returns `""` by construction — an accepted, documented at-most-one-turn-behind tradeoff, not a bug.
- `on_pre_compress(messages, **kwargs)` SHALL, if a slug and session id were cached at `initialize` AND `self._suppressed` is false, build a textual transcript from `messages` via `_format_transcript(messages)` (conversational roles ONLY — messages whose `role` is not `user` or `assistant`, e.g. `system` or tool payloads, SHALL be skipped; oldest-first `role: content` lines, truncated from the head if the result exceeds 20,000 characters — figure corrected from the prior spec's 19,500, which never matched the code's `_SUMMARY_MAX_CHARS = 20_000`; the server's 10,000-char cap remains the authoritative trimmer), and `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript>, "final": false}`. The provider SHALL NOT include `title` in THIS (compaction-path) POST; per-turn title derivation is handled by `sync_turn` (see below), and `on_session_end` plus the server-side placeholder cover the remaining cases. Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT mutate the `messages` argument. The provider's return value SHALL be `""` (empty string — the docstring promises it goes into the compressor prompt; we contribute nothing yet).
- `on_session_end(messages, **kwargs)` SHALL, if a slug and session id were cached AND `self._suppressed` is false, build a transcript via `_format_transcript(messages)` (same conversational-roles-only filtering as `on_pre_compress`), derive a title from the first non-empty assistant message in `messages` (truncated to 100 chars; falling back to empty string if no assistant message exists), and `POST /api/<slug>/sessions/<session_id>/end` with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`. When the transcript is empty (no messages), the body SHALL be `{}` (degraded end). Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT call `memory.session_end` over MCP.
- `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)` SHALL override per the "Provider MUST override on_session_switch to track the agent's current session id" requirement, including its suppression scenario.
- `get_tool_schemas` SHALL return `[]`. The provider contributes no agent-callable tools.
- `handle_tool_call(name, args)` SHALL return `json.dumps({"error": "unknown_tool", "hint": "register the rembric MCP bridge in mcp_servers.rembric to access memory tools"})`.
- `system_prompt_block` SHALL return the unified Rembric nudge — the SAME text as the server's `initialize.instructions` BASE (the SAVE/RECALL/SUMMARIZE flows defined by the `mcp-api` capability), kept byte-identical across the TS/Python boundary. It SHALL therefore direct the agent to SAVE proactively (`memory.save` the moment something noteworthy happens — with the required short `title` headline plus the `content`, and the `topic_key` supersede and `candidates[]`→`memory.judge` paths), RECALL on-demand (`memory.context`/`memory.search` when starting/resuming work, after `/compact`, or asked "what did we do", only if prior detail is missing), and SUMMARIZE at the end of every working turn (`memory.session_summary({title, summary})`, never ending a working turn silent — phrased as a calibrated imperative conditioned on real memorable work, the trigger SHALL NOT be bound to the literal word "done"; title ≤100 chars, NOT the cwd; summary uses exactly the separate-line Markdown headings `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`), plus the `memory.about` update pointer. The block SHALL be ≤1000 chars — a self-imposed token-budget ceiling matching the server's `INSTRUCTIONS_MAX_LENGTH`, NOT a Hermes contract: upstream `agent/memory_manager.py::build_system_prompt` joins provider blocks with no truncation or length cap. Hermes additionally exposes a real per-turn recall surface via `prefetch`/`queue_prefetch` (see below); `system_prompt_block` remains a necessary complementary surface because Hermes does NOT consume the MCP server's `initialize.instructions` block, and because the per-turn surface only carries recalled memory context, not the SAVE/SUMMARIZE protocol guidance.
- `prefetch(query, **kwargs)` SHALL return the provider's cached recall result for the current session (populated by `queue_prefetch`), formatted as a `<memory-context>...</memory-context>` block ready for injection, or `""` if no cache entry exists yet for the session. `prefetch` SHALL NOT make a network call — it only reads the in-memory cache.
- `queue_prefetch(query, **kwargs)` SHALL, given a cached slug and session id, `POST ${REMBRIC_SERVER_URL}/api/<slug>/memory/recall` with body `{"query": query, "limit": 5}` and a 3-second timeout, and on success cache the response's `formatted` string keyed by session id for the next `prefetch` call to read. Failures are silent stderr diagnostics and leave the prior cache entry (if any) in place. When no slug is resolvable, `queue_prefetch` SHALL be a no-op.
- `sync_turn(user, assistant, **kwargs)` SHALL, on EVERY call (no throttle, no modulo counter), if a slug and session id were cached AND `self._suppressed` is false, dispatch `POST /api/<slug>/sessions/<session_id>/summary` on a background thread with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`, where `<transcript>` is built via `_format_transcript` from the session's accumulated turns (same conversational-roles-only filtering) and `<derived_title>` is `_derive_title_from_messages(messages)` over the same accumulated turns (first non-empty assistant message, ≤100 chars). The `title` key SHALL be OMITTED from the body when the derivation yields an empty string (no assistant message yet). This per-turn title write gives Hermes parity with Claude Code, Codex, and opencode (which all send a derived title every turn) so the placeholder title is replaced from turn 1 even when `on_session_end` never fires; `final:false` keeps it subordinate to any later model-authored `final:true` title via `applyPrecedence`. Before starting a new background thread, IF the provider's previously-spawned sync thread (if any) `.is_alive()`, `.join(timeout=5.0)` it; THEN capture the initialized server, token, slug and session id, create an unstarted `daemon=True` worker through `agent.memory_provider.spawn_context_thread` targeting the POST work, and explicitly start it without joining. The worker SHALL use the captured binding for summary and turn requests even after the caller's scope exits or the instance switches sessions. Missing or failing thread APIs SHALL emit safe diagnostics and skip the work without raising into Hermes; no bare `threading.Thread` fallback SHALL exist. Inside that background thread, the provider SHALL attempt to acquire its sync lock with `timeout=5.0`; if the acquire fails (a prior POST is still in flight past the timeout), the thread SHALL return WITHOUT building the transcript or POSTing — it SHALL NOT proceed unsynchronized, and it SHALL NOT release a lock it never acquired. A skipped write here is not a lost write: the next `sync_turn` call resends the full accumulated transcript. This follows Hermes's documented threading contract for context-preserving provider-initiated background work. Timeout on the POST itself remains 3 seconds; failures are silent stderr diagnostics, observed only by whichever thread's join (if any) surfaces them.
- `on_memory_write(action, target, content, **kwargs)` SHALL be a no-op.
- `shutdown(**kwargs)` SHALL be a no-op.

The provider SHALL NOT implement `get_config_schema` or `save_config`. Hermes owns credential storage; the provider SHALL use its initialized profile-scoped binding for lifecycle HTTP work and SHALL NOT preload any dotenv file. Diagnostics SHALL NOT include raw exception text, response bodies or credentials.

#### Scenario: is_available with both envs set and a healthy server returns True

- **GIVEN** scoped server and token settings and a healthy server
- **WHEN** `is_available` checks the authenticated `/healthz` endpoint
- **THEN** it SHALL return `True` using the scoped settings, ignoring decoy process environment values

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
- **THEN** exactly one background worker SHALL be created through `agent.memory_provider.spawn_context_thread` and explicitly started targeting `POST /api/<slug>/sessions/<session_id>/summary`
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

### Requirement: Slug resolution cascade order

The provider SHALL resolve the project slug in `initialize` using this strict precedence chain. The chain SHALL stop at the first source that yields a slug that matches the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (identical to the bridge's regex in `apps/plugin/mcp-bridge/`):

1. The `PROJECT_SLUG` value parsed from `<kwargs.cwd>/.rembric`, using the same dotenv-style parser as the bridge: trim whitespace, skip blank lines and lines starting with `#`, accept `KEY=VALUE`, and strip matched outer single or double quotes from the value.
2. `REMBRIC_PROJECT_SLUG` resolved through `agent.secret_scope.get_secret` at initialization — a profile-scoped fallback default for a cwd that has no valid `.rembric` slug.
3. `None` — degraded mode, session initialization emits a diagnostic and all session-related POSTs are skipped. The server URL SHALL NOT supply a fallback slug.

This order matches the `requires_env` manifest's own description of `REMBRIC_PROJECT_SLUG` ("Default project slug. Overridden per-cwd if a .rembric file is present.") — a user who sets the scoped default once via Hermes and then works across multiple repos, each with its own `.rembric`, gets correct per-repo project scoping instead of every repo silently collapsing onto the one profile-configured project. Process environment SHALL NOT be consulted as a fallback source.

The resolved slug SHALL be validated against the slug regex; non-matching candidates SHALL be discarded and the cascade continues to the next source. The provider SHALL NOT walk parent directories looking for `.rembric` — only the literal `cwd` is checked.

#### Scenario: .rembric wins over env

- **WHEN** scoped `REMBRIC_PROJECT_SLUG=alpha` is set and `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`
- **THEN** the provider resolves the slug as `gamma`

#### Scenario: env wins when no .rembric file is present

- **WHEN** `<cwd>/.rembric` does not exist, scoped `REMBRIC_PROJECT_SLUG=alpha` is set, and scoped `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `alpha`

#### Scenario: URL path is not a slug source

- **WHEN** `.rembric` and the scoped default slug are both absent, and scoped `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves no slug and skips session POSTs

#### Scenario: Invalid candidate is skipped

- **WHEN** `<cwd>/.rembric` contains `PROJECT_SLUG=Has_Underscores` (does not match the slug regex) and scoped `REMBRIC_PROJECT_SLUG=gamma` is set
- **THEN** the provider rejects the `.rembric` value and resolves the slug as `gamma`

#### Scenario: All sources empty yields None

- **WHEN** no source produces a valid slug
- **THEN** the provider's resolved slug is `None`
- **AND** all session-related POSTs in subsequent lifecycle calls are skipped silently

## ADDED Requirements

### Requirement: Hermes provider credentials are exclusively profile scoped

The provider SHALL resolve `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and `REMBRIC_PROJECT_SLUG` through `agent.secret_scope.get_secret` during initialization and bind the values on the provider instance. Availability checks SHALL use scoped credentials for the existing authenticated `/healthz` request. Initialized instances SHALL retain their server, token and resolved slug across lifecycle hooks and session switches, without re-reading secrets or process environment. No profile-specific module/class globals or shared slug cache SHALL exist. A valid `<cwd>/.rembric` slug SHALL take priority over the scoped default, using the existing regex. The provider SHALL NOT add credential-storage methods or preload dotenv files.

Missing required secrets, missing scoped-secret/thread APIs or scope-resolution errors SHALL produce safe visible diagnostics, skip affected requests and never raise into the host. Diagnostics SHALL NOT include raw exception text, response bodies or credentials. No `os.environ` fallback for any REMBRIC setting SHALL exist, even when `agent.secret_scope` is absent. This is an intentional compatibility break: unsupported Hermes versions SHALL require updating rather than using default-profile credentials.

#### Scenario: Two instances share a module but not credentials

- **WHEN** two instances initialize under different scoped secrets with decoy REMBRIC process environment values
- **THEN** each instance's health, session creation/resume, recall, compression, turn, switch and end requests SHALL use its own credentials
- **AND** identical slugs with different servers or tokens SHALL remain isolated

#### Scenario: Scoped resolution is unavailable

- **WHEN** required secrets are missing, scoped resolution raises, or required Hermes APIs are absent
- **THEN** affected requests SHALL be skipped and a safe diagnostic SHALL be visible
- **AND** process environment values SHALL NOT rescue the request and no exception SHALL escape into Hermes
