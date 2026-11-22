# hermes-agent-plugin Specification

## Purpose

TBD - created by archiving change add-hermes-agent-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to the other client manifest directories. The directory SHALL contain `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh` and `README.md`, and MAY contain a nested Python `tests/` directory. Native Hermes SHALL own installation of this source subdirectory; Rembric SHALL NOT maintain a three-file copy whitelist or a second packaging path. Maintenance scripts SHALL delegate distribution to the native CLI while retaining recognized legacy MCP repair.

#### Scenario: Plugin tree contains the five top-level files

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.hermes-plugin/` SHALL contain `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, and `README.md`
- **AND** Python test sources MAY live in its nested `tests/` directory
- **AND** native installation MAY ship that subtree without a Rembric file-copy whitelist

#### Scenario: Plugin subtree is natively installable

- **WHEN** Hermes installs `susomejias/rembric/apps/plugin/.hermes-plugin`
- **THEN** the installed plugin SHALL retain manifest name `rembric` and the unified plugin version
- **AND** Rembric SHALL NOT promise that scripts/tests are excluded from the native-installed subtree

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
- `system_prompt_block` SHALL return the unified Rembric nudge — the SAME text as the server's `initialize.instructions` BASE (the SAVE/RECALL/SUMMARIZE flows defined by the `mcp-api` capability), kept byte-identical across the TS/Python boundary. It SHALL therefore direct the agent to SAVE proactively (`memory.save` the moment something noteworthy happens — with the required short `title` headline plus the `content`, and the `topic_key` supersede and `candidates[]`→`memory.judge` paths), RECALL on-demand (`memory.context`/`memory.search` when starting/resuming work, after `/compact`, or asked "what did we do", only if prior detail is missing), and SUMMARIZE at the end of every working turn (`memory.session_summary({title, summary})`, never ending a working turn silent — phrased as a calibrated imperative conditioned on real memorable work, the trigger SHALL NOT be bound to the literal word "done"; title ≤100 chars, NOT the cwd; summary uses exactly the separate-line Markdown headings `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`), plus the `memory.about` update pointer. The block SHALL be ≤1500 chars — a self-imposed token-budget ceiling matching the server's `INSTRUCTIONS_MAX_LENGTH`, NOT a Hermes contract: upstream `agent/memory_manager.py::build_system_prompt` joins provider blocks with no truncation or length cap. Hermes additionally exposes a real per-turn recall surface via `prefetch`/`queue_prefetch` (see below); `system_prompt_block` remains a necessary complementary surface because Hermes does NOT consume the MCP server's `initialize.instructions` block, and because the per-turn surface only carries recalled memory context, not the SAVE/SUMMARIZE protocol guidance.
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
- **AND** SHALL be ≤1500 chars total (self-imposed budget matching the server's `INSTRUCTIONS_MAX_LENGTH`; Hermes applies no truncation)

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

### Requirement: Version coupling with other client manifests

The `version` in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL remain managed by the single unified `plugin` release-please component covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`, via its `extra-files` updater. All five clients SHALL share that version. There SHALL be no separate Hermes release component, node-workspace cascade or registry publication introduced by this change. Contributor guidance SHALL retain the two-track server/plugin model. Hermes SHALL obtain provider updates through native source tracking rather than repeated file-copy installer fetches; its MCP bridge and exact pins SHALL retain their separate existing contract.

#### Scenario: A Hermes-only change bumps the unified plugin component

- **WHEN** a `fix:` commit changes only the Hermes subtree
- **THEN** release-please SHALL update all plugin carriers together, without rebuilding the server or creating a separate Hermes tag

#### Scenario: A shared-bin change bumps the one plugin version

- **WHEN** a `feat:` commit modifies `apps/plugin/mcp-bridge/`
- **THEN** the single plugin version SHALL move for all clients
- **AND** native Hermes provider distribution SHALL not silently change a complete current MCP pin

#### Scenario: A change to a registry-published client still bumps Hermes's carrier

- **WHEN** only Pi changes
- **THEN** Hermes's version carrier SHALL still move in the unified plugin release, with client-specific change attribution

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

1. The `PROJECT_SLUG` value parsed from the nearest `.rembric` at or above `<kwargs.cwd>`, stopping after the checkout root when `<kwargs.cwd>` is inside a git work tree and checking only `<kwargs.cwd>` outside one, using the same dotenv-style parser as the bridge: trim whitespace, skip blank lines and lines starting with `#`, accept `KEY=VALUE`, and strip matched outer single or double quotes from the value.
2. `REMBRIC_PROJECT_SLUG` resolved through `agent.secret_scope.get_secret` at initialization — a profile-scoped fallback default for a cwd that has no valid `.rembric` slug.
3. Inside a git work tree only: the slug `POST /api/repositories/resolve` returns for the repository's fingerprint, computed and resolved as the `repository-binding` capability specifies.
4. `None` — degraded mode, session initialization emits a diagnostic and all session-related POSTs are skipped. The server URL SHALL NOT supply a fallback slug. An unbound, ambiguous or unavailable fingerprint outcome SHALL also end here, with the diagnostic naming that outcome.

This order matches the `requires_env` manifest's own description of `REMBRIC_PROJECT_SLUG` ("Default project slug. Overridden per-cwd if a .rembric file is present.") — a user who sets the scoped default once via Hermes and then works across multiple repos, each with its own `.rembric`, gets correct per-repo project scoping instead of every repo silently collapsing onto the one profile-configured project. Process environment SHALL NOT be consulted as a fallback source.

The resolved slug SHALL be validated against the slug regex; non-matching candidates SHALL be discarded and the cascade continues to the next source. The provider SHALL resolve once, in `initialize`, and SHALL keep the outcome for the session.

#### Scenario: .rembric wins over env

- **WHEN** scoped `REMBRIC_PROJECT_SLUG=alpha` is set and `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`
- **THEN** the provider resolves the slug as `gamma`

#### Scenario: env wins when no .rembric file is present

- **WHEN** `<cwd>/.rembric` does not exist, scoped `REMBRIC_PROJECT_SLUG=alpha` is set, and scoped `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `alpha`

#### Scenario: URL path is not a slug source

- **WHEN** `.rembric` and the scoped default slug are both absent, `<kwargs.cwd>` is outside any git work tree, and scoped `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves no slug and skips session POSTs

#### Scenario: Invalid candidate is skipped

- **WHEN** `<cwd>/.rembric` contains `PROJECT_SLUG=Has_Underscores` (does not match the slug regex) and scoped `REMBRIC_PROJECT_SLUG=gamma` is set
- **THEN** the provider rejects the `.rembric` value and resolves the slug as `gamma`

#### Scenario: All sources empty yields None

- **WHEN** no source produces a valid slug
- **THEN** the provider's resolved slug is `None`
- **AND** all session-related POSTs in subsequent lifecycle calls are skipped silently

#### Scenario: A `.rembric` at the checkout root applies to a subdirectory

- **WHEN** `<kwargs.cwd>` is `/work/shop/src` inside a checkout rooted at `/work/shop`, and `/work/shop/.rembric` contains `PROJECT_SLUG=shop`
- **THEN** the provider resolves the slug as `shop`

#### Scenario: A bound fingerprint resolves when no slug source is set

- **WHEN** `<kwargs.cwd>` is inside a git checkout with no `.rembric`, no scoped `REMBRIC_PROJECT_SLUG` is set, and the resolve endpoint answers `bound` with slug `shop`
- **THEN** the provider resolves the slug as `shop`

#### Scenario: An unbound fingerprint skips session POSTs

- **WHEN** `<kwargs.cwd>` is inside a git checkout with no slug source and the resolve endpoint answers `unbound`
- **THEN** the provider's resolved slug is `None`, its diagnostic names the unbound repository, and all session-related POSTs are skipped

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

### Requirement: Hermes SAVE guidance MUST teach required memory tags

The SAVE clause of `system_prompt_block` SHALL include required `tags` alongside `title` and `content`, teaching normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`. This scoped requirement supplements the SAVE clause in "Provider lifecycle method behavior": its `title` plus `content` wording is not an exhaustive input schema and SHALL NOT be interpreted as permitting tagless operational saves.

The block SHALL remain byte-identical to the server's `initialize.instructions` BASE and within the 1500-character cap. All existing RECALL, SUMMARIZE, session-id, and update guidance obligations remain in effect. `topic_key` SHALL remain optional. Choosing tags SHALL NOT require another tool/call, a catalog, or an alias lookup. No lifecycle, installer, distribution, or release behavior changes are required.

#### Scenario: Hermes guidance matches the server and teaches labels

- **WHEN** the provider's system prompt block and server BASE guidance are compared
- **THEN** they SHALL be byte-identical, include required memory tags and the normally 1–5 reusable lowercase kebab-case guidance, and fit within 1500 characters
- **AND** existing protocol-flow assertions SHALL still pass without new calls or expanded recall payloads

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

### Requirement: The Hermes plugin SHALL append file-anchored recall through the documented result-transform hooks

Hermes' `pre_tool_call` can only block, ask for approval or modify args, and it fails closed on timeout or exception. It SHALL NOT be used. These rules follow the hooks guide at hermes-agent v0.22.5, `website/docs/user-guide/features/hooks.md`.

**Registration:** the plugin's `register(ctx)` SHALL register, through `ctx.register_hook`, both hooks below.

**`transform_tool_result`, for the file tools**

- The documentation describes this hook as rewriting "ANY tool's result string … before the model sees it" and lists "inject retrieval-augmented hints into `read_file` results" as a use case. Its return contract: "The first `str` replaces the result … `None` leaves it unchanged".
- It SHALL take the paths from the tool's args.

**`transform_terminal_output`, for terminal commands**

- This hook receives `command`.
- It SHALL take the paths from `command` through the plugin's own Python extractor, which agrees with `file-recall-fixtures.json`.

**Working directory:** Python hook callbacks receive no `cwd`. The working directory SHALL be the `cwd` the memory provider received in `initialize()`.

**What the hooks return:** each hook SHALL return the original result with the rendered lines appended, or `None` when there is nothing to add. When the result is a JSON string, it SHALL stay valid JSON in the form the tool produced: the lines go into a field the model reads. The exact form SHALL be fixed by a spike against the installed Hermes before implementation, and recorded in `tasks.md` and in the plugin source.

**Failure:** any exception SHALL be caught inside the callback and turned into `None`.

#### Scenario: A file read is annotated

- **GIVEN** an eligible memory linked to `src/app.ts`, and Hermes running in that repository with the Rembric plugin
- **WHEN** the agent's `read_file` tool reads `src/app.ts`
- **THEN** the result the model sees SHALL contain `rembric: memories about src/app.ts:` followed by the memory's line
- **AND** the control SHALL pass in the same run: with the server unreachable, the result SHALL be byte-identical to the tool's own output

#### Scenario: A terminal read is annotated

- **WHEN** the agent's terminal tool runs `sed -n 1,20p src/app.ts`
- **THEN** the terminal output the model sees SHALL carry the same rendered lines, once per session

### Requirement: Conversational curation reinforcement MUST reuse server notices without falsifying tool observations

The provider SHALL retain last-turn tool observation, including the existing missing-messages fail-open, and SHALL NOT report `usedTools:true` merely because a chat should be summarized. Completed conversation SHALL reach the same `/turn` endpoint as other work. The server SHALL own conversational eligibility and the single floor (`session-nudges`). No provider-specific cadence, curation-complete state, summary-response inspection or new reminder wording SHALL be introduced.

`sync_turn` SHALL retain its supported `**kwargs` signature, context-preserving asynchronous worker, captured credential/session binding, RAW transcript POST and subsequent turn report. `prefetch` SHALL remain network-free and consume returned lines once, verbatim apart from the established wrapper, with the known explicit session ID before a write directive. Empty report responses SHALL NOT erase a pending notice. A report finishing after prefetch SHALL remain eligible for delivery at a later prefetch, without blocking the current user turn or forcing a continuation.

Opening, resumed-read, post-compaction and urgent instructions SHALL retain existing behavior. Lifecycle summaries SHALL remain `final:false`; only the model's successful curated MCP write supplies `final:true`. Primary registration and ensure/resume ordering before MCP writes SHALL remain intact. Suppressed subagent, cron and flush contexts SHALL remain suppressed; legitimate primary bot conversations SHALL NOT be blanket-suppressed.

#### Scenario: A chat-only completed turn delivers a server notice

- **GIVEN** an unsuppressed provider receiving a completed user/assistant turn without tools
- **WHEN** its report returns notice lines after the server floor permits
- **THEN** the report SHALL carry `usedTools:false` and RAW writes SHALL remain non-final
- **AND** a subsequent prefetch SHALL emit the exact server lines with the real session ID, once

#### Scenario: A late asynchronous response is delivered later, not lost or forced

- **GIVEN** a blocked turn-report response and an intervening prefetch
- **WHEN** the response later supplies notice lines
- **THEN** a later prefetch SHALL deliver them exactly once
- **AND** the early prefetch SHALL NOT block, invent lines or force another model turn

#### Scenario: Empty server lines do not erase an undelivered notice

- **GIVEN** cached nonempty notice lines
- **WHEN** a later report returns an empty array before consumption
- **THEN** the original pending lines SHALL survive and be printed once

### Requirement: Empty-session registration or flush changes MUST be gated by actual gateway evidence

A primary ensure before content SHALL NOT alone be treated as proof of the cause of reported empty bot sessions. Before changing registration or transcript flushing, acceptance evidence SHALL identify the actual host/gateway and plugin revisions and reproduce the failing route with synthetic content, hook dispatch, context, session IDs, request outcomes and stored rows. The same run SHALL include a completed-chat positive control and non-primary suppression control.

Any resulting adapter change SHALL use a supported hook demonstrated on that host, preserve ensure-before-MCP attribution, explicit IDs, scoped credentials and `final:false` fallback. Cache eviction, idle release, same-ID recreation and `shutdown` SHALL NOT be interpreted as a conversation boundary. A continuing session SHALL NOT receive `/end` merely because an agent object was discarded. No historical deletion, blanket bot suppression, server LLM or forced continuation SHALL be used to hide the symptom. Where no supported correction is demonstrated, the result SHALL remain an explicitly pending host limitation rather than a claimed fix.

#### Scenario: A provider-only probe does not establish the deployed empty-session cause

- **GIVEN** a mock showing primary initialize creates a row before content
- **WHEN** gateway acceptance is assessed without the actual deployment revision and hook trace
- **THEN** the empty-session cause and remedy SHALL remain unverified
- **AND** no registration or flush patch SHALL be justified by that mock alone

#### Scenario: Soft release is not end of conversation

- **GIVEN** the host soft-releases a cached agent and later recreates a provider for the same ID
- **WHEN** shutdown or recreation occurs without a real conversation boundary
- **THEN** the provider SHALL NOT invent a new session ID or end the continuing row for that reason
- **AND** normal ensure/resume and existing resumed-read guidance SHALL preserve attachment

#### Scenario: A registration change must protect the first MCP write

- **GIVEN** a reproduced registration-only path and a proposed registration change
- **WHEN** the completed-chat control makes its first MCP summary or memory write
- **THEN** the actual session row SHALL already be ensured/resumed and the write SHALL attach to that explicit ID
- **AND** failure of that control SHALL reject the registration change

### Requirement: Hermes native distribution contract

Hermes installation SHALL delegate to `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable`, update to `hermes plugins update rembric`, and uninstall to `hermes plugins remove rembric`. The canonical root TUI SHALL remain the primary entry point. No file-copy fallback, automatic `adopt`, forced replacement or scan/dependency-consent bypass SHALL be added. Native failures SHALL propagate.

#### Scenario: Fresh native installation

- **WHEN** an operator consents to native install with no existing target
- **THEN** Hermes SHALL own installation and source metadata for `rembric`
- **AND** Rembric SHALL NOT copy provider files itself

#### Scenario: Native update failure

- **WHEN** the native update command fails
- **THEN** Rembric SHALL return failure without reporting successful installation or executing legacy MCP repair

### Requirement: Copied installs require explicit operator transition

Native update/removal SHALL require canonical unpinned source metadata and a non-linked target. Explicit update MAY instead migrate a recognized legacy Rembric copy after separate interactive confirmation that Hermes gateway/CLI sessions and automatic restarts are stopped. Ordinary `--yes` SHALL NOT grant migration consent. Recognition SHALL require the old regular manifest/provider/README files, Rembric manifest identity and provider class, with no source record or Git metadata. Unknown, linked, foreign-source, pinned, malformed or inconsistent targets SHALL remain refused. The adapter SHALL inspect processes conservatively and refuse activity or unavailable inspection; it SHALL NOT stop/restart Hermes. The operator SHALL keep Hermes stopped throughout migration. A verified private full backup outside plugin discovery SHALL precede moving the old directory aside. Native install SHALL own new files; old unknown files SHALL remain in backup, not be overlaid. Failed installation or verification SHALL restore the previous directory/configuration and retain evidence only when no native publication journal remains, dependency selection is unchanged and Hermes remains stopped. Otherwise it SHALL preserve the backup and migration lock, report manual recovery required, and never restore a tree that a pending native journal could subsequently delete. Concurrent migration SHALL be refused. No force/adopt or alternate copy-install backend SHALL be introduced.

#### Scenario: Copied directory contains unknown local data

- **WHEN** explicit update encounters a recognized legacy Rembric copy with an operator file and the stopped-host operator confirms migration
- **THEN** it SHALL retain the entire old directory in a verified private backup outside plugins and delegate installation to Hermes
- **AND** it SHALL verify native source metadata before success without overwriting the new provider with old files

#### Scenario: Migration is not unattended

- **WHEN** migration lacks its specific interactive confirmation, Hermes is active, inspection fails, or another migration holds the lock
- **THEN** no plugin or configuration mutation SHALL occur, even with ordinary `--yes`

#### Scenario: Native migration fails

- **WHEN** native installation fails or returns success without valid canonical source metadata, with no pending publication, changed dependency selection or renewed activity
- **THEN** the adapter SHALL return failure, restore the old directory and configuration, retain its backup, and omit success/restart claims

#### Scenario: Native recovery remains pending

- **WHEN** native publication remains pending, dependency selection changes or Hermes starts during failure recovery
- **THEN** the adapter SHALL preserve the backup and lock, require manual recovery with Hermes stopped, and SHALL NOT restore over uncertain native state

#### Scenario: Native pinned or foreign install

- **WHEN** a native source record is pinned or does not match the canonical source
- **THEN** Rembric SHALL refuse mutation rather than silently unpin or replace the source

### Requirement: Native ownership and conservative state preservation

The user-approved native contract SHALL permit Hermes to select/reset `memory.provider`, manage plugin selection/grants and remove the entire native-managed plugin directory. Unrelated config values, MCP settings, exact bridge pins, credentials outside that directory and `.rembric` project markers SHALL remain preserved. Rembric SHALL NOT perform a general config rewrite. An untracked/linked directory SHALL NOT be silently removed. Repeated uninstall SHALL be a successful no-op only when both target and native source record are absent; inconsistent state SHALL fail visibly.

#### Scenario: Native uninstall of a managed install

- **WHEN** a consenting operator uninstalls a native-managed Rembric plugin
- **THEN** Hermes SHALL own whole-directory removal and selection/grant cleanup
- **AND** unrelated settings, MCP bridge configuration, credentials and project markers SHALL remain intact

#### Scenario: Already absent installation

- **WHEN** uninstall finds neither a Rembric directory nor its native source record
- **THEN** it SHALL return success without invoking a failing native removal

### Requirement: Recognized legacy MCP repair survives native distribution

After successful native update, the existing recognition and backup rules for legacy MCP repair SHALL remain available. The recognized legacy transport block and incomplete bridge block SHALL receive the existing repair, with a backup written before mutation. Unrecognized/current MCP blocks SHALL remain untouched. This change SHALL NOT broaden repair patterns, replace the MCP transport, alter current bridge pins or introduce new tool wiring.

#### Scenario: Recognized legacy block on native update

- **WHEN** native update succeeds and the existing legacy migration recognizes the MCP block
- **THEN** the existing backup-and-repair behavior SHALL run
- **AND** unrelated configuration SHALL be preserved

#### Scenario: Current pinned MCP block

- **WHEN** native install/update/remove encounters a complete current MCP block
- **THEN** its package pin and explicit environment mappings SHALL remain unchanged

### Requirement: Native distribution documentation replaces obsolete instructions

The distribution portions of user documentation SHALL lead with the canonical TUI and show native CLI commands only as manual/advanced fallback. They SHALL describe the supported default source, rejected local/ref operations, explicit copied-install backup/reinstall, Hermes-owned activation/removal effects and credential prompts. The old claim that Git-subdirectory installs are rejected SHALL be removed. The plugin README SHALL retain credential prompt/storage explanations, a combined provider/MCP configuration example, slug-resolution and troubleshooting sections. The first configuration example SHALL pair lifecycle provider and complementary tool bridge. Every MCP block in the plugin README and `docs/agents.md` SHALL use an exact pinned `@rembric/mcp-bridge` version, only `-y` and the package specifier in args, explicit environment mappings for server/token/slug, and no URL/header/allow-http arguments, floating tags or obsolete bridge paths. Per-directory `.rembric` SHALL retain precedence over the documented default slug. Removed credential mechanisms (`~/.rembric/.env`, `get_config_schema`, `save_config`, `~/.hermes/rembric.json`) SHALL not be documented. Root/plugin READMEs SHALL retain Hermes client links. Existing credential and slug guidance SHALL remain unchanged except for action wording required by native activation. No hand-written CHANGELOG entry SHALL be added.

#### Scenario: Reader follows the installation instructions

- **WHEN** a reader follows the Hermes distribution section
- **THEN** it SHALL use the root TUI first and native subdirectory install as the manual fallback
- **AND** it SHALL NOT instruct copying three files or claim `adopt` can migrate copied installations

### Requirement: The Hermes plugin MUST forward delegated subagent reports through `subagent_stop`

The Hermes plugin SHALL forward a delegated child's final summary to the parent session from the parent side, through the general `subagent_stop` hook.

Hermes runs `delegate_task` children with no memory provider by default. Under the checkpoint gate it still suppresses `on_session_end` and `on_delegation` for `agent_context="subagent"`, so the child side cannot forward. The general plugin hook `subagent_stop` fires once per child on the parent thread with `parent_session_id`, `child_session_id`, `child_role` and `child_summary` — "The final response the child returned to the parent", already redacted by the host.

The plugin's `register(ctx)` SHALL register a `subagent_stop` callback through `ctx.register_hook`, beside the existing `transform_tool_result` and `transform_terminal_output` registrations. The callback SHALL accept `**kwargs`: the host passes `child_session_id`, which its own documentation omits. The callback SHALL:

- do nothing when the provider is suppressed, has no slug, or when `parent_session_id` or `child_summary` is empty;
- apply the cross-client pre-filter and strip `<private>…</private>` spans;
- POST `/api/<slug>/sessions/<parent_session_id>/learnings` with `report` = `child_summary`, plus `agentType` = `child_role` when non-empty;
- run the POST on a background worker created the same way as `sync_turn`'s, with the initialized server, token and slug captured at dispatch, so the parent thread is never blocked by the request;
- return `None` and never raise into Hermes. A failure is one safe stderr diagnostic.

`parent_session_id` is used rather than the provider's current session id, so a parent that compresses or switches sessions while a delegation runs still attributes the report to the session that delegated.

#### Scenario: A delegated child's learnings reach the parent session

- **GIVEN** an initialized, unsuppressed provider with a resolved slug
- **WHEN** Hermes invokes `subagent_stop(parent_session_id="P", child_session_id="C", child_role="researcher", child_summary=<text ending in a ## Key Learnings list>)`
- **THEN** the plugin SHALL POST `{"report": <text>, "agentType": "researcher"}` to `/api/<slug>/sessions/P/learnings` from a background worker
- **AND** the callback SHALL return before that request completes

#### Scenario: An empty summary is ignored

- **WHEN** `subagent_stop` fires with an empty `child_summary`
- **THEN** the plugin SHALL make no request

#### Scenario: A failing server never raises into Hermes

- **GIVEN** the server is unreachable
- **WHEN** `subagent_stop` fires with a report containing learnings
- **THEN** the callback SHALL return normally and the worker SHALL write one diagnostic line without the response body or credentials

### Requirement: The Hermes provider SHALL publish a host binding for its own process

Hermes spawns its stdio MCP servers, `mcp_servers.rembric` included, from its own process, so the bridge is a descendant of the process the provider runs in. The provider SHALL therefore publish the host binding that "Clients that reach MCP through the stdio bridge MUST publish a host binding naming their live session" (`plugin-session-protocol`) specifies, for `os.getpid()`, with its own Python implementation:

- A primary provider instance's **live session** is the id it was initialized with, replaced by every `on_session_switch`, until `on_session_end` or `shutdown`. Hermes gives every agent its own provider instance, and an instance serves one session at a time, so a switch on one instance is sequential (`/new`, `/resume`, `/branch`, compression), never concurrent. A `subagent`, `cron` or `flush` context has no live session, so it never replaces or withdraws the primary session's binding. An instance that Hermes drops without `shutdown` stops counting once it is garbage-collected.
- The process's live sessions are the distinct live sessions of its provider instances. Two instances holding the same id are one live session.
- After every `initialize`, `on_session_switch`, `on_session_end` and `shutdown`:
  - with exactly one live session, the provider SHALL publish it;
  - with two or more, it SHALL remove the process's binding whatever session it names, and publish nothing, because a gateway's instances share one MCP bridge that cannot tell their sessions apart;
  - with none, it SHALL remove the binding only while it names the session that just stopped being live.
- `plugin.yaml::hooks` SHALL list `shutdown`.
- None of this SHALL raise into Hermes or change any HTTP lifecycle call.

#### Scenario: A session switch republishes

- **GIVEN** a primary provider initialized with session `A`
- **WHEN** Hermes calls `on_session_switch("B", …)`
- **THEN** `~/.cache/rembric/host-sessions/<Hermes pid>.json` SHALL name `B`

#### Scenario: A Hermes process serving two concurrent sessions publishes no binding

- **GIVEN** a primary provider instance live in session `A`, whose binding names `A`
- **WHEN** a second primary instance in the same process is initialized with session `B`
- **THEN** `~/.cache/rembric/host-sessions/<Hermes pid>.json` SHALL no longer exist
- **AND** an `on_session_switch` of either instance while both are live SHALL write nothing

#### Scenario: Back to one live session republishes it

- **GIVEN** two primary instances live in sessions `A` and `B`, and no binding
- **WHEN** the instance in `B` receives `on_session_end` or `shutdown`
- **THEN** the binding SHALL name `A`

#### Scenario: The same session in two instances is one live session

- **GIVEN** two primary instances both live in session `A`
- **THEN** the binding SHALL name `A`

#### Scenario: A sub-agent beside the primary keeps its binding

- **GIVEN** a primary instance live in session `A`
- **WHEN** a `subagent` instance is initialized in the same process
- **THEN** the binding SHALL still name `A`

#### Scenario: A sub-agent context publishes nothing

- **WHEN** the provider is initialized with `agent_context="subagent"`
- **THEN** no binding SHALL be written

#### Scenario: Shutdown spares another session's binding

- **GIVEN** the process's binding names a session other than the provider's current one
- **WHEN** Hermes calls `shutdown()`
- **THEN** the binding SHALL be kept
