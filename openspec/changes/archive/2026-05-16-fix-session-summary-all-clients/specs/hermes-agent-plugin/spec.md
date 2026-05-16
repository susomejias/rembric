## ADDED Requirements

### Requirement: Provider MUST override `on_session_switch` to rotate session ids cleanly

`RembricMemoryProvider` SHALL override `on_session_switch(new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs)`. Hermes fires this method on context compression, `/resume`, `/branch`, `/reset`, and `/new` — every path that reassigns `AIAgent.session_id` without tearing the provider down. Without overriding, our `self._session_id` becomes stale and all subsequent lifecycle posts target the wrong row.

Behaviour:

1. If `parent_session_id` matches the provider's cached `self._session_id` AND that cached session is registered with a resolved slug: `POST /api/<slug>/sessions/<parent_session_id>/end` with body `{}` to close the old row. Empty body — no summary write here, because `on_pre_compress` already wrote one when the compression happened (compression is the canonical trigger for this case).
2. Update `self._session_id = new_session_id`.
3. `POST /api/<slug>/sessions` with body `{"id": new_session_id, "cwd": <cached cwd or os.getcwd()>, "agent": "hermes"}` to register the new row. The server writes the placeholder title.
4. If `parent_session_id` is empty or does not match the cached id, only step 2 and 3 SHALL run (no old-session close). The branch covers `/reset` / `/new` where there's no continuation lineage to close.

All four steps SHALL silently swallow HTTP errors (single-line stderr diagnostic) — provider failure SHALL NOT crash the host Hermes process.

#### Scenario: Context compression rotates session id

- **GIVEN** the provider is initialized with `self._session_id = "01OLD"` and slug `"foo"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=False)` mid-process
- **THEN** the provider SHALL POST `/api/foo/sessions/01OLD/end` with `{}`
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/foo/sessions` with `{"id":"01NEW","cwd":<cached>,"agent":"hermes"}`

#### Scenario: /reset switches with no parent lineage

- **GIVEN** the provider initialized with `self._session_id = "01OLD"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", reset=True)` with empty `parent_session_id`
- **THEN** the provider SHALL NOT POST `/end` for the old id
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/<slug>/sessions` with the new id

#### Scenario: Switch when slug never resolved is a no-op

- **GIVEN** `initialize` ran with no resolvable slug (provider in degraded mode)
- **WHEN** Hermes calls `on_session_switch` for any reason
- **THEN** the provider SHALL only update `self._session_id` (no HTTP calls)

## MODIFIED Requirements

### Requirement: Plugin manifest declares lifecycle hooks

`plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (kept in lock-step with `plugin/.claude-plugin/plugin.json::version` and `plugin/.codex-plugin/plugin.json::version`), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued by 'rembric token create'."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt: `hermes plugins install` asks the user for the three values, writes them to `${HERMES_HOME:-~/.hermes}/.env` via `save_env_value`, and exports them into the running process's `os.environ`. On subsequent Hermes launches the same `.env` is loaded before plugins import. Subprocesses Hermes spawns from `mcp_servers.*` (including the bundled MCP bridge) inherit the same env.

The `hooks` array SHALL include `on_session_switch` (new addition) because the provider now overrides that method to rotate session ids on compression. Without listing it, Hermes does NOT call the override (the `hooks` array gates lifecycle method invocation).

#### Scenario: Manifest declares hooks and requires_env in lock-step

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress, on_session_switch]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for any of those not already set in the parent shell env
- **AND** answered values land in `${HERMES_HOME:-~/.hermes}/.env` (Hermes's standard env file) and become available to the plugin module at import time and to all `mcp_servers.*` subprocesses Hermes spawns

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` performs `GET ${REMBRIC_SERVER_URL}/healthz` with a 2-second timeout, returning `True` only on HTTP 200. It SHALL return `False` if `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are unset, or if the request fails for any reason.
- `initialize(session_id, **kwargs)` SHALL:
  - Resolve the project slug via the cascade defined in "Slug resolution cascade".
  - When a valid slug is resolved, `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, and body `{"id": session_id, "cwd": kwargs.get("cwd", os.getcwd()), "agent": "hermes"}`. Timeout 3 seconds. Discard response body. The server writes the placeholder title.
  - When no slug is resolvable, skip the POST and log a single-line stderr diagnostic of the form `[rembric] no project slug for session <session_id>; skipping session POST`. The provider SHALL still register; subsequent lifecycle calls SHALL silently skip their HTTP work.
  - Cache the resolved slug, session id, and cwd on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve.
- `on_pre_compress(messages, **kwargs)` SHALL, if a slug and session id were cached at `initialize`, build a textual transcript from `messages` via `_format_transcript(messages)` (oldest-first `role: content` lines, truncated from the head if the result exceeds 19,500 characters), and `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript>, "final": false}`. The provider SHALL NOT include `title` in this POST — title derivation is reserved for `on_session_end` and the server-side placeholder. Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT mutate the `messages` argument. The provider's return value SHALL be `""` (empty string — the docstring promises it goes into the compressor prompt; we contribute nothing yet).
- `on_session_end(messages, **kwargs)` SHALL, if a slug and session id were cached, build a transcript via `_format_transcript(messages)`, derive a title from the first non-empty assistant message in `messages` (truncated to 100 chars; falling back to empty string if no assistant message exists), and `POST /api/<slug>/sessions/<session_id>/end` with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`. When the transcript is empty (no messages), the body SHALL be `{}` (degraded end). Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT call `memory.session_end` over MCP.
- `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)` SHALL override per the "Provider MUST override on_session_switch" requirement.
- `get_tool_schemas` SHALL return `[]`. The provider contributes no agent-callable tools.
- `handle_tool_call(name, args)` SHALL return `json.dumps({"error": "unknown_tool", "hint": "register the rembric MCP bridge in mcp_servers.rembric to access memory tools"})`.
- `system_prompt_block` SHALL return a single-paragraph block (≤300 chars) directing the agent to call `memory.session_summary({title, summary})` before declaring work done. Title ≤100 chars descriptive of what was actually worked on; summary follows Goal · Discoveries · Accomplished · Next Steps · Files. This is the Hermes-side counterpart to Claude/Codex's `initialize.instructions` nudge.
- `prefetch(query, **kwargs)` SHALL return `""`.
- `queue_prefetch(query, **kwargs)` SHALL be a no-op (return `None`).
- `sync_turn(user, assistant, **kwargs)` SHALL be a no-op.
- `on_memory_write(action, target, content, **kwargs)` SHALL be a no-op.
- `shutdown(**kwargs)` SHALL be a no-op.

