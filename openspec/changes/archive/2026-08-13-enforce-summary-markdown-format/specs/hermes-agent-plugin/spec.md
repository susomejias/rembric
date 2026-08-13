## MODIFIED Requirements

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
