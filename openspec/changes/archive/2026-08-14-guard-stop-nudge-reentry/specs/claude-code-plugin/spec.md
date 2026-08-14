## MODIFIED Requirements

### Requirement: The plugin SHALL ship six hook event types across nine handler entries at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare exactly six event types: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear|fork`, one for `compact`), `UserPromptSubmit` (TWO entries, NEITHER carrying a `matcher` key — the recall/first-prompt entry and the per-turn save nudge), `SessionEnd`, `PreCompact`, `PostCompact`, and `Stop` (TWO entries — an asynchronous raw sync and a synchronous end-of-turn reminder). That is **nine handler entries** in total. It SHALL NOT declare a `PostToolUse` entry (the save nudge moved off `PostToolUse` onto the `UserPromptSubmit` unified nudge in the `proactive-save-nudges` change).

Both counts SHALL be asserted as an exact set, not a containment check: a `toContain`-style assertion cannot catch a spec or manifest that wrongly claims an event type is _absent_, which is the defect class this requirement replaces. The handler count is stated separately from the event-type count because Codex's per-hook trust prompt counts handlers while its documentation counts event types (see `codex-distribution`).

The first matcher group SHALL include `fork`, and its omission was a defect rather than a decision. Claude Code documents five `SessionStart` sources — `startup`, `resume`, `clear`, `compact` and `fork` — where `fork` fires for "a new session forked from an existing one: `--fork-session` with `--resume` or `--continue`, the `/fork` background copy, or `/branch`", with the note "Before v2.1.214, forked sessions reported source `"resume"`". A matcher group that omits it means a forked conversation fires NO hook of this plugin at all: no row is registered, no nudge is emitted, and every `memory.save` for the life of that conversation persists `session_id = NULL`. A forked session is a NEW session rather than a resumed one — `--fork-session` is documented as "When resuming, create a new session ID instead of reusing the original" — so it belongs in the registration group alongside `startup`, not in a branch of its own.

Both `SessionStart` groups SHALL follow their `/sessions` ensure with one `POST /api/<slug>/sessions/<session_id>/resume`, unconditionally and without inspecting `source`. That rule is uniform across all five clients and is specified once in `plugin-session-protocol`'s lifecycle mapping; this capability records only that both of this client's ensure sites honour it.

`PreCompact` and `PostCompact` snapshot transcript/compaction-summary state as pure side effects — neither emits stdout that reaches the model. The matcher-less `UserPromptSubmit` entries emit throttled plain-stdout reminders. Full behavioural detail lives in the per-hook subsections below and in the `plugin-session-protocol` capability's lifecycle mapping, which is the authoritative table of which hook POSTs what.

The historical reason a `Stop` hook was once removed was a **semantic bug**, not a structural prohibition on `Stop` itself: Claude Code's `Stop` fires once per assistant turn (verified against `code.claude.com/docs/en/hooks`), not at session end. The prior `Stop` hook posted to `/end` (session termination), so the first turn prematurely transitioned the session to `ended` and every subsequent turn's call failed silently. `SessionEnd` remains the correct lifecycle hook for one-per-session terminal behaviour. The `Stop` hook required here never posts to `/end` and never transitions session status — it cannot trigger that bug. `Stop` now carries a SECOND entry that IS model-facing, and the decision `proactive-save-nudges` recorded is **narrowed rather than reversed — and then narrowed a second time by the loop guard below**. That change declined `Stop` on forced-continuation risk, which the narrowing read as a property of the host's BLOCKING decision alone rather than of the event. That reading was published on an unmeasured premise — that a `hookSpecificOutput.additionalContext` reminder "cannot hold a turn open" — and the premise is FALSE on the shipped host. Measured on Claude Code 2.1.232: the `Stop` runner appends this hook's `additionalContext` to the very array it returns as `blockingErrors`, and the query loop treats a non-empty array as a block — it re-invokes the model with `stop_hook_active` set and a consecutive-block counter incremented. The host's cap on that counter is NOT a backstop: it counts consecutive blocks only, a tool-call response resets it, and the reminder itself asks for a tool call — measured end-to-end, an unguarded reminder re-fired on 141 consecutive continuations without the cap engaging. The forced-continuation risk therefore DOES apply to this channel, and what bounds it is not the channel and not the host cap but the host's own loop-guard flag: the reminder handler MUST return silence whenever the stop event's input reports `stop_hook_active: true`, which holds the cost to ONE continuation per cadence point (specified in `plugin-session-protocol`). Whether an earlier host delivered this channel without continuing the turn is undetermined and is NOT claimed here. The two `Stop` entries therefore have opposite obligations and SHALL NOT be merged: the raw sync stays asynchronous so it never delays the turn, and the reminder MUST NOT be asynchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback at all. Wiring the reminder asynchronously silently forfeits it. Neither entry ever posts to `/end` or transitions session status. Behaviour is specified in `plugin-session-protocol`.

