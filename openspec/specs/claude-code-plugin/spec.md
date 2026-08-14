# claude-code-plugin

## Purpose

Distribution and configuration of Rembric's Claude Code plugin. Defines the manifest contract, the HTTP MCP server entry with path-scoped URL, the hook output discipline, and the token budget envelope.

## Plugin manifest

- The plugin SHALL be packaged in this monorepo at `apps/plugin/` with the manifest at `apps/plugin/.claude-plugin/plugin.json`.
- The manifest SHALL declare `name: "rembric"` for namespacing of commands (`/rembric:*`) and agent listings.
- The manifest SHALL declare exactly two `userConfig` fields:
  - `server_url`: `type: "string"`, `required: true`. Base URL of the user's Rembric deployment WITHOUT the `/mcp` suffix. The plugin appends `/mcp` itself.
  - `api_token`: `type: "string"`, `required: true`, `sensitive: true`. Stored in the system keychain, never in `settings.json`.
- The manifest SHALL NOT declare a `project_slug` userConfig field. The active project is signalled per directory via a `.rembric` config file (see [Project slug selection](#project-slug-selection)).
- The manifest SHALL declare `mcpServers: "./.claude-plugin/mcp.json"` and SHALL NOT inline server configuration in `plugin.json`.

## Marketplace declaration

- A `.claude-plugin/marketplace.json` SHALL exist at the repository root.
- The marketplace SHALL declare exactly one plugin entry whose `source` is a relative path string (`"./apps/plugin"`).
- The marketplace SHALL be installable via `claude plugin marketplace add <repo>` using each user's existing git credentials (SSH key or PAT) when fetched from git, or directly from a local path during development.

## MCP server declaration

- `apps/plugin/.claude-plugin/mcp.json` SHALL declare a single MCP server entry named `rembric`.
- The server entry SHALL use `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]`, spawning the local bridge as a stdio MCP server.
- The bridge SHALL receive `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` via `env`, sourced from `${user_config.server_url}` and `${user_config.api_token}` respectively.
- The plugin SHALL NOT use a direct `type: "http"` MCP server entry; the bridge mediates traffic so that the URL can be path-scoped with the slug read from `.rembric` at session start.

## MCP bridge contract

- The plugin SHALL ship `apps/plugin/bin/rembric-bridge.mjs`, a Node ≥18 script that acts as a stdio MCP server for Claude Code while forwarding to Rembric over HTTP.
- The bridge SHALL resolve the project directory from a precedence chain of environment variables, in this order: `CLAUDE_PROJECT_DIR`, then `PWD`, then `process.cwd()`. The chain SHALL skip empty-string values (use `||` not `??` semantics) so that an explicitly-set-to-empty env var falls through cleanly. This makes the bridge reusable from non-Claude-Code clients (notably Codex) that propagate the user's shell working directory via `PWD` rather than Claude's `CLAUDE_PROJECT_DIR` convention.
- The bridge SHALL look for `${projectDir}/.rembric`. If the file exists, the bridge SHALL parse it as dotenv-style `KEY=VALUE` lines (with `#` line comments and optional matched-quote stripping) and read `PROJECT_SLUG`. If `PROJECT_SLUG` is defined and matches `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, the bridge SHALL construct the URL `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped).
- If `.rembric` is missing, unparseable, lacks `PROJECT_SLUG`, or `PROJECT_SLUG` does not match the slug regex, the bridge SHALL write a one-line stderr diagnostic and fall back to path-less `${REMBRIC_SERVER_URL}/mcp`. The bridge SHALL NOT abort in this case — the session continues against the default project (or whatever the agent later pins with `project.use`).
- The bridge SHALL delegate the actual stdio↔Streamable-HTTP-MCP transport to `npx -y mcp-remote` at a pinned exact version (see "The bridge MUST pin the `mcp-remote` version" below), injecting `Authorization: Bearer ${REMBRIC_API_TOKEN}` on every request and passing the `--allow-http` flag so that plain-HTTP LAN deployments (e.g. `http://192.168.x.y:8787`) are accepted. For HTTPS deployments the flag is a no-op.
- The bridge SHALL NOT parse, rewrite, or inspect MCP frames beyond what `mcp-remote` itself does. It is purely a URL-building entrypoint.
- The bridge SHALL write one diagnostic line to stderr at startup of the form `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`, where `<source>` is exactly one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()` — naming which step of the precedence chain produced the resolved directory. This aids debugging via `claude --debug` and `codex` log inspection.
- If `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are missing, the bridge SHALL exit non-zero with a clear stderr message instructing the user to configure the plugin.
- The bridge SHALL forward the child process's exit code; if the child terminates from a signal, the bridge SHALL re-raise that signal in its own process.

## Skill catalog

- The plugin SHALL NOT ship any skills. The proactive-save protocol (when to save, when to recall, how to close a session, topic_key usage, candidate-resolution) is delivered server-side via Rembric's MCP `initialize.instructions` handshake (`apps/server/src/mcp/instructions.ts`), so it applies uniformly to every MCP client (Claude Code plugin, Codex CLI, Cursor, custom integrations) without per-client duplication.
- An earlier iteration shipped a `rembric-memory` skill with the same content; it was removed once `initialize.instructions` was verified to carry equivalent guidance under the 800-character hard limit enforced by `instructions.test.ts`.

## Requirements

### Requirement: Each `/rembric:*` command body MUST name only arguments its tool's schema accepts

The four commands under `apps/plugin/commands/*.md` are agent-facing instructions: the model reads the body and issues the call verbatim. A command naming a parameter its tool does not accept produces a zod rejection at runtime, and a spec that documents such a call teaches the wrong shape to every reader.

The plugin SHALL ship exactly four commands under `/rembric:*`, auto-discovered from `apps/plugin/commands/*.md` (there is no `commands` field in `.claude-plugin/plugin.json`):

- `remember <text>` → `memory.save({type: 'project', title: <concise ≤100-char headline>, content: '$ARGUMENTS'})`. The `title` is required by `memory.save`, so the command directs the agent to supply a short headline derived from the text.
- `recall <topic>` → `memory.search({query: '$ARGUMENTS', limit: 5})`, rendered compactly. The parameter is `query`; `memorySearchSchema` has no `q`.
- `context` → `memory.context()`, rendered compactly. `contextSchema` accepts `sessions`, `prompts`, `memories`, `includeArchived` and `focus`; it has no `limit`.
- `summary` → `memory.session_summary({title, summary})`. `sessionSummarySchema` is `{sessionId?, summary (REQUIRED), title?}`; it has no `auto`, and a call omitting `summary` is rejected.

Every argument key named in a command body SHALL be a key of the corresponding tool's zod schema, and this SHALL be asserted in CI rather than reviewed by eye. The three wrong parameter names this requirement replaces (`q`, `limit` on `context`, `auto`) survived because the catalog was prose in an unexecuted section of the spec.

Each command's frontmatter `description` SHALL be ≤20 tokens; the four descriptions together with their `/rembric:<name>` prefixes SHALL be ≤80 tokens (see the token-budget requirement, which owns the always-on total and the measurement unit). Each command body SHALL be ≤3 lines.

#### Scenario: Every argument key exists in the tool's schema

- **WHEN** each file under `apps/plugin/commands/*.md` is parsed for `memory.<tool>({…})` call sites
- **THEN** every argument key named SHALL be a key of that tool's exported zod schema (`memorySearchSchema`, `contextSchema`, `sessionSummarySchema`, `memorySaveSchema`)
- **AND** the build SHALL fail when a key is not

#### Scenario: A renamed tool parameter breaks the build

- **GIVEN** a future change renames a schema key that a command body names
- **WHEN** the test suite runs
- **THEN** the command-argument assertion SHALL fail, naming the command file and the unknown key

#### Scenario: Frontmatter descriptions stay within budget

- **WHEN** each command's frontmatter `description` is measured in UTF-8 bytes
- **THEN** each SHALL be ≤80 bytes (≤20 tokens)
- **AND** the sum of `/rembric:<name> <description>` across all four SHALL be ≤320 bytes (≤80 tokens)

### Requirement: The token budget MUST be stated per firing turn and amortised over the cadence window, in a pinned unit, and asserted in the shared fixtures

Every token figure in this capability SHALL be measured with one pinned proxy: **UTF-8 bytes ÷ 4**, over the stored fixture string and therefore EXCLUDING any trailing newline the emitting script adds. Totals for a whole turn, where a script emits several lines, SHALL include one newline per emitted line — that is the only place the newline counts. `sessionIdTemplate` is measured rendered with a 36-character UUID session id.

Two conventions have to be pinned, not one, and conflating them is what made the ambiguity load-bearing: the canonical post-compact block is 168.0 tokens counted as JS characters and **170.8** counted as UTF-8 bytes, a difference caused by multibyte punctuation. Counting its emitted trailing newline produces 171.0, so quoting that value against the character count would change two variables at once. Per-line caps below are newline-exclusive; turn totals are newline-inclusive. Raising any cap is a deliberate spec edit accompanied by a re-measurement; it is not a test adjustment.

**Always-on cost** (added to every turn while the plugin is enabled, in addition to the MCP tool listings the user already pays for):

- Four command listings (`/rembric:<name> <description>`): ≤80 tokens total.
- **Total: ≤80 tokens**, auditable via `claude plugin details rembric` against a ~100-token ceiling (80 design target plus a 20-token margin).

The plugin ships no skills, so there is no skill description and no skill body in the always-on or on-invoke budget. The previously-published `≤35 tokens` skill-description and `≤500 tokens` skill-body lines were vacuous, and the previous `≤75 tokens` always-on total was satisfiable **only** because the vacuous 35-token line absorbed the four command listings' real cost (~68.8 tokens against a stated `≤40`).

**On-invoke cost**, per hook:

| Surface                                     | Cap                      |
| ------------------------------------------- | ------------------------ |
| `SessionStart` (`startup\|resume\|clear`)   | ≤30 tokens               |
| `SessionStart` (`compact`)                  | ≤175 tokens              |
| `UserPromptSubmit`, per FIRING turn         | ≤240 tokens              |
| `UserPromptSubmit`, amortised over 10 turns | ≤45 tokens/turn          |
| `SessionEnd`                                | 0 tokens                 |
| `PreCompact`                                | 0 tokens                 |
| `PostCompact`                               | 0 tokens                 |
| `Stop` (`stop-sync.sh` handler)             | 0 tokens                 |
| `Stop` (`stop-nudge.sh` handler)            | no fixed cap — see below |

`Stop` carries two independent handler entries in `hooks.json` (`plugin-session-protocol`'s "The summary reminder MUST be delivered at the end of the turn, and MUST NOT re-enter once the host has continued the turn to satisfy it" specifies the second one), and a single `0 tokens` figure for the whole event was true of only one of them. `stop-sync.sh` is the asynchronous raw-transcript sync: a pure side effect, no stdout, `0 tokens`, unchanged. `stop-nudge.sh` is the synchronous end-of-turn summary reminder: it carries the canonical summary structure in full plus the session's own grounded facts, and is deliberately uncapped, unlike every other row in this table — `plugin-session-protocol` states this explicitly ("This is the surface that carries the long form precisely because it has no length budget, unlike a tool description"). Collapsing both handlers under one `0 tokens` row published the opposite of what that requirement already requires of the same handler; the split above is the correction, and it costs nothing else in this table because `stop-nudge.sh` was never actually silent — it already emits `hookSpecificOutput.additionalContext` carrying the rubric and the extracted facts.

`UserPromptSubmit` SHALL be governed by the pair — a per-firing-turn ceiling plus an amortised budget — and not by a flat per-turn figure. The two matcher-less entries fire on **turn 1**, on `count % 5 == 0` (save), on `count == 1 || count % 10 == 0` (summary), and on any turn whose prompt matches a recall keyword, each on its own counter. Turns matching neither cadence nor the keyword emit **zero** tokens. With the 382-byte canonical Markdown summary fixture, measured firing turns are approximately 173.1 (turn 1), 81.3 (turn 5) and 171.6 (turn 10), and 42.6 tokens/turn amortised across ten turns. Turn 1 with a recall keyword measures approximately 195.8, but the independent counters can diverge so all five lines fire together — approximately **225.8** tokens. That reachable case sets the 240-token ceiling. Final fixture output SHALL be re-measured and the exact values recorded with the implementation.

**Per-line caps**, each asserted individually against `apps/plugin/test/nudge-fixtures.json` so a single loose aggregate cannot mask an individual violation:

| Fixture / emitted line           | Cap (bytes) | Cap (tok) |
| -------------------------------- | ----------- | --------- |
| `SessionStart` nudge             | 100         | 25        |
| recall nudge                     | 100         | 25        |
| `firstPromptRelevance`           | 140         | 35        |
| `save`                           | 132         | 33        |
| `sessionIdTemplate` (36-char id) | 224         | 56        |
| `summary`                        | 400         | 100       |
| `postCompact`                    | 700         | 175       |

`endOfTurnRubric` (the `stop-nudge.sh` template) deliberately has NO row in this table, for the same reason the table above gives it no fixed cap: it is the one surface `plugin-session-protocol` specifies as carrying the long form precisely because it has no length budget.

The `sessionIdTemplate` line is the largest single per-turn contributor (51.0 tokens) and SHALL NOT be removed to reduce the budget. Removing it does not reach the previously-published cap anyway — measured without it, firing turns fall only to 91.0 / 30.0 / 89.5 — and it is not redundant: of `resolveActiveSessionId`'s three paths, the `SessionRouter` fallback is populated only by `memory.session_start`, which the plugin never calls because the session lifecycle is HTTP, and `findActiveForTransport` refuses by design to guess under concurrent ambiguity within its staleness window. With two host sessions open on one repository the nudge is the only mechanism that attaches a memory to the right session. Removing it is therefore blocked on a server-side fix to implicit session attachment under concurrency, which is out of scope for this capability.

#### Scenario: Every fixture line has its own asserted budget

- **WHEN** the shared nudge fixtures are measured in UTF-8 bytes
- **THEN** each of `save`, `summary`, `sessionIdTemplate` (rendered with a 36-character id), `firstPromptRelevance`, the recall nudge, the `SessionStart` nudge and `postCompact` SHALL be within its cap in the table above
- **AND** each SHALL be a separate assertion, so one violation is attributable to one line

#### Scenario: The turn-1 firing turn stays under its tighter sub-budget

- **GIVEN** a session driven through real per-session counter files
- **WHEN** turn 1 fires with a recall keyword in the prompt (first-prompt line, recall line, sessionId line, summary line)
- **THEN** the total emitted output SHALL be ≤800 bytes (≤200 tokens) — a tighter sub-budget on the aligned-counter case, NOT the per-firing-turn ceiling

#### Scenario: The two prompt counters diverge and every line fires at once

- **GIVEN** a session where `prompt-nudge.sh`'s counter has reached a multiple of ten while `prompt-search.sh`'s counter is at one
- **WHEN** that turn's prompt also carries a recall keyword
- **THEN** the total emitted output SHALL be ≤960 bytes (≤240 tokens), and this — not turn 1 — is the case the per-firing-turn ceiling is set against

#### Scenario: The amortised budget holds over a cadence window

- **WHEN** ten consecutive `UserPromptSubmit` turns are driven through both matcher-less entries
- **THEN** the sum of all emitted bytes divided by ten SHALL be ≤180 bytes/turn (≤45 tokens/turn)
- **AND** turns 2, 3, 4, 6, 7, 8 and 9 SHALL emit zero bytes when no recall keyword is present

#### Scenario: A side-effect hook emits nothing to the model

- **WHEN** `SessionEnd`, `PreCompact`, `PostCompact`, or the `stop-sync.sh` handler of `Stop` fires under Claude Code
- **THEN** the script SHALL write nothing to stdout

#### Scenario: The Stop reminder handler is exempt from the zero-output cap

- **GIVEN** the `stop-nudge.sh` handler, the second `Stop` entry in `hooks.json`
- **WHEN** it fires under Claude Code at its own cadence
- **THEN** its emitted `hookSpecificOutput.additionalContext` MAY be non-empty
- **AND** it SHALL NOT be held to a fixed byte or token cap by this capability — `plugin-session-protocol`'s end-of-turn summary-reminder requirement governs its content, not the per-hook table above

#### Scenario: Raising a cap requires a re-measurement

- **WHEN** a contributor raises any cap in this requirement
- **THEN** the change SHALL record the new measured value alongside the new cap
- **AND** the corresponding fixture assertion SHALL be updated in the same commit

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, `post-compaction.sh`, `prompt-search.sh`, `prompt-nudge.sh` and `stop-sync.sh` minimal and consistent, the plugin SHALL ship a shared helper at `apps/plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Exposes `rembric_parse_dotenv`, which parses `${cwd}/.rembric` for `PROJECT_SLUG` (reusing the same dotenv parser logic as the bridge). The parser SHALL trim BOTH leading and trailing whitespace from each value before quote-stripping — trailing whitespace SHALL NOT be left in the parsed value, and this trim SHALL also strip a trailing carriage return, so a `.rembric` file saved with CRLF line endings resolves to the same slug the JS bridge (`bin/rembric-dotenv.mjs`, which trims both sides) resolves.
- Exposes `rembric_read_project_slug <cwd>`, the wrapper every hook script actually calls to go from a working directory to a validated slug.
- Exposes `rembric_post <path> <json-body>`, which issues `curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time "${REMBRIC_POST_MAX_TIME:-3}" -d "$body" -w '\n%{http_code}' "$URL"`. The budget SHALL be overridable through `REMBRIC_POST_MAX_TIME` and SHALL default to `3` when unset, so a caller running under a host-imposed budget tighter than 3 seconds can fit the request inside it. Codex's `SessionEnd` is the case that forces this: the host allows that one event 1 second by default and 3 seconds at most, against 600 for every other hook, so a fixed 3-second POST consumes the entire budget and leaves nothing for the transcript read or the failure diagnostic (`codex-distribution`). A caller SHALL set the variable only where a tighter budget applies; every other script inherits the default and SHALL NOT restate it. It SHALL use `-s` and NOT `-f`: the status code is captured via `-w` and split off the response, so that a non-2xx response can be reported with its body in the stderr diagnostic required by `plugin-session-protocol`'s failed-POST requirement. `-f` would suppress exactly that body. An empty body argument SHALL be normalised to `{}`.
- Exposes `rembric_turn_count <counter-name> <session-id>`, an atomic per-session turn counter. Each caller passes a distinct `counter-name` so independent cadences never double-increment one another (`rembric-turnnudge` for `prompt-nudge.sh`, `rembric-relevance-prefetch` for `prompt-search.sh`). It SHALL append one byte and count the file's bytes rather than read-increment-write, because a single `O_APPEND` write is atomic across concurrent invocations. It SHALL echo the new count, or NOTHING when the counter is unreadable — callers MUST treat empty as fail-closed, since defaulting to `0` satisfies every modulo and equality check at once and would fire every nudge on every turn.
- Exposes `rembric_json_escape <string>` that escapes for embedding in a JSON value: backslash, double quote, and every control character in the range U+0000–U+001F. `\n`, `\r`, and `\t` SHALL use their short escape forms; every other character in that range (e.g. an ANSI escape from pasted colored terminal output) SHALL be escaped as `\u00XX` so the output is always valid JSON. Characters at or above U+0020 (including `\x7f`/DEL, which JSON does not require escaping) SHALL be left untouched.
- Exposes stdin-field extractors `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, `rembric_transcript_path_from_stdin_json`, `rembric_prompt_from_stdin_json` (the `prompt` field, consumed by `prompt-search.sh`'s keyword self-filter), and `rembric_compaction_summary_from_stdin_json`. The compaction-summary extractor SHALL prefer `compaction_summary` and SHALL fall back to `compactionSummary` (in case Codex uses camelCase, per the same precedent that `session_id`/`sessionId` already follows).
- Returns `0` even on failure (so callers can `|| true` safely). `rembric_post` discards the response body from stdout; it does NOT suppress the stderr diagnostic.

The sibling helper `apps/plugin/scripts/_transcript.sh` exposes `rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`, `rembric_format_transcript_codex_cli`, `rembric_extract_first_assistant_codex_cli`, and `rembric_redact_private` — the mandatory client-side redaction choke point specified by `plugin-session-protocol`'s `<private>`-span requirement. `post-compaction.sh` routes the compaction summary through `rembric_redact_private` because the compactor quotes conversation content verbatim, making that payload transcript-derived. Any new script sending transcript-derived text SHALL route it through the same function.

`pre-compact.sh <agent>` SHALL detect the agent from `$1` (the same convention `session-start.sh` and `stop-sync.sh` use, defaulting to `$REMBRIC_AGENT` then `claude-code`) and dispatch to the matching per-client transcript variants. There is no per-client copy of the script.

Each hook script SHALL `source` `_api.sh` (and `_transcript.sh` where transcript handling is needed) and SHALL NOT inline the curl invocation or transcript parsing directly. The helpers SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: New helpers are sourced by the new scripts

- **WHEN** `pre-compact.sh` or `post-compaction.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** each SHALL also `source "${SCRIPT_DIR}/_transcript.sh"` (transcript handling needed)
- **AND** neither SHALL inline a literal `curl` invocation outside the helper

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
- **THEN** the output SHALL contain the `` escape in place of the raw byte
- **AND** embedding the output as a JSON string value and parsing it back SHALL reproduce the original byte exactly

### Requirement: The plugin MUST NOT implement migration or coexistence behaviors with other agent memory systems

This capability SHALL NOT specify migration prompts, import flows, side-by-side coexistence rules, or compatibility shims with other agent memory systems. Rembric is positioned as the sole memory layer for any agent it is enabled on; the plugin's hook scripts, MCP bridge, command catalogue, and any server-delivered protocol guidance SHALL be authored under the assumption that no second memory system is active on the same agent. Operators with another memory tool installed SHALL be guided (via the plugin's README) to uninstall it before enabling this plugin, but the plugin itself SHALL NOT attempt detection, warning, or graceful coexistence with such tools.

#### Scenario: Plugin hook scripts do not check for or interoperate with other memory systems

- **WHEN** the plugin's hook scripts (`session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, `post-compaction.sh`, `prompt-search.sh`, `prompt-nudge.sh`, `stop-sync.sh`) and the bundled MCP bridge (`apps/plugin/bin/rembric-bridge.mjs`) are inspected
- **THEN** none SHALL contain logic that detects, warns about, defers to, or imports state from any agent memory tool other than Rembric
- **AND** none SHALL name a specific third-party memory tool in their output, comments, or stderr diagnostics

#### Scenario: Protocol guidance does not instruct the agent to migrate from or compare with other memory systems

- **WHEN** the protocol guidance the agent receives is read — server-side via the MCP `initialize.instructions` handshake (`apps/server/src/mcp/instructions.ts`), and client-side via the command bodies under `apps/plugin/commands/` and the hook-emitted nudges
- **THEN** none SHALL direct the agent to import from, deduplicate against, prefer Rembric over, or otherwise reason about parallel memory tools
- **AND** each SHALL describe Rembric's memory protocol on its own terms, without comparison to other agent memory systems

#### Scenario: README warns about parallel installations without naming alternatives

- **WHEN** the plugin README is rendered (e.g. on GitHub)
- **THEN** the operator guidance about parallel-tool drift SHALL state that this plugin is the sole memory layer and SHALL warn against having another memory tool installed
- **AND** the guidance SHALL NOT name any specific third-party memory tool by name

### Requirement: The bridge MUST pin the `mcp-remote` version

The bridge (`apps/plugin/bin/rembric-bridge.mjs`) SHALL spawn `mcp-remote` at an exact pinned version (`mcp-remote@<x.y.z>`), never a floating tag such as `@latest`. The pinned version SHALL be bumped deliberately as part of plugin releases.

Before spawning `mcp-remote`, the bridge SHALL perform one `GET ${REMBRIC_SERVER_URL}/healthz` request (reusing the same bearer token it holds for the MCP connection) with a short timeout (2 seconds). On success, the bridge SHALL compare the response's `version` field against a `MIN_SERVER_VERSION` constant bumped alongside the plugin's own version. When the server's version is older than `MIN_SERVER_VERSION` (semver comparison), the bridge SHALL print exactly one line to stderr naming both versions and pointing at the dashboard self-update flow / `docs/updates.md`, then proceed to spawn `mcp-remote` unchanged — the check is advisory only and SHALL NOT block or delay the connection. When the `/healthz` request fails for any reason (network error, timeout, non-200, malformed body), the bridge SHALL silently skip the check and proceed exactly as if no check existed — this MUST NOT introduce a new failure mode for environments where `/healthz` is unreachable but `/mcp` is fine (e.g. transient DNS blips, a reverse proxy exposing only `/mcp`).

This bridge is shared unmodified by the Codex CLI plugin (`.codex-plugin/mcp.json` spawns the same `rembric-bridge.mjs`) and by the opencode plugin's stdio-transport reuse (`opencode-plugin/spec.md`'s "MCP transport reuses the existing stdio bridge" requirement); both clients inherit this version-handshake behavior with no client-specific spec text needed, since the check is entirely internal to the shared bridge script.

#### Scenario: Session start does not re-resolve `latest`

- **WHEN** the bridge spawns the transport
- **THEN** the npx argument SHALL name an exact `mcp-remote@<x.y.z>` version, so a newly published upstream release cannot change behavior without a Rembric plugin release

#### Scenario: Upstream publishes a broken release

- **WHEN** a broken `mcp-remote` version is published to npm
- **THEN** existing Rembric installations SHALL be unaffected (they keep spawning the pinned version)

#### Scenario: Bridge warns on an outdated server

- **GIVEN** `/healthz` responds successfully with a `version` older than the bridge's `MIN_SERVER_VERSION`
- **WHEN** the bridge starts
- **THEN** it SHALL print exactly one stderr line naming both the server's version and the expected minimum, and pointing at the update flow
- **AND** it SHALL still spawn `mcp-remote` and connect normally

#### Scenario: Bridge is silent when the server meets the minimum version

- **GIVEN** `/healthz` responds successfully with a `version` at or above `MIN_SERVER_VERSION`
- **WHEN** the bridge starts
- **THEN** no version-related stderr line SHALL be printed

#### Scenario: A healthz failure does not block or warn

- **GIVEN** the `/healthz` request times out, errors, or returns a non-200 status
- **WHEN** the bridge starts
- **THEN** no version-related stderr line SHALL be printed
- **AND** the bridge SHALL proceed to spawn `mcp-remote` exactly as it would without this requirement

### Requirement: The plugin SHALL ship a unified `UserPromptSubmit` per-turn nudge hook

The plugin's hook catalog (`apps/plugin/hooks/hooks.json`) SHALL declare a matcher-less `UserPromptSubmit` entry — distinct from the existing keyword-gated recall entry (`prompt-search.sh`) — invoking a new shared script `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh` that carries BOTH the save and the session-summary reminders on a per-turn cadence. The plugin SHALL NOT ship a `PostToolUse` save-nudge hook (the prior `post-tool.sh` approach is removed; `hooks.json` SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder).

- The entry SHALL declare NO matcher, so it fires on every user prompt. Claude Code supports multiple entries per hook event (`SessionStart` already declares two), so this coexists with the recall entry.
- The script SHALL read `session_id` from hook stdin and maintain a per-session turn counter file under `${TMPDIR:-/tmp}/rembric-turnnudge/<sanitized-session-id>`, incrementing once per invocation.
- On each turn the script SHALL emit, as PLAIN text on stdout (NOT a `hookSpecificOutput` JSON object — plain stdout is the documented `UserPromptSubmit` injection shape):
  - the **save** nudge line when `count % 5 == 0`;
  - the **summary** nudge line ONLY when `count == 1`.
  - The every-`SUMMARY_NUDGE_EVERY` firing MOVED to the end-of-turn reminder (see `plugin-session-protocol`), because the start of a turn is the one moment a summary reminder cannot be acted on — there is always more work coming. What remains here is the first turn, which establishes the obligation rather than reminding about work already done. The two lines therefore coincide only on turn 1 if the save cadence also fires; zero lines are emitted on turns matching neither.
- Both nudge texts SHALL be `rembric:`-prefixed (so the shared Codex path's `looks_like_json` heuristic does not flag them). The save text directs `memory.save` (title ≤100 + content); the summary text directs `memory.session_summary({title≤100, summary})` with the canonical section list defined in `sessions`. Both SHALL be byte-identical to the opencode and Hermes copies, and the section list SHALL be derived from its single source rather than restated.
- The script SHALL make NO network call and needs no `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN`.
- The script SHALL fail safe: unreadable/empty stdin, an unreadable OR unwritable counter file, or any other error SHALL exit `0` AND emit NOTHING (no save or summary line). A broken counter mechanism SHALL NOT be treated as an implicit `count=0` — that value satisfies BOTH firing thresholds (`0 % 5 == 0` and `0 % 10 == 0`) and would fire every nudge on every single turn instead of none.

#### Scenario: Save nudge fires every 5th turn

- **GIVEN** the plugin is installed and a Claude Code session
- **WHEN** `UserPromptSubmit` fires for the 5th time with stdin `{"session_id":"claude-sess-abc"}`
- **THEN** `prompt-nudge.sh` SHALL emit the plain `rembric:` save nudge on stdout
- **AND** SHALL NOT emit the save nudge on turns 1–4

#### Scenario: Summary nudge fires on turn 1 and every 10th turn

- **WHEN** `UserPromptSubmit` fires for the 1st time in a session
- **THEN** `prompt-nudge.sh` SHALL emit the plain `rembric:` summary nudge
- **AND** SHALL emit it again on turn 10 (`count % 10 == 0`) and not on turns 2–9

#### Scenario: Both nudges emit on a coinciding turn

- **WHEN** the turn count is a multiple of 10 (both `%5` and `%10` match)
- **THEN** `prompt-nudge.sh` SHALL emit BOTH the save line and the summary line as plain stdout (two lines), neither replacing the other

#### Scenario: No PostToolUse save-nudge hook exists

- **WHEN** `apps/plugin/hooks/hooks.json` is inspected
- **THEN** it SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder
- **AND** `apps/plugin/scripts/post-tool.sh` SHALL NOT exist

#### Scenario: Fail-safe on unreadable stdin

- **WHEN** `UserPromptSubmit` fires and stdin is empty or unparseable
- **THEN** `prompt-nudge.sh` SHALL exit 0 and emit nothing that breaks the host

#### Scenario: Fail-closed when the counter file is unwritable

- **GIVEN** `${TMPDIR:-/tmp}/rembric-turnnudge` cannot be created or the per-session counter file cannot be read back (e.g. a path component exists as a regular file, or the directory is not writable)
- **WHEN** `UserPromptSubmit` fires
- **THEN** `prompt-nudge.sh` SHALL exit `0` and emit NEITHER the save nor the summary nudge
- **AND** it SHALL NOT default the turn count to `0` and fire both nudges as a result

#### Scenario: The every-N summary firing is not duplicated here

- **WHEN** `prompt-nudge.sh` runs on a turn where `count % SUMMARY_NUDGE_EVERY == 0` and `count != 1`
- **THEN** it SHALL NOT emit the summary nudge line
- **AND** `SUMMARY_NUDGE_EVERY` SHALL NOT be declared in `prompt-nudge.sh` — the bash cadence has exactly one owner. The in-process clients keep their own copies of the NUMBER (they have no end-of-turn event and fire the reminder themselves), pinned equal by `nudge-fixtures.test.ts`

### Requirement: The first prompt of a session MUST receive a relevance instruction

The recall hook fires a keyword-gated instruction only when the user's prompt matches a recall-intent keyword list. Without a second trigger, every other session would begin with no relevance signal at all, so whether the agent goes looking for prior knowledge would depend on the user's phrasing rather than on whether prior knowledge exists.

On the first user prompt of a session the plugin SHALL therefore emit a bounded, fixed instruction directing the model to call `memory.context` with `focus` set to that prompt before responding. The trigger SHALL fire at most once per session, tracked by its own per-session counter distinct from the per-turn nudge counter. The existing keyword trigger SHALL be retained for explicit recall requests at any point in the session, and both MAY fire on the same turn.

This is an **instruction to the model, not a server-side prefetch**. The hook SHALL make no HTTP request: the emitted text is fixed and byte-identical whether or not the scope contains any relevant memory, and the plugin performs no relevance query of its own. The consequence SHALL be recorded rather than implied — relevance injection depends on the model acting on the instruction, which a prefetch would not. A prefetch was considered and rejected FOR THIS HOOK: it would put an HTTP call on the first prompt of every session, on the latency-critical path, implemented in bash, to replace an instruction that works. Because this hook makes no request, there is no unreachable-server failure mode on this path.

Both statements are scoped to this capability's bash hooks and SHALL NOT be read as a four-client claim. The Hermes provider does implement a real prefetch — `queue_prefetch` in `apps/plugin/.hermes-plugin/__init__.py` POSTs `/memory/recall` and prepends the recalled text to the hint — so on that client the emitted block is corpus-dependent and does have a silent unreachable-server path. That divergence is deliberate: Hermes is an in-process Python provider with no bash latency budget and no per-client duplication cost. It is specified by `hermes-agent-plugin`, which this change does not audit; the two capabilities SHALL NOT be conflated, and a future four-client parity claim about relevance injection has to reconcile them first.

The emitted line SHALL be represented in the shared nudge fixtures with a byte budget asserted in lock-step against the equivalent line in every other client, so the four implementations cannot drift.

#### Scenario: A session with no recall keyword still receives a relevance instruction

- **GIVEN** a project with memories relevant to the user's first prompt
- **WHEN** the first prompt of a session contains no recall-intent keyword
- **THEN** the plugin SHALL emit the fixed first-prompt relevance line directing the model to call `memory.context` with `focus` set to the prompt

#### Scenario: The trigger does not repeat

- **WHEN** the second and subsequent prompts of the same session are submitted
- **THEN** the first-prompt line SHALL NOT be emitted again

#### Scenario: The emitted text does not depend on the corpus

- **GIVEN** two projects, one with many relevant memories and one with none
- **WHEN** the first prompt of a session is submitted in each, through this capability's `prompt-search.sh` hook
- **THEN** the emitted line SHALL be byte-identical in both cases
- **AND** this SHALL NOT be asserted of the Hermes provider, whose prefetch makes the block corpus-dependent by design

#### Scenario: The hook makes no network request

- **WHEN** `apps/plugin/scripts/prompt-search.sh` is inspected
- **THEN** it SHALL contain no call to `rembric_post` and no `curl` invocation
- **AND** it SHALL require neither `REMBRIC_SERVER_URL` nor `REMBRIC_API_TOKEN` to emit either line

#### Scenario: A broken counter does not fabricate a first turn

- **GIVEN** the first-prompt counter directory cannot be created or read back
- **WHEN** `UserPromptSubmit` fires
- **THEN** the first-prompt line SHALL NOT be emitted (fail closed), while the keyword trigger SHALL still be evaluated

#### Scenario: The injected line is fixture-covered

- **WHEN** the first-prompt line diverges from the equivalent line in another client, or exceeds its byte budget
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected

### Requirement: All agent-facing text MUST be English and lock-step tested

Agent-facing instruction text is a protocol surface, not user copy. It fires at the moment of highest consequence — for the post-compaction block, the model has just lost its context and this text is the only instruction telling it what to persist before continuing. A mid-conversation language switch degrades instruction-following and reliably causes the model to continue answering in that language, which is user-visible.

Every string emitted to a model by the plugin SHALL be English. Each such string SHALL be represented in the shared nudge fixtures and asserted in lock-step against the equivalent string in every other client that emits it, **with its own individual byte budget** taken from the token-budget requirement's per-line table. One aggregate assertion SHALL NOT stand in for the individual ones: a single loose aggregate is how a 138-token block passed CI against a published `≤120` cap for its entire lifetime.

#### Scenario: The post-compaction block is English

- **WHEN** the post-compaction hook emits its protocol block
- **THEN** the emitted text SHALL be English

#### Scenario: The block is covered by the shared fixtures

- **WHEN** the post-compaction text diverges from the equivalent text in another client
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected

#### Scenario: Every fixture string has an individual budget assertion

- **WHEN** `apps/plugin/test/nudge-fixtures.test.ts` is inspected
- **THEN** each agent-facing fixture SHALL carry its own byte-budget assertion matching the token-budget requirement's per-line table
- **AND** no fixture with an entry in that table SHALL be left without an assertion

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
