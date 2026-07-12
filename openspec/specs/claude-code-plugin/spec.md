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
- If `.rembric` is missing, unparseable, lacks `PROJECT_SLUG`, or `PROJECT_SLUG` does not match the slug regex, the bridge SHALL write a one-line stderr diagnostic and fall back to path-less `${REMBRIC_SERVER_URL}/mcp`. The bridge SHALL NOT abort in this case — the session continues with global scope (or whatever pinning the agent later does).
- The bridge SHALL delegate the actual stdio↔Streamable-HTTP-MCP transport to `npx -y mcp-remote` at a pinned exact version (see "The bridge MUST pin the `mcp-remote` version" below), injecting `Authorization: Bearer ${REMBRIC_API_TOKEN}` on every request and passing the `--allow-http` flag so that plain-HTTP LAN deployments (e.g. `http://192.168.x.y:8787`) are accepted. For HTTPS deployments the flag is a no-op.
- The bridge SHALL NOT parse, rewrite, or inspect MCP frames beyond what `mcp-remote` itself does. It is purely a URL-building entrypoint.
- The bridge SHALL write one diagnostic line to stderr at startup of the form `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`, where `<source>` is exactly one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()` — naming which step of the precedence chain produced the resolved directory. This aids debugging via `claude --debug` and `codex` log inspection.
- If `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are missing, the bridge SHALL exit non-zero with a clear stderr message instructing the user to configure the plugin.
- The bridge SHALL forward the child process's exit code; if the child terminates from a signal, the bridge SHALL re-raise that signal in its own process.

## Skill catalog

- The plugin SHALL NOT ship any skills. The proactive-save protocol (when to save, when to recall, how to close a session, topic_key usage, candidate-resolution) is delivered server-side via Rembric's MCP `initialize.instructions` handshake (`apps/server/src/mcp/instructions.ts`), so it applies uniformly to every MCP client (Claude Code plugin, Codex CLI, Cursor, custom integrations) without per-client duplication.
- An earlier iteration shipped a `rembric-memory` skill with the same content; it was removed once `initialize.instructions` was verified to carry equivalent guidance under the 800-character hard limit enforced by `instructions.test.ts`.

## Command catalog

- The plugin SHALL ship exactly four commands under `/rembric:*`:
  - `remember <text>` → `memory.save({type: 'project', title: <concise ≤100-char headline>, content: '$ARGUMENTS'})` (the `title` is required by `memory.save`, so the command directs the agent to supply a short headline derived from the text)
  - `recall <topic>` → `memory.search({q: '$ARGUMENTS', limit: 5})`, rendered compactly
  - `context` → `memory.context({limit: 10})`, rendered compactly
  - `summary` → `memory.session_summary({auto: true})`
- Each command's frontmatter description SHALL be ≤10 tokens.
- Each command body SHALL be ≤3 lines.

## Requirements

### Requirement: The plugin SHALL ship exactly four hooks at `apps/plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare four entries: `SessionStart` (with TWO matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit`, and `SessionEnd`. The prior `Stop` and `PreCompact` entries SHALL NOT be wired in this version. The prior `pre-compact.sh` script SHALL be deleted from the repo.

The prior `Stop` hook was a semantic bug: Claude Code's `Stop` fires once per assistant turn (verified against `code.claude.com/docs/en/hooks`), not at session end. Wiring it to `POST /end` transitioned the session to `ended` on turn 1 and silently failed on every subsequent turn. `SessionEnd` is the correct lifecycle hook for one-per-session terminal behaviour.

The prior `PreCompact` hook had two problems: (1) its stdout is not injected into the model's context (`PreCompact` is documented as "side effects only", unlike `SessionStart`); (2) its POST body was the hook event metadata blob, not the transcript. Removed entirely.

#### SessionStart (matcher: startup|resume|clear)

- Type: `command`.
- Matcher: `startup|resume|clear`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh claude-code`.
- The script SHALL read `session_id`, `cwd`, and `source` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge.
- When a valid slug is resolved, the script SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": "<session_id>", "cwd": "<cwd>", "agent": "claude-code"}`. The server-side handler writes the placeholder title.
- The script SHALL emit the generic nudge `rembric: If this is a continuation of recent work, call memory.context before responding.` to stdout.
- Output cap: ≤30 tokens.

#### SessionStart (matcher: compact)