#### SessionStart (matcher: startup|resume|clear|fork)

- Type: `command`.
- Matcher: `startup|resume|clear|fork`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `source` from hook stdin. It SHALL NOT branch on `source`: all four matched values register a row, and `fork` carries a new session id, so registration is the correct response to every one of them.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge.
- When a valid slug is resolved, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": "<session_id>", "cwd": "<cwd>", "agent": "claude-code"}`. The server-side handler writes the placeholder title.
- Immediately afterwards, and only when the ensure was attempted, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/resume` with body `{}`. On a fresh row that is a documented no-op; on a row a previous run ended or the sweep abandoned, it is what returns the conversation's memories to it.
- The script SHALL emit the generic nudge `rembric: If this is a continuation of recent work, call memory.context before responding.` to stdout.
- Output cap: ≤30 tokens (measured 22.25 — 89 bytes newline-exclusive, the convention pinned below; the one budget in this capability that held as originally written).

#### SessionStart (matcher: compact)

- Type: `command`.
- Matcher: `compact`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code`.
- The script SHALL read `session_id` and `cwd` from hook stdin (slug resolution piggybacks on `.rembric` as elsewhere).
- When both `session_id` and a valid slug resolve, the script SHALL re-POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` as an idempotent session-row ensure, and SHALL then POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/resume` with body `{}`. The pair is what covers the case where the stale sweep abandoned the row between the pre-compact moment and the resume; the ensure alone never could, because the ensure path returns a terminal row untouched (`http-api`). This hook is NOT stdout-only.
- The script SHALL emit an imperative instruction block to stdout, prefixed `rembric:` so Codex's `looks_like_json` heuristic does not flag it. The instruction SHALL direct the model to: (1) call `memory.session_summary({title, summary})` with the compact summary it just produced (which appears in its context above the hook output), specifying Title (≤100 chars, descriptive) and Summary; (2) call `memory.context` or `memory.search` if it needs prior context to continue. The section list SHALL be the one canonical structure defined in `sessions`, carried verbatim rather than restated.
- Output cap: ≤150 tokens. `plugin-session-protocol` asserts the same number and the two SHALL be changed together.
- This stdout IS injected into the model's context, because `SessionStart` is one of the events documented as carrying stdout into context.

#### UserPromptSubmit (entry 1 — recall keyword + first prompt)

- Type: `command`.
- Matcher: NONE. The entry SHALL NOT declare a `matcher` key. Claude Code's dispatcher would otherwise filter invocation, and the script needs to see **every** prompt to detect the session's first one. Codex ignores the manifest matcher for this event regardless, so a matcher-less registration is also the only shape that behaves identically on both clients.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- The script SHALL self-filter internally for TWO independent triggers, emitting one line each, and MAY emit both on the same turn:
  1. a recall-intent keyword (`remember|recall|acuérdate|qué hicimos|what did we do`, case-insensitive) matched against the stdin `prompt` field, on any turn;
  2. the session's first prompt, tracked by its OWN per-session turn counter under `${TMPDIR:-/tmp}/rembric-relevance-prefetch/` — distinct from `prompt-nudge.sh`'s `rembric-turnnudge/` counter, so the two scripts' independent cadences never double-increment each other.
- Unparseable or empty stdin SHALL fail OPEN on the keyword trigger (emit the recall line) and fail CLOSED on the first-prompt trigger (an unreadable counter SHALL NOT be read as turn 1).
- The script SHALL make NO network call. It sources `_api.sh` for the stdin and counter helpers only.

