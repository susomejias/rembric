# claude-code-plugin

Distribution and configuration of Rembric's Claude Code plugin. Defines the manifest contract, the HTTP MCP server entry with path-scoped URL, the hook output discipline, and the token budget envelope.

## Plugin manifest

- The plugin SHALL be packaged in this monorepo at `plugin/` with the manifest at `plugin/.claude-plugin/plugin.json`.
- The manifest SHALL declare `name: "rembric"` for namespacing of commands (`/rembric:*`) and agent listings.
- The manifest SHALL declare exactly two `userConfig` fields:
  - `server_url`: `type: "string"`, `required: true`. Base URL of the user's Rembric deployment WITHOUT the `/mcp` suffix. The plugin appends `/mcp` itself.
  - `api_token`: `type: "string"`, `required: true`, `sensitive: true`. Stored in the system keychain, never in `settings.json`.
- The manifest SHALL NOT declare a `project_slug` userConfig field. The active project is signalled per directory via a `.rembric` config file (see [Project slug selection](#project-slug-selection)).
- The manifest SHALL declare `mcpServers: "./.claude-plugin/mcp.json"` and SHALL NOT inline server configuration in `plugin.json`.

## Marketplace declaration

- A `.claude-plugin/marketplace.json` SHALL exist at the repository root.
- The marketplace SHALL declare exactly one plugin entry whose `source` is a relative path string (`"./plugin"`).
- The marketplace SHALL be installable via `claude plugin marketplace add <repo>` using each user's existing git credentials (SSH key or PAT) when fetched from git, or directly from a local path during development.

## MCP server declaration

- `plugin/.claude-plugin/mcp.json` SHALL declare a single MCP server entry named `rembric`.
- The server entry SHALL use `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]`, spawning the local bridge as a stdio MCP server.
- The bridge SHALL receive `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` via `env`, sourced from `${user_config.server_url}` and `${user_config.api_token}` respectively.
- The plugin SHALL NOT use a direct `type: "http"` MCP server entry; the bridge mediates traffic so that the URL can be path-scoped with the slug read from `.rembric` at session start.

## MCP bridge contract

- The plugin SHALL ship `plugin/bin/rembric-bridge.mjs`, a Node ≥18 script that acts as a stdio MCP server for Claude Code while forwarding to Rembric over HTTP.
- The bridge SHALL read the project directory from `CLAUDE_PROJECT_DIR` if set, otherwise from `process.cwd()`. This makes the bridge reusable from non-Claude-Code clients that launch stdio MCP servers.
- The bridge SHALL look for `${projectDir}/.rembric`. If the file exists, the bridge SHALL parse it as dotenv-style `KEY=VALUE` lines (with `#` line comments and optional matched-quote stripping) and read `PROJECT_SLUG`. If `PROJECT_SLUG` is defined and matches `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, the bridge SHALL construct the URL `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped).
- If `.rembric` is missing, unparseable, lacks `PROJECT_SLUG`, or `PROJECT_SLUG` does not match the slug regex, the bridge SHALL write a one-line stderr diagnostic and fall back to path-less `${REMBRIC_SERVER_URL}/mcp`. The bridge SHALL NOT abort in this case — the session continues with global scope (or whatever pinning the agent later does).
- The bridge SHALL delegate the actual stdio↔Streamable-HTTP-MCP transport to `npx -y mcp-remote@latest`, injecting `Authorization: Bearer ${REMBRIC_API_TOKEN}` on every request and passing the `--allow-http` flag so that plain-HTTP LAN deployments (e.g. `http://192.168.x.y:8787`) are accepted. For HTTPS deployments the flag is a no-op.
- The bridge SHALL NOT parse, rewrite, or inspect MCP frames beyond what `mcp-remote` itself does. It is purely a URL-building entrypoint.
- The bridge SHALL write one diagnostic line to stderr at startup of the form `[rembric-bridge] cwd=<cwd> url=<url>` to aid debugging via `claude --debug`.
- If `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are missing, the bridge SHALL exit non-zero with a clear stderr message instructing the user to configure the plugin.
- The bridge SHALL forward the child process's exit code; if the child terminates from a signal, the bridge SHALL re-raise that signal in its own process.

## Skill catalog

- The plugin SHALL NOT ship any skills. The proactive-save protocol (when to save, when to recall, how to close a session, topic_key usage, candidate-resolution) is delivered server-side via Rembric's MCP `initialize.instructions` handshake (`src/mcp/instructions.ts`), so it applies uniformly to every MCP client (Claude Code plugin, Codex CLI, Cursor, custom integrations) without per-client duplication.
- An earlier iteration shipped a `rembric-memory` skill with the same content; it was removed once `initialize.instructions` was verified to carry equivalent guidance under the 800-character hard limit enforced by `instructions.test.ts`.

## Command catalog

- The plugin SHALL ship exactly four commands under `/rembric:*`:
  - `remember <text>` → `memory.save({type: 'project', content: '$ARGUMENTS'})`
  - `recall <topic>` → `memory.search({q: '$ARGUMENTS', limit: 5})`, rendered compactly
  - `context` → `memory.context({limit: 10})`, rendered compactly
  - `summary` → `memory.session_summary({auto: true})`
- Each command's frontmatter description SHALL be ≤10 tokens.
- Each command body SHALL be ≤3 lines.

## Hook catalog

### Requirement: The plugin SHALL ship exactly four hooks at `plugin/hooks/hooks.json`

The plugin's hook catalog SHALL declare four entries: `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `Stop`. The `PostCompact` event SHALL NO LONGER be wired in this version — its prior responsibility (nudge to call `memory.context`) is folded into the `SessionStart` hook output, which already fires on resume.

#### SessionStart

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh`.
- The script SHALL read `session_id` and `cwd` from hook stdin (Claude Code passes these as JSON).
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG` using the same dotenv parser as the bridge (see `plugin/bin/rembric-bridge.mjs`).
- When a valid slug is resolved, the script SHALL issue `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and body `{ "id": "<session_id>", "cwd": "<cwd>" }`. The script SHALL discard the response body and SHALL NOT block on slow networks (`--max-time 3`).
- When no valid slug is resolvable, the script SHALL skip the POST and write a one-line stderr diagnostic; no session row is created (the agent can still operate path-less).
- After the POST attempt (success or skip), the script SHALL emit the generic nudge `[rembric] If this is a continuation of recent work, call memory.context before responding.` to stdout.
- Output cap: ≤30 tokens.
- The script SHALL exit `0` on any internal error (`trap 'exit 0' ERR`) so plugin failure NEVER aborts a Claude Code session.

#### UserPromptSubmit

- Type: `command`.
- Matcher: `remember|recall|acordate|qué hicimos|what did we do` (case-insensitive).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- The script SHALL emit a single short nudge line instructing the agent to call `memory.search` with the user's keywords before responding.
- Output cap: ≤30 tokens.

#### PreCompact

- Type: `command` (CHANGED from `mcp_tool`).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh`.
- The script SHALL read `session_id` and the compaction transcript/summary from hook stdin.
- The script SHALL read `${cwd}/.rembric` for `PROJECT_SLUG`.
- When `session_id` and slug both resolve, the script SHALL issue `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{ "summary": "<compact transcript>" }`. The body SHALL be the verbatim compact summary the hook receives; no transformation, no LLM call.
- The script SHALL discard the response and SHALL NOT emit any stdout (PreCompact output is not seen by the model).
- The script SHALL exit `0` on any error.

#### Stop

- Type: `command` with `async: true`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh`.
- The script SHALL read `session_id` from hook stdin and `${cwd}/.rembric` for `PROJECT_SLUG`.
- When both resolve, the script SHALL issue `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with an empty body.
- The script SHALL discard the response, SHALL emit no stdout, and SHALL exit `0` on any error.

#### Scenario: SessionStart hook creates a session in Rembric

- **GIVEN** the plugin is installed, `${cwd}/.rembric` contains `PROJECT_SLUG=foo`, project `foo` exists, and `REMBRIC_SERVER_URL` is reachable
- **WHEN** Claude Code fires the `SessionStart` hook with stdin `{"session_id": "claude-sess-abc12345", "cwd": "/home/u/foo"}`
- **THEN** the script SHALL POST to `${REMBRIC_SERVER_URL}/api/foo/sessions` with body `{"id": "claude-sess-abc12345", "cwd": "/home/u/foo"}`
- **AND** the server SHALL insert a row for `(token_id, 'claude-sess-abc12345')`
- **AND** the script SHALL still emit the `[rembric] If this is a continuation...` nudge on stdout
- **AND** `/dashboard/sessions` SHALL list the new active session

#### Scenario: SessionStart hook with missing .rembric

- **WHEN** the `SessionStart` hook fires and `${cwd}/.rembric` does not exist
- **THEN** the script SHALL skip the POST, emit a stderr diagnostic, and still emit the standard nudge on stdout
- **AND** the script SHALL exit `0`

#### Scenario: SessionStart hook with server unreachable

- **WHEN** the `SessionStart` hook fires and the POST times out or fails
- **THEN** the script SHALL exit `0` with the nudge on stdout — Claude Code MUST NOT be broken by Rembric unavailability

#### Scenario: PreCompact persists the compact summary

- **GIVEN** the SessionStart hook earlier registered session `claude-sess-abc12345`
- **WHEN** Claude Code fires the `PreCompact` hook with stdin containing the session_id and a compact summary
- **THEN** the script SHALL POST to `/api/foo/sessions/claude-sess-abc12345/summary` with the summary text
- **AND** the server SHALL transition the row to `status='ended'` with that summary persisted

#### Scenario: Stop hook closes the session

- **WHEN** Claude Code fires the `Stop` hook for an active session
- **THEN** the script SHALL POST to `/api/foo/sessions/<session_id>/end`
- **AND** the server SHALL transition the row to `status='ended'` with `ended_at=now` and `summary=NULL`

#### Scenario: Stop hook fires after PreCompact already ended the session

- **GIVEN** PreCompact already transitioned the session to `status='ended'` with a summary
- **WHEN** the `Stop` hook fires and POSTs to `/end`
- **THEN** the server SHALL respond `409 session_already_ended` and the script SHALL exit `0`
- **AND** the session row SHALL remain in `ended` state with its prior summary intact

### Requirement: The plugin SHALL ship a thin curl helper at `${CLAUDE_PLUGIN_ROOT}/scripts/_api.sh`

To keep `session-start.sh`, `pre-compact.sh`, and `session-stop.sh` minimal and consistent, the plugin SHALL ship a shared helper at `plugin/scripts/_api.sh` that:

- Resolves `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from the environment.
- Parses `${cwd}/.rembric` for `PROJECT_SLUG` (reuses the same dotenv parser logic).
- Exposes a function `rembric_post <path> <json-body>` that issues `curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time 3 -d "$body" "$URL"`.
- Discards stdout and returns `0` even on failure (so callers can `|| true` safely).

Each hook script SHALL `source` this helper and SHALL NOT inline the curl invocation directly. The helper SHALL respect the same "exit 0 on error" discipline as the existing scripts.

#### Scenario: Helper is sourced by all three new scripts

- **WHEN** `session-start.sh`, `pre-compact.sh`, or `session-stop.sh` are read
- **THEN** each SHALL start with `source "${SCRIPT_DIR}/_api.sh"` (where `SCRIPT_DIR` is the script's own directory)
- **AND** none SHALL inline a literal `curl` invocation outside the helper

#### Scenario: Helper fails silently when env is incomplete

- **WHEN** `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` is missing
- **THEN** the helper SHALL emit a one-line stderr diagnostic and `rembric_post` SHALL return `0` without issuing a request

### Why nudges rather than fetchers

Hook scripts are intentionally minimal (`echo` + `exit 0`) rather than full MCP clients that fetch and format results. Speaking the MCP Streamable HTTP wire protocol from bash + curl (handshake, session-id headers, SSE parsing) is awkward and brittle. A one-line nudge costs ~20 tok per fire vs ~150 tok for a fetched-and-rendered result, paying only one extra tool call from the agent in the same turn. The `rembric-memory` skill already documents which tool to call; the hooks just trigger the reminder at the right lifecycle moment.

## Hook script invariants

- Every hook script SHALL use `#!/usr/bin/env bash` and `set -u`.
- Every script SHALL trap errors (`trap 'exit 0' ERR`) and ensure `exit 0` with empty stdout on any failure. Plugin-side failure SHALL NOT break a Claude Code session.
- Every script SHALL be executable (mode 755).

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

- The first time the bridge connects with a slug that does not yet correspond to a Rembric project, the agent — guided by the `rembric-memory` skill — can call `project.use({slug, create: true})` once to create it. Subsequent connections find the project already created and skip the bootstrap.

**Manual override during a session:**

- The agent can always call `project.use({slug: 'something-else', create: true})` to switch scope mid-session. This is independent of the bridge's URL path.

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
- Migration prompts or coexistence behavior with engram, agentmemory, or other memory tools. Rembric is positioned as the sole memory layer.
- A public plugin marketplace. The plugin remains private to the monorepo's audience; a future change may extract it via `git subtree split` for public distribution.
- Server-side changes to `deriveSlugFromUri` or other Rembric internals. The plugin sits entirely on the client side.
