## MODIFIED Requirements

### Requirement: A path-less bridge connection MUST resolve to the default project, and a new slug MUST be created from the dashboard

When the bridge falls back to path-less `/mcp` outside a git work tree — no `.rembric`, a parse failure, no `PROJECT_SLUG`, or an invalid slug — the connection SHALL resolve to the server's default project for its whole life. Inside a git work tree there is no such fallback: a checkout that no `.rembric`, `REMBRIC_PROJECT_SLUG` or bound fingerprint resolves is unbound, or gets no connection at all, as the `repository-binding` and `mcp-bridge` capabilities specify. The plugin SHALL NOT rely on MCP roots discovery or on any tool call to select another project: the server does neither, and no tool can switch a connection's project. The bridge's stderr diagnostic SHALL name the fix (a `.rembric` file containing `PROJECT_SLUG=<slug>`, or `REMBRIC_PROJECT_SLUG`), as the `mcp-bridge` capability specifies.

When the bridge path-scopes the URL with a slug that does not yet correspond to a Rembric project, every scope-resolving tool SHALL be refused with `project_not_found`, and the refusal SHALL point to the dashboard. The project SHALL be created from the dashboard; no agent-side bootstrap call exists, and the plugin's model-facing text SHALL NOT instruct the agent to create or switch a project. Subsequent tool calls on the same URL find the project once the operator has created it.

To work in another project the operator changes `.rembric` (or `REMBRIC_PROJECT_SLUG`), or an admin changes the repository's binding, and starts a new host session; there is no in-session override.

#### Scenario: No slug means the default project

- **GIVEN** a project directory outside any git work tree with no `.rembric` and no `REMBRIC_PROJECT_SLUG`, and a host that advertises the `roots` capability
- **WHEN** the agent calls `memory.save` through the plugin
- **THEN** the row SHALL carry the default project's `project_id`
- **AND** the server SHALL NOT have sent `roots/list` to the host

#### Scenario: A new slug is created from the dashboard, not by the agent

- **GIVEN** `.rembric` containing `PROJECT_SLUG=brand-new` and no project with that slug
- **WHEN** the agent calls `memory.search` through the plugin
- **THEN** the call SHALL be refused with `project_not_found`, the refusal SHALL point to the dashboard, and no `projects` row SHALL be inserted
- **AND** after the operator creates `brand-new` from the dashboard, the same call on the same URL SHALL succeed against it