#### UserPromptSubmit (entry 2 — unified per-turn nudge)

- Type: `command`. Matcher: NONE.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh`. Behaviour is specified by this capability's unified-nudge requirement and by `plugin-session-protocol`'s sessionId-nudge requirement; not restated here.

#### SessionEnd

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh claude-code`. The agent-name argument SHALL be passed explicitly rather than left to the script's default, because Codex CLI wires the same single script with `codex-cli` to select its own transcript parser (`codex-distribution`), and a bare invocation on one client against an argument on the other is the shape that lets the two drift.
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and `reason` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL read `transcript_path` if the file exists, format the transcript via the shared `_transcript.sh` helper (oldest-first `role: content` lines, truncated to 19500 chars), extract a title from the first non-empty assistant message (truncated to 100 chars), and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`.
- When `transcript_path` is missing/unreadable/empty, the script SHALL POST `/end {}` (degraded mode — transition without summary).
- The script SHALL discard the response, SHALL emit no stdout (`SessionEnd` is not stdout-injected), and SHALL exit `0` on any error.
- Output cap: 0 tokens to model (side effect).

#### PreCompact

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh claude-code`.
- The script SHALL snapshot the still-readable transcript to `/api/<slug>/sessions/<session_id>/summary` with `final:false`, degrading to `{}` when no transcript parses.
- Output cap: 0 tokens to model (side effect).

#### PostCompact

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`.
- The script SHALL POST the model-authored `compaction_summary` from stdin to `/api/<slug>/sessions/<session_id>/summary` with `final:false`, after routing it through `_transcript.sh`'s `rembric_redact_private` choke point (the compactor quotes conversation content verbatim, so the payload is transcript-derived — see `plugin-session-protocol`'s client-side redaction requirement). It SHALL degrade to `{}` with one stderr diagnostic when stdin carries no compaction summary.
- Output cap: 0 tokens to model (side effect).

#### Stop

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `transcript_path` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve and `transcript_path` is readable, the script SHALL format the transcript via the SAME shared `_transcript.sh` helpers `SessionEnd` uses (`rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`) and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>"}` — the `final` field SHALL be omitted (never `true`, never `false`), so the write can never mark the session curated. Codex's variant of the same script sends `final:false` explicitly; that divergence is specified in `codex-distribution`.
- The script SHALL emit NO stdout under any circumstance — no `hookSpecificOutput`, no plain text. This hook exists purely as a side effect; it SHALL NOT be used as a channel to inject anything into the model's context. Output cap: 0 tokens to model.
- The hook entry SHALL declare `"async": true` **and** the script SHALL additionally daemonize its own work: the transcript-format-and-POST body runs in a detached background subshell with stdout and stderr redirected to `/dev/null`, followed by `disown`. Both mechanisms are required, and the redirect is load-bearing — without it an inherited pipe file descriptor in the child keeps the host waiting on that descriptor regardless of how quickly the parent returns, so `"async": true` alone does not make the hook non-blocking. Whether the `async` flag by itself decouples `Stop` from turn latency is unconfirmed upstream; the script therefore does not depend on it.
- The script SHALL run unconditionally on every `Stop`, with no throttle and no counter file. Because the work is daemonized it carries no turn-latency cost that a throttle would need to amortise.
- The script SHALL discard the response and SHALL exit `0` on any error, identically to every other hook script's fail-safe discipline.
- The SECOND `Stop` entry (`stop-nudge.sh`, the end-of-turn reminder specified in `plugin-session-protocol`) SHALL read `stop_hook_active` from the SAME stdin payload and SHALL emit nothing whenever it is `true`, before it resolves the transcript path. On this host that flag is the only bound on the reminder's cost, for the reason recorded above: the host delivers a `Stop` hook's `additionalContext` by continuing the turn, and the reminder's cadence counter advances only on a user prompt, which a continuation never submits.

#### Scenario: The two Stop entries have opposite execution models