The provider SHALL NOT implement `get_config_schema` or `save_config`. Credentials live in `~/.hermes/.env`. The provider SHALL NOT preload any plugin-specific dotenv file.

#### Scenario: Session initialize POSTs to the sessions endpoint with agent: hermes

- **WHEN** Hermes starts a session and calls `provider.initialize(session_id="01XYZ", cwd="/home/user/repo")` with a resolvable slug `myproj`
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/myproj/sessions` with `Authorization: Bearer …` and body `{"id":"01XYZ","cwd":"/home/user/repo","agent":"hermes"}`
- **AND** the response is discarded
- **AND** the provider caches `slug="myproj"`, `session_id="01XYZ"`, `cwd="/home/user/repo"` for subsequent lifecycle calls

#### Scenario: Pre-compress posts a transcript summary

- **WHEN** `provider.on_pre_compress(messages=[...])` is called for an initialized session
- **THEN** the provider serializes messages to `role: content` lines (oldest-first), caps at 19,500 chars, and POSTs to `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with `{"summary":"<transcript>","final":false}`
- **AND** the body SHALL NOT include `title`
- **AND** the `messages` argument is NOT mutated by the provider
- **AND** the return value SHALL be `""`

#### Scenario: Session end posts to the end endpoint with summary and derived title

- **WHEN** Hermes ends the session and calls `provider.on_session_end(messages=[{role:"user",content:"hi"},{role:"assistant",content:"Fixed the auth bug; refactored login flow"}])` for an initialized session
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body containing `summary` = the formatted transcript, `title` = `"Fixed the auth bug; refactored login flow"` (or truncated to 100 chars), `final: false`
- **AND** the response is discarded

#### Scenario: Session end with empty messages degrades to `{}`

- **WHEN** `provider.on_session_end(messages=[])` is called
- **THEN** the provider POSTs `/end` with body `{}` (no summary, no title)
- **AND** the server transitions the row to `ended` with summary/title unchanged

#### Scenario: Session end when model already wrote a final summary

- **GIVEN** during the session the agent called `memory.session_summary({summary, title})` via the MCP bridge (server-side `summary_final = true`)
- **WHEN** `provider.on_session_end(messages)` posts `/end {summary, title, final: false}`
- **THEN** the server transitions the row to `ended` but the `final:false` writes are skipped due to precedence
- **AND** the model's summary and title SHALL remain intact

#### Scenario: Lifecycle calls without a resolved slug skip silently

- **WHEN** `provider.initialize(session_id="01XYZ", cwd="/tmp")` runs with no resolvable slug from any cascade source
- **THEN** the provider writes a single stderr diagnostic `[rembric] no project slug for session 01XYZ; skipping session POST`
- **AND** no HTTP request is issued
- **AND** subsequent calls to `on_pre_compress`, `on_session_end`, and `on_session_switch` skip silently without diagnostic spam

#### Scenario: system_prompt_block emits the session-close protocol

- **WHEN** Hermes calls `provider.system_prompt_block()`
- **THEN** the returned string SHALL be non-empty and SHALL contain the substring `memory.session_summary`
- **AND** SHALL contain a reference to `title` and the structure `Goal · Discoveries · Accomplished · Next Steps · Files`
- **AND** SHALL be ≤300 chars

#### Scenario: handle_tool_call returns a defensive error

- **WHEN** for any reason `provider.handle_tool_call(name="memory_save", args={})` is invoked
- **THEN** the provider returns the JSON string `{"error":"unknown_tool","hint":"register the rembric MCP bridge in mcp_servers.rembric to access memory tools"}`

#### Scenario: Provider does not manage credential storage

- **WHEN** Hermes inspects the provider's published surface
- **THEN** the provider does NOT override `get_config_schema` (default returns `[]`) and does NOT override `save_config` (default no-op)
- **AND** no `~/.hermes/rembric.json` file is created by the provider