#### Scenario: An unbound checkout does not reach the default project

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and an unbound fingerprint
- **WHEN** the agent calls `memory.save` through the plugin
- **THEN** the call SHALL be refused with `project_unbound`
- **AND** no row SHALL carry the default project's `project_id`

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, `post-compaction.sh`, `prompt-search.sh`, `prompt-nudge.sh` and `stop-report.sh` minimal and consistent, the plugin SHALL ship a shared helper at `apps/plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Exposes `rembric_parse_dotenv`, which parses `${cwd}/.rembric` for `PROJECT_SLUG` (reusing the same dotenv parser logic as the bridge). The parser SHALL trim BOTH leading and trailing whitespace from each value before quote-stripping — trailing whitespace SHALL NOT be left in the parsed value, and this trim SHALL also strip a trailing carriage return, so a `.rembric` file saved with CRLF line endings resolves to the same slug the JS bridge (`bin/rembric-dotenv.mjs`, which trims both sides) resolves.
- Exposes `rembric_read_project_slug <dir>`, which returns the validated `PROJECT_SLUG` of the nearest `.rembric` at or above `<dir>`, stopping after the checkout root inside a git work tree and checking only `<dir>` outside one.
- Exposes `rembric_session_project <session-id> <cwd>`, the wrapper every hook script actually calls to go from a session and a working directory to the session's project. It SHALL return the outcome cached for that session under `${TMPDIR:-/tmp}/rembric-project/`; on a cache miss it SHALL resolve with the cascade the `repository-binding` capability defines — `rembric_read_project_slug`, then `REMBRIC_PROJECT_SLUG`, then, inside a git work tree, the fingerprint through `POST /api/repositories/resolve` — and SHALL cache the outcome, including an unbound, ambiguous or unavailable outcome, writing the cache only when no entry exists so the first resolution in a session wins. A cached outcome that is not a slug SHALL make the calling hook skip every POST. `session-start.sh` SHALL resolve first and SHALL print the session-start text the `repository-binding` capability specifies for an unbound repository or a conflicting explicit selection.
- Exposes `rembric_post <path> <json-body>`, which issues `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time "${REMBRIC_POST_MAX_TIME:-3}" -d "$body" -w '\n%{http_code}' "$URL"`. The budget SHALL be overridable through `REMBRIC_POST_MAX_TIME` and SHALL default to `3` when unset, so a caller running under a host-imposed budget tighter than 3 seconds can fit the request inside it. Codex's `SessionEnd` is the case that forces this: the host allows that one event 1 second by default and 3 seconds at most, against 600 for every other hook, so a fixed 3-second POST consumes the entire budget and leaves nothing for the transcript read or the failure diagnostic (`codex-distribution`). A caller SHALL set the variable only where a tighter budget applies; every other script inherits the default and SHALL NOT restate it. It SHALL use `-s` and NOT `-f`: the status code is captured via `-w` and split off the response, so that a non-2xx response can be reported with its body in the stderr diagnostic required by `plugin-session-protocol`'s failed-POST requirement. `-f` would suppress exactly that body. An empty body argument SHALL be normalised to `{}`.
- Exposes `rembric_turn_report <path> <json-body>`, the ONE function in this file besides `rembric_session_ensure` that reads a response body. It SHALL echo the response's `lines` array as one newline-separated block, or nothing on failure, on a non-2xx status, or when the array is empty. Keeping it separate from `rembric_post` is what stops the body-reading capability from later being pointed at a `/summary` response, which `plugin-session-protocol` forbids.
- Exposes `rembric_pending_write <session-id> <text>` and `rembric_pending_take <session-id>`, a per-session line cache under `${TMPDIR:-/tmp}/rembric-pending/`. `_take` SHALL print and remove in one step, so a notice is printed exactly once. `_write` SHALL NOT overwrite a non-empty cache with an empty value — a second report within one turn would otherwise swallow a pending notice.
- Exposes `rembric_scan_offset <session-id>` and `rembric_scan_offset_set <session-id> <bytes>`, a per-session byte offset under `${TMPDIR:-/tmp}/rembric-scan/` recording how much of the host transcript the previous report consumed.
- Exposes `rembric_turn_count <counter-name> <session-id>`, an atomic per-session turn counter, whose sole remaining caller is `prompt-search.sh` with the counter name `rembric-relevance-prefetch`. It SHALL append one byte and count the file's bytes rather than read-increment-write, because a single `O_APPEND` write is atomic across concurrent invocations. It SHALL echo the new count, or NOTHING when the counter is unreadable — callers MUST treat empty as fail-closed, since defaulting to `0` satisfies every equality check at once. `rembric_turn_count_peek` is removed with its only caller.
- Exposes `rembric_json_escape <string>` that escapes for embedding in a JSON value: backslash, double quote, and every control character in the range U+0000–U+001F. `\n`, `\r`, and `\t` SHALL use their short escape forms; every other character in that range (e.g. an ANSI escape from pasted colored terminal output) SHALL be escaped as `\u00XX` so the output is always valid JSON. Characters at or above U+0020 (including `\x7f`/DEL, which JSON does not require escaping) SHALL be left untouched.
- Exposes stdin-field extractors `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, `rembric_transcript_path_from_stdin_json`, `rembric_prompt_from_stdin_json`, `rembric_stop_hook_active_from_stdin_json` and `rembric_compaction_summary_from_stdin_json`. The compaction-summary extractor SHALL prefer `compaction_summary` and SHALL fall back to `compactionSummary` (in case Codex uses camelCase, per the same precedent that `session_id`/`sessionId` already follows).
- Returns `0` even on failure (so callers can `|| true` safely). `rembric_post` discards the response body from stdout; it does NOT suppress the stderr diagnostic.

The sibling helper `apps/plugin/scripts/_transcript.sh` exposes `rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`, `rembric_format_transcript_codex_cli`, `rembric_extract_first_assistant_codex_cli`, the deterministic fact extractor, and `rembric_redact_private` — the mandatory client-side redaction choke point specified by `plugin-session-protocol`'s `<private>`-span requirement. **Every one of those functions is retained; only their call sites move.** The fact extractor's caller becomes `session-end.sh` (`sessions`), and no per-turn script calls it. `post-compaction.sh` routes the compaction summary through `rembric_redact_private` because the compactor quotes conversation content verbatim, making that payload transcript-derived. Any new script sending transcript-derived text SHALL route it through the same function — including the provisional title `prompt-nudge.sh` records for `stop-report.sh`.

`pre-compact.sh <agent>` SHALL detect the agent from `$1` (the same convention `session-start.sh` and `stop-report.sh` use, defaulting to `$REMBRIC_AGENT` then `claude-code`) and dispatch to the matching per-client transcript variants. There is no per-client copy of the script.

Each hook script SHALL `source` `_api.sh` (and `_transcript.sh` where transcript handling is needed) and SHALL NOT inline the curl invocation or transcript parsing directly. The helpers SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: New helpers are sourced by the new scripts