- Type: `command`.
- Matcher: `compact`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh claude-code` (new script).
- The script SHALL read `session_id` and `cwd` from hook stdin (slug resolution piggybacks on `.rembric` as elsewhere).
- The script SHALL emit an imperative instruction block to stdout, prefixed `rembric:` so Codex's `looks_like_json` heuristic does not flag it. The instruction SHALL direct the model to: (1) call `memory.session_summary({title, summary})` with the compact summary it just produced (which appears in its context above the hook output), specifying Title (≤100 chars, descriptive) and Summary (Goal · Discoveries · Accomplished · Next Steps · Files); (2) call `memory.context` if it needs prior context to continue.
- Output cap: ≤120 tokens (the instruction needs more room than a nudge).
- This stdout IS injected into the model's context, because `SessionStart` is one of the events documented as carrying stdout into context.

#### UserPromptSubmit

- Type: `command`.
- Matcher: `remember|recall|acuérdate|qué hicimos|what did we do` (case-insensitive).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- Behaviour unchanged from prior spec.

#### SessionEnd

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh` (new script, REPLACES `session-stop.sh`).
- The script SHALL read `session_id`, `cwd`, `transcript_path`, and `reason` from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL read `transcript_path` if the file exists, format the transcript via the shared `_transcript.sh` helper (oldest-first `role: content` lines, truncated to 19500 chars), extract a title from the first non-empty assistant message (truncated to 100 chars), and POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}`.
- When `transcript_path` is missing/unreadable/empty, the script SHALL POST `/end {}` (degraded mode — transition without summary).
- The script SHALL discard the response, SHALL emit no stdout (`SessionEnd` is not stdout-injected), and SHALL exit `0` on any error.

#### Scenario: SessionStart hook creates a session and writes the placeholder title

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook (`source: startup`) with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}` at 22:14 UTC
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo", "agent": "claude-code"}`
- **AND** the server SHALL insert a row with `title = 'foo · 22:14 UTC'`, `title_final = false`
- **AND** the script SHALL still emit the `rembric: If this is a continuation...` nudge on stdout

#### Scenario: SessionStart hook with matcher compact injects the imperative instruction

- **WHEN** Claude Code resumes a session from auto-compaction and fires `SessionStart` with `source: 'compact'`
- **THEN** the `post-compact.sh` script SHALL emit a multi-line instruction to stdout prefixed with `rembric:` directing the model to call `memory.session_summary` with the compact summary visible in its context
- **AND** the next model turn SHALL see the instruction in its context and (when cooperating) SHALL call `memory.session_summary({title, summary})` with the model-authored values

#### Scenario: SessionEnd hook captures the transcript and POSTs /end with summary

- **GIVEN** a Claude Code session with at least one assistant turn, whose `transcript_path` JSONL is readable
- **WHEN** Claude Code fires `SessionEnd` with stdin `{"session_id": "...", "transcript_path": "/path/to/transcript.jsonl", "reason": "logout"}`
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

#### Scenario: Hook catalog lives at the new path

- **WHEN** Claude Code consumes the plugin from the marketplace
- **THEN** `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` SHALL resolve to a file whose source-of-truth in this repository is `apps/plugin/hooks/hooks.json`
- **AND** the file SHALL declare the four hooks listed above

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `post-compact.sh`, `session-end.sh`, `pre-compact.sh`, and `post-compaction.sh` minimal and consistent, the plugin SHALL ship a shared helper at `apps/plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Parses `${cwd}/.rembric` for `PROJECT_SLUG` (reuses the same dotenv parser logic).
- Exposes a function `rembric_post <path> <json-body>` that issues `curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time 3 -d "$body" "$URL"`.
- Exposes a function `rembric_json_escape <string>` that escapes for embedding in a JSON value.
- Exposes functions `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, `rembric_transcript_path_from_stdin_json`, AND a new `rembric_compaction_summary_from_stdin_json` that pulls the `compaction_summary` field from hook stdin JSON. The compaction-summary extractor SHALL prefer `compaction_summary` and SHALL fall back to `compactionSummary` (in case Codex uses camelCase, per the same precedent that `session_id`/`sessionId` already follows).
- Discards stdout and returns `0` even on failure (so callers can `|| true` safely).

The sibling helper `apps/plugin/scripts/_transcript.sh` (unchanged) exposes `rembric_format_transcript_claude_code`, `rembric_extract_first_assistant_claude_code`, `rembric_format_transcript_codex_cli`, and `rembric_extract_first_assistant_codex_cli`. The new `pre-compact.sh` consumes the Claude Code variants directly; Codex's `pre-compact.sh` execution SHALL select the codex_cli variants OR (preferred) the script SHALL detect the agent from `$1` (already conventional for `session-start.sh`) and dispatch accordingly. The contract is: `pre-compact.sh <agent>` accepts the same agent name argument as `session-start.sh`.

Each hook script SHALL `source` `_api.sh` (and `_transcript.sh` where transcript handling is needed) and SHALL NOT inline the curl invocation or transcript parsing directly. The helpers SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: New helpers are sourced by the new scripts

- **WHEN** `pre-compact.sh` or `post-compaction.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** `pre-compact.sh` SHALL also `source "${SCRIPT_DIR}/_transcript.sh"` (transcript needed)
- **AND** neither SHALL inline a literal `curl` invocation outside the helper

#### Scenario: rembric_compaction_summary_from_stdin_json accepts both naming conventions

- **WHEN** the helper is called with stdin `{"compaction_summary": "X"}` (snake_case, Claude convention)
- **THEN** it SHALL extract `X`

- **WHEN** the helper is called with stdin `{"compactionSummary": "X"}` (camelCase, in case Codex differs)
- **THEN** it SHALL extract `X`

- **WHEN** the helper is called with stdin lacking both keys
- **THEN** it SHALL emit empty string and exit `0`

<!-- Token budget is a `## Section` in the canonical spec, not a `### Requirement`,
     so it cannot be expressed as a MODIFIED Requirement delta. The output cap for
     `post-compact.sh` declared in that section (≤120 tokens) remains the soft
     target; the sharpened nudge stays well within the input window in practice.
     A future change can convert "Token budget" into a proper Requirement if we
     want it enforceable. -->

