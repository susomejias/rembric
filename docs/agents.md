# Agent integration guides

Rembric exposes the MCP Streamable HTTP transport on `/mcp` (global scope) and `/mcp/<project-slug>` (project scope). Every supported agent uses the same shape:

```
URL:        http(s)://your-host:8787/mcp[/<project-slug>]
Header:     Authorization: Bearer <agent-token>
Optional:   X-Rembric-Project: <slug>   (alternative to URL-path scoping)
```

If you connect to `/mcp` the agent can only read/write **global** memories. If you connect to `/mcp/<slug>` the agent is locked to that project — `memory.save` with `scope=global` is rejected with `code: scope_locked`.

> **Tokens.** Mint per-agent tokens from the dashboard (`/dashboard/tokens`) or via `rembric token create <name>`. The plaintext is shown exactly once; copy it directly into the agent's MCP config.

---

## Claude Code (validated)

Claude Code reads MCP configuration from `~/.claude/mcp.json` (or a project-level `.claude/mcp.json`).

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://memory.your-host.example/mcp",
      "headers": {
        "Authorization": "Bearer cc-token-XXXXXXXX"
      }
    }
  }
}
```

For per-project memory, point one entry per project at its slug:

```json
{
  "mcpServers": {
    "rembric-web": {
      "type": "http",
      "url": "https://memory.your-host.example/mcp/web",
      "headers": { "Authorization": "Bearer cc-web-token" }
    }
  }
}
```

After saving, restart Claude Code. The `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` tools appear in the tool list.

---

## Codex CLI (validated)

Codex CLI uses the same Streamable HTTP transport. Configuration lives under `~/.codex/mcp.json`:

```json
{
  "servers": {
    "rembric": {
      "transport": "streamable-http",
      "url": "https://memory.your-host.example/mcp",
      "headers": {
        "Authorization": "Bearer codex-token-XXXXXXXX"
      }
    }
  }
}
```

For per-project setups, mirror the Claude Code layout above with `/mcp/<slug>`.

---

## Hermes Agent (pending verification — stdio↔HTTP bridge fallback)

Hermes does not yet ship native Streamable HTTP support in every release. Two paths:

1. **Native HTTP transport** if your Hermes build supports it. Configuration parallels Codex:

   ```json
   {
     "mcpServers": {
       "rembric": {
         "transport": "http",
         "url": "https://memory.your-host.example/mcp",
         "headers": { "Authorization": "Bearer hermes-token-XXXXXXXX" }
       }
     }
   }
   ```

2. **Stdio↔HTTP bridge** if your Hermes build is stdio-only. The official MCP TS SDK ships a bridge you can invoke as a stdio child:

   ```json
   {
     "mcpServers": {
       "rembric": {
         "command": "npx",
         "args": [
           "@modelcontextprotocol/sdk",
           "bridge",
           "--target",
           "https://memory.your-host.example/mcp"
         ],
         "env": {
           "MCP_BEARER_TOKEN": "hermes-token-XXXXXXXX"
         }
       }
     }
   }
   ```

   The bridge converts each stdio JSON-RPC message into an HTTP POST with the supplied bearer header. The HTTP↔stdio path was reported to work against early-2025 Hermes builds; please file an issue with your Hermes version if you hit anything that the spec does not cover.

---

## Verifying the connection

After registering rembric with an agent, ask the agent to list its available tools. You should see all four `memory.*` tools. A quick smoke test:

```
Agent: "Save a memory that I prefer trailing commas in JSON."
```

Then inspect the dashboard at `/dashboard/memories` — the row should appear, with `source.tokenName` matching the token you minted.