- **WHEN** `pre-compact.sh`, `post-compaction.sh` or `stop-report.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** each that handles transcripts SHALL also `source "${SCRIPT_DIR}/_transcript.sh"`
- **AND** none SHALL inline a literal `curl` invocation outside the helper

#### Scenario: The POST budget is overridable and defaults to 3

- **GIVEN** `REMBRIC_POST_MAX_TIME` is unset
- **WHEN** `rembric_post` runs
- **THEN** the curl invocation SHALL carry `--max-time 3`
- **AND** when the variable is set to `2`, the same invocation SHALL carry `--max-time 2`
- **AND** the value SHALL be read at call time, so a per-hook override in a manifest's `command` string takes effect

#### Scenario: rembric_post reports a non-2xx with its body

- **GIVEN** the server responds `401` with a JSON error body
- **WHEN** `rembric_post` is called
- **THEN** it SHALL emit one stderr line naming the path, the curl return code, the HTTP status and the response body
- **AND** it SHALL return `0` so the calling hook still exits `0`

#### Scenario: rembric_turn_report echoes lines only on success

- **GIVEN** the server responds `200` with `{"ok":true,"sessionId":"S","lines":["a","b"]}`
- **WHEN** `rembric_turn_report` is called
- **THEN** it SHALL echo exactly `a\nb`
- **AND** on a `404`, a timeout, or `"lines":[]` it SHALL echo nothing and still return `0`

#### Scenario: The pending cache is take-once and never emptied by a second report

- **GIVEN** `rembric_pending_write S "notice"` has run
- **WHEN** `rembric_pending_write S ""` runs and then `rembric_pending_take S`
- **THEN** `rembric_pending_take` SHALL print `notice`
- **AND** a second `rembric_pending_take S` SHALL print nothing

#### Scenario: rembric_turn_count fails closed when unreadable

- **GIVEN** the counter directory cannot be created or the counter file cannot be read back
- **WHEN** `rembric_turn_count` is called
- **THEN** it SHALL echo nothing
- **AND** the caller SHALL treat the empty value as "do not fire", never as `0`

#### Scenario: pre-compact.sh dispatches on its agent argument

- **WHEN** `pre-compact.sh codex-cli` runs against a Codex transcript
- **THEN** it SHALL use `rembric_format_transcript_codex_cli` and `rembric_extract_first_assistant_codex_cli`
- **WHEN** `pre-compact.sh` runs with no argument or with `claude-code`
- **THEN** it SHALL use the `_claude_code` variants

#### Scenario: post-compaction redacts before POSTing

- **GIVEN** stdin whose `compaction_summary` contains a `<private>…</private>` span
- **WHEN** `post-compaction.sh` runs
- **THEN** the POSTed body SHALL contain `[REDACTED]` in place of the span and SHALL NOT contain the original span

#### Scenario: The provisional title is redacted before it leaves the client

- **GIVEN** a first user prompt containing a `<private>…</private>` span
- **WHEN** `stop-report.sh` sends its first report
- **THEN** the `title` field SHALL contain `[REDACTED]` in place of the span

#### Scenario: rembric_compaction_summary_from_stdin_json accepts both naming conventions

- **WHEN** the helper is called with stdin `{"compaction_summary": "X"}` (snake_case, Claude convention)
- **THEN** it SHALL extract `X`

- **WHEN** the helper is called with stdin `{"compactionSummary": "X"}` (camelCase, in case Codex differs)
- **THEN** it SHALL extract `X`

- **WHEN** the helper is called with stdin lacking both keys
- **THEN** it SHALL emit empty string and exit `0`

#### Scenario: A `.rembric` value with trailing whitespace or CRLF resolves the same as the JS bridge

- **GIVEN** a `.rembric` file containing `PROJECT_SLUG=demo` followed by trailing spaces, OR the same line saved with a trailing `\r\n`
- **WHEN** `rembric_parse_dotenv` parses the file
- **THEN** the parsed `PROJECT_SLUG` value SHALL be exactly `demo`, with no trailing whitespace or carriage return
- **AND** this SHALL match what `bin/rembric-dotenv.mjs` (the bridge's parser) resolves for the same file

#### Scenario: rembric_json_escape produces valid JSON for a transcript containing an ANSI escape

- **GIVEN** a string containing a raw `\x1b` (ESC) byte, e.g. from pasted colored terminal output
- **WHEN** `rembric_json_escape` is called on it
- **THEN** the output SHALL contain the escape sequence in place of the raw byte
- **AND** embedding the output as a JSON string value and parsing it back SHALL reproduce the original byte exactly

#### Scenario: Every hook in a session reuses the first resolution

- **GIVEN** `session-start.sh` resolved session `S` to slug `shop` by fingerprint
- **WHEN** an admin moves the binding to `store` and `stop-report.sh` then runs for `S`
- **THEN** `stop-report.sh` SHALL POST to `/api/shop/sessions/S/turn`
- **AND** it SHALL NOT call `/api/repositories/resolve`

#### Scenario: An unbound session posts nothing from any hook

- **GIVEN** `session-start.sh` resolved session `S` as unbound
- **WHEN** `prompt-search.sh`, `stop-report.sh`, `pre-compact.sh`, `post-compaction.sh` and `session-end.sh` run for `S`
- **THEN** none of them SHALL issue a request to any `/api/<slug>/` path
