# Agent integration guides

Rembric exposes the MCP Streamable HTTP transport on `/mcp` (global scope) and `/mcp/<project-slug>` (project scope). Every supported agent uses the same shape:

```
URL:        http(s)://your-host:8787/mcp[/<project-slug>]
Header:     Authorization: Bearer <agent-token>
```

> The `X-Rembric-Project` header was removed in v0.5. Project scope is sourced from the URL path or set per-session via `project.use({slug})`.

If you connect to `/mcp` the agent can only read/write **global** memories until it calls `project.use({slug})` (or until server-side roots-based detection picks up the workspace). If you connect to `/mcp/<slug>` the agent is locked to that project — `memory.save` with `scope=global` is rejected with `code: scope_locked`.

> **Tokens.** Mint per-agent tokens from the dashboard (`/dashboard/tokens`) or via `rembric token create <name>`. The plaintext is shown exactly once; copy it directly into the agent's MCP config.

## Tool surface (v0.5)

| Tool                       | Purpose                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.save`              | Persist a structured memory; optional `topic_key` auto-supersedes the previous active row in the same slot. Response includes `candidates[]` (similar memories pending judgment) and `judgmentRequired`. |
| `memory.search`            | FTS5 keyword search scoped to the active project (or globals). Results carry `relations[]` annotations.                                                                                                  |
| `memory.get`               | Retrieve a memory with its predecessor chain and full relation annotations.                                                                                                                              |
| `memory.confirm`           | Bump confidence on a memory the user endorsed                                                                                                                                                            |
| `memory.session_start`     | Open a working session; optionally pass a `project` slug                                                                                                                                                 |
| `memory.session_end`       | Close the session without a summary                                                                                                                                                                      |
| `memory.session_summary`   | Close with a structured Goal/Discoveries/Accomplished/Next Steps/Files summary — call BEFORE saying "done"                                                                                               |
| `memory.context`           | Bootstrap context for a new session: recent sessions + recent prompts + recent memories                                                                                                                  |
| `memory.timeline`          | Drill into chronological neighbors of a memory within its session                                                                                                                                        |
| `memory.capture_passive`   | Parse `## Key Learnings:` from agent output and save each item                                                                                                                                           |
| `memory.save_prompt`       | Persist the user's most recent prompt so future sessions can read it via `memory.context.recentPrompts`                                                                                                  |
| `memory.suggest_topic_key` | Deterministic family/slug suggestion — call before save when updating an evolving topic                                                                                                                  |
| `memory.judge`             | Close a pending candidate from `memory.save.candidates[]`; relation=supersedes mutates the target memory                                                                                                 |
| `memory.compare`           | Proactive verdict on two arbitrary memories (no preceding save); idempotent on the `(A,B)` pair                                                                                                          |
| `memory.doctor`            | Read-only operational health report                                                                                                                                                                      |
| `memory.stats`             | Counters scoped to the active project                                                                                                                                                                    |
| `project.use`              | Activate a project for the session; `autocreate`/`confirmSwitch` are opt-in                                                                                                                              |
| `project.list`             | List existing projects + memory counts                                                                                                                                                                   |
| `project.current`          | Report the active project, source, and any roots-derived suggestions                                                                                                                                     |

The MCP server emits a short `instructions` block at handshake that teaches the protocol to clients that support the field (Claude Code, Codex CLI). Clients that ignore it still get the protocol from each tool's description.

### The save → judge cadence

If an agent updates a topic across sessions, prefer the `topic_key` upsert path. Otherwise let save-time candidate detection do its job:

```
   memory.save({content})
       │
       ▼ response: { id, candidates: [{judgmentId, targetId, similarity}…], judgmentRequired: true }
       │
       ▼ for each candidate the agent reads:
   memory.judge({judgmentId, relation, reason?, confidence?})
       ├─ 'supersedes'   — new replaces old (atomic side effect on memory row)
       ├─ 'conflicts_with' — both stay active; annotation records the conflict
       ├─ 'related' / 'compatible' / 'scoped' — informational
       └─ 'not_conflict' — false positive; row closed, hidden from search annotations
```

For independent analysis (no preceding save), use `memory.compare({memoryIdA, memoryIdB, relation, confidence})` — same backing table, different entry point.

See [docs/relations.md](./relations.md) for the relation taxonomy in full.

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