- **WHEN** `hooks.json`'s `Stop` handlers are read in order
- **THEN** the first SHALL invoke the raw sync and SHALL declare `async: true`
- **AND** the second SHALL invoke the end-of-turn reminder and SHALL NOT declare `async`
- **AND** the assertion SHALL be an ordered pair of (script, async), because getting either flag wrong disables that entry silently rather than loudly

#### Scenario: The Stop reminder yields once the host has continued the turn to satisfy it

- **GIVEN** the second `Stop` entry at a turn where the reminder would otherwise fire, with a readable transcript and a configured server
- **WHEN** Claude Code fires `Stop` with stdin carrying `"stop_hook_active": true`
- **THEN** `stop-nudge.sh` SHALL exit `0` with completely empty stdout, emitting no `hookSpecificOutput`, so the host records no block and its consecutive-block cap is never reached
- **AND** the control SHALL pass in the same run: the identical stdin with the flag `false` or absent SHALL still emit the reminder

#### Scenario: SessionStart hook creates a session and writes the placeholder title

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook (`source: startup`) with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}` at 22:14 UTC
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo", "agent": "claude-code"}`
- **AND** SHALL then POST `${REMBRIC_SERVER_URL}/api/foo/sessions/claude-sess-abc12345/resume` with body `{}`, which succeeds as a no-op reporting `previousStatus: 'active'`
- **AND** the server SHALL insert a row with `title = 'foo · 22:14 UTC'`, `title_final = false`
- **AND** the script SHALL still emit the `rembric: If this is a continuation...` nudge on stdout

#### Scenario: A resumed Claude Code session returns its row to active

- **GIVEN** session `<S>` was registered in a previous run and its row is now `ended` (its `SessionEnd` hook fired) or `abandoned` (the stale sweep flipped it)
- **WHEN** the operator runs `claude --resume <S>` and `SessionStart` fires with `source: "resume"` and the SAME `session_id`
- **THEN** `session-start.sh` SHALL POST the ensure and then the resume
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** the control SHALL pass in the same run: without the resume POST the row stays terminal and a subsequent `memory.save` on that transport persists `session_id = NULL`

#### Scenario: A forked session is registered as a new session

- **GIVEN** the operator runs `claude --resume <S> --fork-session`, which the host documents as creating a new session id
- **WHEN** `SessionStart` fires with `source: "fork"` and a session id `<F>` different from `<S>`
- **THEN** the `startup|resume|clear|fork` matcher group SHALL match, and `session-start.sh` SHALL register `<F>` as a new row
- **AND** the resume that follows SHALL succeed as a no-op against `<F>`
- **AND** `<S>` SHALL be left in whatever state it was already in — a fork SHALL NOT revive the session it was forked from
- **AND** the control SHALL pass in the same run: with `fork` absent from every matcher, no hook fires and no row exists for `<F>`

#### Scenario: SessionStart hook with matcher compact re-ensures the row and injects the instruction

- **WHEN** Claude Code resumes a session from auto-compaction and fires `SessionStart` with `source: 'compact'`
- **THEN** `post-compact.sh` SHALL POST `/api/foo/sessions` with the session id, cwd and agent, and SHALL then POST `/api/foo/sessions/<session_id>/resume`, so a row the stale sweep abandoned mid-conversation is returned to `active`
- **AND** SHALL emit a multi-line instruction to stdout prefixed with `rembric:` directing the model to call `memory.session_summary` with the compact summary visible in its context
- **AND** the next model turn SHALL see the instruction in its context and (when cooperating) SHALL call `memory.session_summary({title, summary})` with the model-authored values

#### Scenario: Neither UserPromptSubmit entry declares a matcher

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** both `UserPromptSubmit` entries SHALL be objects with a `hooks` array and NO `matcher` key
- **AND** the assertion SHALL fail the build if a `matcher` is added to either

#### Scenario: prompt-search.sh emits the recall line on a keyword at any turn

- **GIVEN** a session already past its first prompt
- **WHEN** `UserPromptSubmit` fires with stdin whose `prompt` field contains `what did we do`
- **THEN** `prompt-search.sh` SHALL emit exactly the recall line and SHALL NOT emit the first-prompt line

#### Scenario: prompt-search.sh emits the first-prompt line once per session

