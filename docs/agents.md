# Agent integration

For **Claude Code**, use the bundled plugin — see [`plugin/README.md`](../plugin/README.md). The rest of this doc is for everything else.

## Connection shape

Every MCP client uses the same two values:

```
URL:    http(s)://your-host:8787/mcp[/<project-slug>]
Header: Authorization: Bearer <agent-token>
```

- `/mcp` → global scope. The agent operates user-wide until it calls `project.use({slug})`.
- `/mcp/<slug>` → path-scoped. The agent is locked to that project; `scope=global` saves are rejected with `code: scope_locked`.

Mint per-agent tokens from the dashboard (`/dashboard/tokens`) or `rembric token create <name>`. Plaintext shown exactly once.

The MCP server emits a short `instructions` block at handshake teaching the proactive-save protocol (when to save, when to call `memory.judge`, when to call `memory.session_summary`). Clients that support `initialize.instructions` (Claude Code, Codex CLI) inject it into the system prompt. Other clients still get the same protocol via each tool's description.

## Validated configs

### Claude Code (plain JSON, if not using the plugin)

`~/.claude/mcp.json` or workspace `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://memory.example.com/mcp/my-app",
      "headers": { "Authorization": "Bearer cc-token-XXXXXXXX" }
    }
  }
}
```

### Codex CLI

`~/.codex/mcp.json`:

```json
{
  "servers": {
    "rembric": {
      "transport": "streamable-http",
      "url": "https://memory.example.com/mcp/my-app",
      "headers": { "Authorization": "Bearer codex-token-XXXXXXXX" }
    }
  }
}
```

## Any other MCP client

Cursor, Windsurf, VS Code Copilot Chat, Gemini CLI, OpenCode, etc. — they all speak Streamable HTTP with the same URL + Bearer shape. Locate their MCP config file in the client's docs and drop in the same block, adjusting field names (`type`, `transport`, `httpUrl`, plain `url`) to match.

If your client is stdio-only, use `mcp-remote` (the same package the Rembric plugin's bridge wraps) as a stdio↔HTTP shim. See its README for the exact spawn command; the Rembric plugin's `bin/rembric-bridge.mjs` is a working reference.

## `project_suggestion_pending`

When you connect to `/mcp` (path-less) and roots-based discovery surfaces a slug that does not yet exist as a project, write tools refuse to silently fall through to global. They return:

```json
{
  "ok": false,
  "code": "project_suggestion_pending",
  "message": "...",
  "suggestedSlugs": ["acme-research"]
}
```

Two resolutions, both belong to the user:

- **Stay global**: re-issue passing `scope: 'global'` explicitly.
- **Mint the project**: `project.use({slug, autocreate: true})`, then re-issue.

Never autocreate or autopin silently.

## Surviving compaction

Long-running agents compact their context. To survive that, two tools fire at specific moments:

- **Before "done" / before compaction**: `memory.session_summary({Goal, Discoveries, Accomplished, Next Steps, Files})` closes the session and persists the state.
- **After compaction / new session**: `memory.context({sessions, prompts, memories})` restores it.

The proactive-save protocol embedded in `initialize.instructions` already tells agents to do this. If your client ignores the field, paste the equivalent into the client's rules file (`AGENTS.md`, `.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `~/.gemini/system.md`, etc.).

## Verifying

After registering, ask the agent to list its tools — you should see the `memory.*` and `project.*` families. Save a test memory, then check `/dashboard/memories` for the row.

## Cross-references

- Tool surface and parameters: each tool's MCP description (call `tools/list` from your client).
- Relation graph and `memory.judge` cadence: [docs/relations.md](./relations.md).
- Session deletion / undelete: dashboard `/dashboard/sessions`, CLI `rembric session list --include-deleted`.
