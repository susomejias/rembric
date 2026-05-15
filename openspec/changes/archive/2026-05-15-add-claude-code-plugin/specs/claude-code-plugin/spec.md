# claude-code-plugin

Distribution and configuration of Rembric's Claude Code plugin. Defines the manifest contract, the HTTP MCP server entry with path-scoped URL, the hook output discipline, and the token budget envelope.

## Plugin manifest

- The plugin SHALL be packaged in this monorepo at `plugin/` with the manifest at `plugin/.claude-plugin/plugin.json`.
- The manifest SHALL declare `name: "rembric"` for namespacing of commands (`/rembric:*`) and agent listings.
- The manifest SHALL declare exactly two `userConfig` fields:
  - `server_url`: `type: "string"`, `required: true`. Base URL of the user's Rembric deployment WITHOUT the `/mcp` suffix. The plugin appends `/mcp` itself.
  - `api_token`: `type: "string"`, `required: true`, `sensitive: true`. Stored in the system keychain, never in `settings.json`.
- The manifest SHALL NOT declare a `project_slug` userConfig field. The active project is signalled per directory via a `.rembric-slug` file (see [Project slug selection](#project-slug-selection)).
- The manifest SHALL declare `mcpServers: "./mcp.json"` and SHALL NOT inline server configuration in `plugin.json`.

## Marketplace declaration

- A `.claude-plugin/marketplace.json` SHALL exist at the repository root.
- The marketplace SHALL declare exactly one plugin entry whose `source` is a relative path string (`"./plugin"`).
- The marketplace SHALL be installable via `claude plugin marketplace add <repo>` using each user's existing git credentials (SSH key or PAT) when fetched from git, or directly from a local path during development.

## MCP server declaration

- `plugin/mcp.json` SHALL declare a single MCP server entry named `rembric`.
- The server entry SHALL use `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]`, spawning the local bridge as a stdio MCP server.
- The bridge SHALL receive `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` via `env`, sourced from `${user_config.server_url}` and `${user_config.api_token}` respectively.
- The plugin SHALL NOT use a direct `type: "http"` MCP server entry; the bridge mediates traffic so that the URL can be path-scoped with the slug read from `.rembric-slug` at session start.

## MCP bridge contract

- The plugin SHALL ship `plugin/bin/rembric-bridge.mjs`, a Node ≥18 script that acts as a stdio MCP server for Claude Code while forwarding to Rembric over HTTP.
- The bridge SHALL read the project directory from `CLAUDE_PROJECT_DIR` if set, otherwise from `process.cwd()`. This makes the bridge reusable from non-Claude-Code clients that launch stdio MCP servers.
- The bridge SHALL look for `${projectDir}/.rembric-slug`. If the file exists and its first non-empty line matches `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, the bridge SHALL construct the URL `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped).
- If `.rembric-slug` is missing OR its content does not match the slug regex, the bridge SHALL write a one-line stderr diagnostic and fall back to path-less `${REMBRIC_SERVER_URL}/mcp`. The bridge SHALL NOT abort in this case — the session continues with global scope (or whatever pinning the agent later does).
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

The plugin SHALL ship exactly four hooks at `plugin/hooks/hooks.json`:

### SessionStart

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh`.
- The script SHALL read `${CLAUDE_PROJECT_DIR}/.rembric-slug` (falling back to `$PWD/.rembric-slug`) if present. If a non-empty first line is found, the script SHALL emit a directive nudge of the form: `[rembric] Active project for this directory: <slug>. On your first memory tool call this session, first call project.use({slug:'<slug>', create:true}) to pin the scope, then proceed with the original call.` If no slug file is present or readable, the script SHALL emit the generic nudge `[rembric] If this is a continuation of recent work, call memory.context before responding.`
- Output cap: ≤60 tokens for the directive nudge with slug; ≤30 tokens for the generic nudge.

### UserPromptSubmit

- Type: `command`.
- Matcher: `remember|recall|acordate|qué hicimos|what did we do` (case-insensitive).
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh`.
- The script SHALL emit a single short nudge line instructing the agent to call `memory.search` with the user's keywords before responding.
- Output cap: ≤30 tokens.

### PreCompact

- Type: `mcp_tool`.
- Server: `rembric`.
- Tool: `memory.session_summary`.
- Arguments: `{ auto: true }`.
- Side-effect only. No model-visible output expected.

### PostCompact

- Type: `command`.
- Action: invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh`.
- The script SHALL emit a single short nudge line instructing the agent to call `memory.context` to reload state after compaction.
- Output cap: ≤30 tokens.

### Why nudges rather than fetchers

Hook scripts are intentionally minimal (`echo` + `exit 0`) rather than full MCP clients that fetch and format results. Speaking the MCP Streamable HTTP wire protocol from bash + curl (handshake, session-id headers, SSE parsing) is awkward and brittle. A one-line nudge costs ~20 tok per fire vs ~150 tok for a fetched-and-rendered result, paying only one extra tool call from the agent in the same turn. The `rembric-memory` skill already documents which tool to call; the hooks just trigger the reminder at the right lifecycle moment.

## Hook script invariants

- Every hook script SHALL use `#!/usr/bin/env bash` and `set -u`.
- Every script SHALL trap errors (`trap 'exit 0' ERR`) and ensure `exit 0` with empty stdout on any failure. Plugin-side failure SHALL NOT break a Claude Code session.
- Every script SHALL be executable (mode 755).

## Project slug selection

The active Rembric project is signalled per directory by a `.rembric-slug` file containing the slug as its first non-empty line. The plugin's bridge (`bin/rembric-bridge.mjs`) reads this file at MCP session startup and path-scopes the URL accordingly.

**Format requirements:**

- The slug MUST match `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.
- Lowercase letters, digits, hyphens only. Maximum 64 characters.
- The `.rembric-slug` file SHALL contain the slug as its first non-empty line. Trailing whitespace and `\r` characters SHALL be stripped before use.

**Lookup location:**

- The bridge SHALL check `${CLAUDE_PROJECT_DIR}/.rembric-slug` if the env var is set, otherwise `${process.cwd()}/.rembric-slug`.
- File absence or invalid content is permitted; the bridge falls back to path-less `/mcp` with a stderr diagnostic. The session continues to operate, possibly in global scope.

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
- `PostCompact` hook output: ≤30 tokens (nudge only).

The plugin SHALL be auditable via `claude plugin details rembric` to verify the always-on cost does not exceed ~100 tokens (75 design target plus a 25-token margin).

## Out-of-scope behaviors

This capability does not specify:

- A stdio→HTTP bridge for filesystem-side slug resolution. Considered and rejected for v1; possible opt-in in a future change.
- A local stdio mode for Rembric. The plugin is a configuration layer for the existing HTTP server.
- Migration prompts or coexistence behavior with engram, agentmemory, or other memory tools. Rembric is positioned as the sole memory layer.
- A public plugin marketplace. The plugin remains private to the monorepo's audience; a future change may extract it via `git subtree split` for public distribution.
- Server-side changes to `deriveSlugFromUri` or other Rembric internals. The plugin sits entirely on the client side.