### Requirement: The plugin MUST NOT implement migration or coexistence behaviors with other agent memory systems

This capability SHALL NOT specify migration prompts, import flows, side-by-side coexistence rules, or compatibility shims with other agent memory systems. Rembric is positioned as the sole memory layer for any agent it is enabled on; the plugin's hook scripts, MCP bridge, skill content, and command catalogue SHALL be authored under the assumption that no second memory system is active on the same agent. Operators with another memory tool installed SHALL be guided (via the plugin's README) to uninstall it before enabling this plugin, but the plugin itself SHALL NOT attempt detection, warning, or graceful coexistence with such tools.

#### Scenario: Plugin hook scripts do not check for or interoperate with other memory systems

- **WHEN** the plugin's hook scripts (`session-start.sh`, `post-compact.sh`, `session-end.sh`, `prompt-search.sh`) and the bundled MCP bridge (`apps/plugin/bin/rembric-bridge.mjs`) are inspected
- **THEN** none SHALL contain logic that detects, warns about, defers to, or imports state from any agent memory tool other than Rembric
- **AND** none SHALL name a specific third-party memory tool in their output, comments, or stderr diagnostics

#### Scenario: Skill content does not instruct the agent to migrate from or compare with other memory systems

- **WHEN** the plugin's skill content (if any markdown files exist under `apps/plugin/.claude-plugin/skills/`) is read
- **THEN** the skill SHALL NOT direct the agent to import from, deduplicate against, prefer Rembric over, or otherwise reason about parallel memory tools
- **AND** the skill SHALL describe Rembric's memory protocol on its own terms, without comparison to other agent memory systems

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

- The bridge SHALL check `${CLAUDE_PROJECT_DIR}/.rembric` if the env var is set, otherwise `${process.cwd()}/.rembric`.
- File absence, parse failure, missing `PROJECT_SLUG`, or invalid slug are all permitted; the bridge falls back to path-less `/mcp` with a stderr diagnostic. The session continues to operate, possibly in global scope.

**Authority and precedence:**

- When the bridge succeeds in path-scoping, the URL is `${server_url}/mcp/<slug>`. The Rembric server populates `ctx.project` from the URL slug during auth. All tool handlers honor `ctx.project` as the first source of truth, so the project is pinned deterministically without any agent-side `project.use` call.
- When the bridge falls back to path-less `/mcp`, behavior reverts to the standard path-less codepath: roots discovery (if the client advertises `roots`), `project.use` writing to `SessionRouter`, and `scopeFromContext` consulting the router. This makes the plugin a strict superset of the path-less protocol — it works either way.

**Bootstrap for new slugs:**

- The first time the bridge connects with a slug that does not yet correspond to a Rembric project, the agent — guided by the `rembric-memory` skill — can call `project.use({slug, autocreate: true})` once to create it. Subsequent connections find the project already created and skip the bootstrap.

**Manual override during a session:**

- The agent can call `project.use({slug: 'something-else', confirmSwitch: true})` to switch scope (allowed only when no session is active — close it first via `memory.session_summary`; add `autocreate: true` if the target project does not exist yet). This is independent of the bridge's URL path.

## Token budget

Always-on cost (added to every turn while the plugin is enabled, in addition to MCP tool listings the user already pays for):

- Skill description: ≤35 tokens.
- Four command listings: ≤40 tokens total.
- **Total: ≤75 tokens.**

On-invoke cost (paid only when a component fires):

- Skill body: ≤500 tokens (loaded when the skill is invoked).
- `SessionStart` hook output: ≤30 tokens (nudge only).
- `UserPromptSubmit` hook output: ≤30 tokens (nudge only).
- `PreCompact` hook output: 0 tokens to model (side effect).
- `Stop` hook output: 0 tokens to model (side effect).

The plugin SHALL be auditable via `claude plugin details rembric` to verify the always-on cost does not exceed ~100 tokens (75 design target plus a 25-token margin).

## Out-of-scope behaviors

This capability does not specify:

- A stdio→HTTP bridge for filesystem-side slug resolution. Considered and rejected for v1; possible opt-in in a future change.
- A local stdio mode for Rembric. The plugin is a configuration layer for the existing HTTP server.
- A standalone public plugin marketplace listing (e.g., a curated Anthropic-hosted directory). The plugin is shipped from this repository's public marketplace manifest; a future change may extract it via `git subtree split` to distribute as a separate package.
- Server-side changes to `deriveSlugFromUri` or other Rembric internals. The plugin sits entirely on the client side.
