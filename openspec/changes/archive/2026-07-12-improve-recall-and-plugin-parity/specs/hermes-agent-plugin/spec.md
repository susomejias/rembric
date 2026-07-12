## MODIFIED Requirements

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` performs `GET ${REMBRIC_SERVER_URL}/healthz` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and a 2-second timeout, returning `True` only on HTTP 200. It SHALL return `False` if `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are unset, or if the request fails for any reason (including HTTP 401 when the token is invalid and HTTP 503 when the server's database is unavailable).
- `initialize(session_id, **kwargs)` SHALL:
  - Resolve the project slug via the cascade defined in "Slug resolution cascade".
  - Read `kwargs.get("agent_context", "primary")`. When the value is an explicit non-primary context (`"subagent"`, `"cron"`, `"flush"`), skip the session-creation POST below (same silent-skip pattern already used when no slug resolves) — the provider SHALL still register and cache the resolved slug/cwd, and subsequent lifecycle calls within that session SHALL behave normally. When the kwarg is absent or `"primary"`, behavior is unchanged from before this requirement's revision.
  - When a valid slug is resolved AND the context is primary (or unspecified), `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, and body `{"id": session_id, "cwd": kwargs.get("cwd", os.getcwd()), "agent": "hermes"}`. Timeout 3 seconds. Discard response body. The server writes the placeholder title.
  - When no slug is resolvable, skip the POST and log a single-line stderr diagnostic of the form `[rembric] no project slug for session <session_id>; skipping session POST`. The provider SHALL still register; subsequent lifecycle calls SHALL silently skip their HTTP work.
  - Cache the resolved slug, session id, and cwd on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve.
  - `initialize` SHALL NOT attempt to warm the prefetch cache: Hermes calls `prefetch` with the real first user message before `queue_prefetch` ever runs (`queue_prefetch` only warms the *next* turn's cache), so there is no meaningful query available at `initialize` time. The first turn's `prefetch` call therefore returns `""` by construction — an accepted, documented at-most-one-turn-behind tradeoff, not a bug.
- `on_pre_compress(messages, **kwargs)` SHALL, if a slug and session id were cached at `initialize`, build a textual transcript from `messages` via `_format_transcript(messages)` (oldest-first `role: content` lines, truncated from the head if the result exceeds 19,500 characters), and `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript>, "final": false}`. The provider SHALL NOT include `title` in this POST — title derivation is reserved for `on_session_end` and the server-side placeholder. Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT mutate the `messages` argument. The provider's return value SHALL be `""` (empty string — the docstring promises it goes into the compressor prompt; we contribute nothing yet).
- `on_session_end(messages, **kwargs)` SHALL, if a slug and session id were cached, build a transcript via `_format_transcript(messages)`, derive a title from the first non-empty assistant message in `messages` (truncated to 100 chars; falling back to empty string if no assistant message exists), and `POST /api/<slug>/sessions/<session_id>/end` with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`. When the transcript is empty (no messages), the body SHALL be `{}` (degraded end). Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT call `memory.session_end` over MCP.
- `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)` SHALL override per the "Provider MUST override on_session_switch" requirement.
- `get_tool_schemas` SHALL return `[]`. The provider contributes no agent-callable tools.
- `handle_tool_call(name, args)` SHALL return `json.dumps({"error": "unknown_tool", "hint": "register the rembric MCP bridge in mcp_servers.rembric to access memory tools"})`.
- `system_prompt_block` SHALL return the unified Rembric nudge — the SAME text as the server's `initialize.instructions` BASE (the SAVE/RECALL/SUMMARIZE flows defined by the `mcp-api` capability), kept byte-identical across the TS/Python boundary. It SHALL therefore direct the agent to SAVE proactively (`memory.save` the moment something noteworthy happens — with the required short `title` headline plus the `content`, and the `topic_key` supersede and `candidates[]`→`memory.judge` paths), RECALL on-demand (`memory.context`/`memory.search` when starting/resuming work, after `/compact`, or asked "what did we do", only if prior detail is missing), and SUMMARIZE at the end of every working turn (`memory.session_summary({title, summary})`, never ending a working turn silent — the trigger SHALL NOT be bound to the literal word "done"; title ≤100 chars, NOT the cwd; summary follows Goal · Discoveries · Accomplished · Next Steps · Files), plus the `memory.about` update pointer. The block SHALL be ≤1000 chars — a self-imposed token-budget ceiling matching the server's `INSTRUCTIONS_MAX_LENGTH`, NOT a Hermes contract: upstream `agent/memory_manager.py::build_system_prompt` joins provider blocks with no truncation or length cap. Hermes additionally exposes a real per-turn recall surface via `prefetch`/`queue_prefetch` (see below); `system_prompt_block` remains a necessary complementary surface because Hermes does NOT consume the MCP server's `initialize.instructions` block, and because the per-turn surface only carries recalled memory context, not the SAVE/SUMMARIZE protocol guidance.
- `prefetch(query, **kwargs)` SHALL return the provider's cached recall result for the current session (populated by `queue_prefetch`), formatted as a `<memory-context>...</memory-context>` block ready for injection, or `""` if no cache entry exists yet for the session. `prefetch` SHALL NOT make a network call — it only reads the in-memory cache.
- `queue_prefetch(query, **kwargs)` SHALL, given a cached slug and session id, `POST ${REMBRIC_SERVER_URL}/api/<slug>/memory/recall` with body `{"query": query, "limit": 5}` and a 3-second timeout, and on success cache the response's `formatted` string keyed by session id for the next `prefetch` call to read. Failures are silent stderr diagnostics and leave the prior cache entry (if any) in place. When no slug is resolvable, `queue_prefetch` SHALL be a no-op.
- `sync_turn(user, assistant, **kwargs)` SHALL increment an in-provider per-session turn counter and, every 5th call (`turn_count % 5 == 0`), if a slug and session id were cached, `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript built from the session's accumulated turns>, "final": false}`, timeout 3 seconds, failures silent. On calls where the counter is not a multiple of 5, `sync_turn` SHALL be a no-op beyond incrementing the counter.
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
- **AND** SHALL contain a reference to `title` and the structure `Goal · Discoveries · Accomplished · Next Steps · Files`
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

#### Scenario: sync_turn only POSTs every fifth call

- **GIVEN** a resolved slug and session id
- **WHEN** `sync_turn` is called 4 times in a row for the same session
- **THEN** no HTTP request SHALL be issued
- **WHEN** `sync_turn` is called a 5th time
- **THEN** exactly one `POST /api/<slug>/sessions/<session_id>/summary` SHALL be issued

#### Scenario: initialize skips session creation for a subagent context

- **GIVEN** `initialize(session_id, agent_context="subagent", ...)` is called with a resolvable slug
- **THEN** the provider SHALL NOT POST to `/api/<slug>/sessions`
- **AND** the provider SHALL still cache the resolved slug and register normally for subsequent lifecycle calls

#### Scenario: initialize creates a session when agent_context is absent or primary

- **GIVEN** `initialize(session_id, ...)` is called with no `agent_context` kwarg (or `agent_context="primary"`) and a resolvable slug
- **THEN** the provider SHALL POST to `/api/<slug>/sessions` exactly as before this requirement's revision