- **WHEN** `UserPromptSubmit` fires for the first time in a session with a prompt containing no recall keyword
- **THEN** `prompt-search.sh` SHALL emit exactly the first-prompt line
- **AND** on the second and subsequent prompts of the same session it SHALL NOT emit that line again

#### Scenario: Both prompt-search.sh lines can coincide on turn 1

- **WHEN** the first prompt of a session also contains a recall keyword
- **THEN** `prompt-search.sh` SHALL emit both lines, first-prompt line first
- **AND** this is the worst case `prompt-search.sh` alone can reach; it is NOT the worst-case `UserPromptSubmit` turn, which is the counter-divergence case the token-budget requirement's per-firing-turn ceiling is set against

#### Scenario: SessionEnd hook captures the transcript and POSTs /end with summary

- **GIVEN** a Claude Code session with at least one assistant turn, whose `transcript_path` JSONL is readable
- **WHEN** Claude Code fires `SessionEnd` with stdin `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl", "reason": "logout"}`, the hook having been invoked as `session-end.sh claude-code`
- **THEN** the script SHALL format the transcript via `_transcript.sh`, derive a title from the first non-empty assistant message
- **AND** SHALL POST `/api/foo/sessions/<S>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`
- **AND** the server SHALL transition the row to `status='ended'`, write the summary and title (subject to `final` precedence), and respond `200 OK`

#### Scenario: SessionEnd with missing transcript_path

- **WHEN** SessionEnd fires and `transcript_path` is missing/unreadable
- **THEN** the script SHALL POST `/end {}` and the row SHALL transition to `ended` with whatever summary/title were already in place

#### Scenario: SessionEnd when model already wrote a final summary

- **GIVEN** a session whose `summary_final = true` because the model called `memory.session_summary` mid-session
- **WHEN** SessionEnd fires and posts `/end {summary: "raw transcript", title: "...", final: false}`
- **THEN** the row SHALL transition to `ended`
- **AND** `summary` and `title` SHALL remain the model-authored values (the `final:false` writes are silently skipped due to precedence)

#### Scenario: Stop hook syncs summary and title without touching the model

- **GIVEN** a Claude Code session mid-conversation, whose `transcript_path` JSONL contains at least one assistant message
- **WHEN** Claude Code fires `Stop` with stdin `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl", "cwd": "..."}`
- **THEN** `stop-sync.sh` SHALL POST `/api/foo/sessions/<S>/summary` with body `{"summary": "<formatted>", "title": "<derived>"}` containing no `final` key
- **AND** the row's `summary_final` and `title_final` SHALL remain (or become) `false`
- **AND** the hook SHALL emit no stdout of any kind — nothing reaches the model's context from this event

#### Scenario: Stop hook never overwrites a curated summary

- **GIVEN** a session whose `summary_final = true` (set via `memory.session_summary`)
- **WHEN** `Stop` fires and `stop-sync.sh` POSTs a freshly-formatted raw transcript
- **THEN** the write SHALL be silently skipped by the existing `final`-precedence rule
- **AND** the curated `summary`/`title` SHALL remain unchanged

#### Scenario: Stop hook is both declared async and self-daemonized

- **WHEN** `apps/plugin/hooks/hooks.json` and `apps/plugin/scripts/stop-sync.sh` are inspected
- **THEN** the `Stop` handler entry SHALL carry `"async": true`
- **AND** the Claude Code branch of the script SHALL run its sync body as a backgrounded subshell with both stdout and stderr redirected to `/dev/null`, followed by `disown`
- **AND** no per-session counter file SHALL exist for `Stop`, and no `Stop` invocation SHALL be skipped

#### Scenario: Hook catalog lives at the new path

- **WHEN** Claude Code consumes the plugin from the marketplace
- **THEN** `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` SHALL resolve to a file whose source-of-truth in this repository is `apps/plugin/hooks/hooks.json`
- **AND** the file's event-type set SHALL be exactly `{SessionStart, UserPromptSubmit, SessionEnd, PreCompact, PostCompact, Stop}` carrying exactly nine handler entries, with NO `PostToolUse` entry

## Hook script invariants

