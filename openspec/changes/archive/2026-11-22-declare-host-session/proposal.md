## Why

An MCP write that carries no `sessionId` is attributed by the server alone, through the sole-active lookup over `(token_id, project_id)`. With two terminals on one repository and one token that lookup has no answer, so `memory.save` lands with `session_id = NULL` and `memory.session_summary` is refused (`report-session-ambiguity`). When the model does pass an id it is the least reliable source available: it is lost to compaction and goes stale on `/clear`, which is why the post-compaction block now prints it. The server keeps no per-connection state, by design, so it cannot learn the identity on its own.

The party that always knows the live session is the client's own lifecycle code: the hooks for Claude Code and Codex CLI receive `session_id` on every event, and the in-process plugins for opencode, Hermes Agent and Pi hold it in memory. That id is already the Rembric `sessions.id`, because the same code registered the row over `POST /api/<slug>/sessions`. It just never reaches the MCP requests.

## What Changes

- **A host-declared session on every MCP request.** Clients send `X-Rembric-Session: <session id>`. The server honours it only when the row exists, is owned by the request's token, belongs to the connection's project, is `active` and is not soft-deleted. Otherwise it ignores the header as if it were absent, and never errors on it.
- **The host wins.** For every write-attaching tool (`memory.save`, `memory.confirm`, `memory.merge`, `memory.save_prompt`, `memory.capture_passive`, `memory.session_summary`, `memory.session_end`) and for `memory.context`'s focus seed, an honoured declared session takes precedence over the model's `sessionId` argument. The argument is then ignored without being validated. Without an honoured header, resolution is unchanged: explicit argument, then sole active, then the existing refusal or `NULL`. `memory.session_start` adopts an honoured declared session first, with `reused: true`. `memory.session_resume` keeps its required explicit `sessionId`.
- **Host bindings for stdio-bridge clients.** Claude Code, Codex CLI, opencode and Hermes reach MCP through the published `@rembric/mcp-bridge` process, which knows no session. Their lifecycle code publishes a binding file, "host process (PID + start time) → session id". The bridge looks up the binding of its nearest ancestor process on every request and sends the header. Publishers:
  - Claude Code and Codex: the `SessionStart` hook, for every source, re-published on `/clear`, resume and compaction; `SessionEnd` removes it.
  - opencode and Hermes: the in-process plugin, for its own process.
  - Pi has its own MCP client and sets the header directly.
- **Fallback is unchanged.** On Windows, with an older plugin, or from a third-party client, no binding exists, no header is sent, and behaviour is today's, including the `session_ambiguous` refusal.

Rejected:

- **A PreToolUse hook that rewrites the tool's `sessionId` argument.** It adds a process to every write. Codex accepts a rewrite only together with an automatic `allow`, and Claude Code's auto mode may deny a rewrite sent without one. The bridge header covers every request at the transport instead.
- **Reading `CLAUDE_CODE_SESSION_ID` in the bridge.** A stdio MCP server keeps the id it was spawned with, so it is stale after `/clear`, and it is Claude-only.
- **Server-side per-connection binding.** It contradicts the stateless server.
- **Keying bindings by PID alone.** A reused PID could name another live session of the same token, and the server would accept it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: session resolution gains the declared-session step and host precedence; `memory.session_start` adopts it.
- `sessions`: the resolution contract names the declared session.
- `http-api`: the MCP route reads `X-Rembric-Session` into the request context.
- `mcp-bridge`: the bridge's inputs gain the host binding, and it sends `X-Rembric-Session`.
- `plugin-session-protocol`: the host-binding contract (location, format, publishers, removal).
- `claude-code-plugin`, `codex-distribution`, `opencode-plugin`, `hermes-agent-plugin`, `pi-plugin`: each client's publisher (or, for Pi, the direct header).

## Impact

- Server: `apps/web/src/lib/mcp-auth.ts` and the MCP route, `packages/core` `RequestContext`, and session resolution in `packages/mcp/src/{_shared,memory-tools,session-tools,prompt-tools,observability-tools}.ts`. No schema change and no migration.
- Plugin: `apps/plugin/mcp-bridge/` (new `rembric-host-binding.mjs`, `bridge.mjs`), `apps/plugin/scripts/{session-start,session-end,_api}.sh`, `.opencode-plugin/plugin.ts`, `.hermes-plugin/__init__.py`, `.pi-plugin/index.ts`. A plugin release (unified version) and a server release.
- Compatibility:
  - A new bridge against an older server sends a header the server ignores.
  - An older bridge against a new server sends none, so behaviour is today's.
  - The only visible behaviour change: when a client declares its session and the model passes a different id, the write goes to the declared session.
