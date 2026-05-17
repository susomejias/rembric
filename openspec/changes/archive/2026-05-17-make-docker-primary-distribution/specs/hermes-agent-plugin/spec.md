## MODIFIED Requirements

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` performs `GET ${REMBRIC_SERVER_URL}/healthz` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and a 2-second timeout, returning `True` only on HTTP 200. It SHALL return `False` if `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are unset, or if the request fails for any reason (including HTTP 401 when the token is invalid and HTTP 503 when the server's database is unavailable).
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

#### Scenario: is_available with both envs set and a healthy server returns True

- **GIVEN** `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are set
- **AND** `GET ${REMBRIC_SERVER_URL}/healthz` with the bearer header returns `200`
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `True`

#### Scenario: is_available with a missing token returns False without making a request

- **GIVEN** `REMBRIC_SERVER_URL` is set but `REMBRIC_API_TOKEN` is unset
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `False`
- **AND** the provider SHALL NOT issue any HTTP request

#### Scenario: is_available with an invalid token returns False

- **GIVEN** `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are set
- **AND** `GET ${REMBRIC_SERVER_URL}/healthz` with the bearer header returns `401`
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `False`

#### Scenario: is_available with the server's database unavailable returns False

- **GIVEN** `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are set
- **AND** `GET ${REMBRIC_SERVER_URL}/healthz` with the bearer header returns `503`
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `False`

#### Scenario: Session initialize POSTs to the sessions endpoint with agent: hermes

- **WHEN** Hermes starts a session and calls `provider.initialize(session_id="01XYZ", cwd="/home/user/repo")` with a resolvable slug `myproj`
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/myproj/sessions` with `Authorization: Bearer …` and body `{"id":"01XYZ","cwd":"/home/user/repo","agent":"hermes"}`
- **AND** the response is discarded
- **AND** the provider caches `slug="myproj"`, `session_id="01XYZ"`, `cwd="/home/user/repo"` for subsequent lifecycle calls