- Every hook script SHALL use `#!/usr/bin/env bash` and `set -u`.
- Every script SHALL trap errors (`trap 'exit 0' ERR`) and ensure `exit 0` with empty stdout on any failure. Plugin-side failure SHALL NOT break a Claude Code session.
- Every script SHALL be executable (mode 755).
- The first non-whitespace character of a hook script's stdout SHALL NOT be `{` or `[`, UNLESS the script intentionally emits a well-formed JSON object matching the relevant Codex hook event schema (`codex-rs/hooks/src/engine/output_parser.rs::parse_session_start` and siblings). Codex's `looks_like_json` heuristic treats stdout starting with those characters as a JSON attempt; a malformed leading character (e.g. the former `[rembric]` badge prefix) fails the hook with `invalid ... JSON output`. Today every Rembric hook emits either empty stdout or a plain-text nudge prefixed with `rembric:` — neither triggers the heuristic.

## Project slug selection

The active Rembric project is signalled per directory by a `.rembric` config file containing `PROJECT_SLUG=<slug>`. The plugin's bridge (`bin/rembric-bridge.mjs`) reads this file at MCP session startup and path-scopes the URL accordingly.

**Format requirements:**

- The slug MUST match `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.
- Lowercase letters, digits, hyphens only. Maximum 64 characters.
- The `.rembric` file uses dotenv syntax: one `KEY=VALUE` per line, `#` for line comments, blank lines ignored. Matched surrounding single or double quotes around the value are stripped. Only `PROJECT_SLUG` is interpreted today; the namespace is reserved for future fields (`DEFAULT_SCOPE`, `AUTO_SAVE`, etc.) so the filename and parser stay stable as scope grows.

**Lookup location:**

- The bridge SHALL look for `.rembric` in the project directory resolved by the precedence chain specified once under "MCP bridge contract" above — including its `PWD` step, which is what makes the bridge work under Codex, whose MCP launcher forwards the shell working directory rather than `CLAUDE_PROJECT_DIR` (`codex-distribution`'s `env_vars` requirement depends on it). The chain SHALL NOT be restated here; a second copy is how this line came to contradict it.
- File absence, parse failure, missing `PROJECT_SLUG`, or invalid slug are all permitted; the bridge falls back to path-less `/mcp` with a stderr diagnostic. The session continues to operate, against the default project unless the agent pins another.

**Authority and precedence:**

- When the bridge succeeds in path-scoping, the URL is `${server_url}/mcp/<slug>`. The Rembric server populates `ctx.project` from the URL slug during auth. All tool handlers honor `ctx.project` as the first source of truth, so the project is pinned deterministically without any agent-side `project.use` call.
- When the bridge falls back to path-less `/mcp`, behavior reverts to the standard path-less codepath: roots discovery (if the client advertises `roots`), `project.use` writing to `SessionRouter`, and `scopeFromContext` consulting the router. This makes the plugin a strict superset of the path-less protocol — it works either way.

**Bootstrap for new slugs:**

- The first time the bridge connects with a slug that does not yet correspond to a Rembric project, the agent — guided by the protocol text the server delivers through the MCP `initialize.instructions` handshake (`apps/server/src/mcp/instructions.ts`) — can call `project.use({slug, autocreate: true})` once to create it. Subsequent connections find the project already created and skip the bootstrap.

**Manual override during a session:**

- The agent can call `project.use({slug: 'something-else', confirmSwitch: true})` to switch scope (allowed only when no session is active — close it first via `memory.session_summary`; add `autocreate: true` if the target project does not exist yet). This is independent of the bridge's URL path.

## Out-of-scope behaviors

This capability does not specify:

- A stdio→HTTP bridge for filesystem-side slug resolution. Considered and rejected for v1; possible opt-in in a future change.
- A local stdio mode for Rembric. The plugin is a configuration layer for the existing HTTP server.
- A standalone public plugin marketplace listing (e.g., a curated Anthropic-hosted directory). The plugin is shipped from this repository's public marketplace manifest; a future change may extract it via `git subtree split` to distribute as a separate package.
- Server-side changes to `deriveSlugFromUri` or other Rembric internals. The plugin sits entirely on the client side.
