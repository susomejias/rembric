# Agent integration guides

Rembric exposes the MCP Streamable HTTP transport on `/mcp` (global scope) and `/mcp/<project-slug>` (project scope). Every supported agent uses the same shape:

```
URL:        http(s)://your-host:8787/mcp[/<project-slug>]
Header:     Authorization: Bearer <agent-token>
```

> The `X-Rembric-Project` header was removed in v0.5. Project scope is sourced from the URL path or set per-session via `project.use({slug})`.

If you connect to `/mcp` the agent can only read/write **global** memories until it calls `project.use({slug})` (or until server-side roots-based detection picks up the workspace). If you connect to `/mcp/<slug>` the agent is locked to that project — `memory.save` with `scope=global` is rejected with `code: scope_locked`.

> **Tokens.** Mint per-agent tokens from the dashboard (`/dashboard/tokens`) or via `rembric token create <name>`. The plaintext is shown exactly once; copy it directly into the agent's MCP config.

## Quick reference

| Agent                  | Transport                                   | Config file                                       | Status             |
| ---------------------- | ------------------------------------------- | ------------------------------------------------- | ------------------ |
| Claude Code            | Streamable HTTP                             | `~/.claude/mcp.json` or `.claude/mcp.json`        | ✅ validated       |
| Codex CLI              | Streamable HTTP                             | `~/.codex/mcp.json`                               | ✅ validated       |
| Cursor                 | Streamable HTTP                             | `~/.cursor/mcp.json` or `.cursor/mcp.json`        | ⚠️ pending verify  |
| Windsurf               | Streamable HTTP                             | `~/.windsurf/mcp.json`                            | ⚠️ pending verify  |
| VS Code (Copilot Chat) | Streamable HTTP                             | `.vscode/mcp.json` (workspace) or user `mcp.json` | ⚠️ pending verify  |
| Gemini CLI             | Streamable HTTP                             | `~/.gemini/mcp.json`                              | ⚠️ pending verify  |
| OpenCode               | Streamable HTTP                             | `~/.config/opencode/config.json`                  | ⚠️ pending verify  |
| Hermes                 | Streamable HTTP or stdio↔HTTP bridge        | (depends on build)                                | ⚠️ pending verify  |
| Any other MCP agent    | Streamable HTTP (preferred) or stdio bridge | (any)                                             | follow the pattern |

> **No CLI helper required.** Unlike stdio-based memory backends, Rembric is a single HTTP endpoint plus a bearer token. There is no wrapper command to install on the agent host; you write one JSON block per agent and you are done.

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

### Handling `project_suggestion_pending`

When an MCP client lands on the path-less `/mcp` endpoint and roots-based discovery surfaces a slug that does not yet exist as a project, write tools (`memory.save` with default scope, `memory.session_start` with no `project` arg) refuse to silently fall through to `scope='global'`. They return a structured error:

```json
{
  "ok": false,
  "code": "project_suggestion_pending",
  "message": "No project is active and roots-based discovery surfaced suggestions. Either pass scope:'global' explicitly, or call project.use({slug:'<one of suggestedSlugs>', autocreate:true}).",
  "suggestedSlugs": ["acme-research"]
}
```

The agent has exactly two resolutions, and the choice belongs to the user:

- **Stay global**: re-issue the same call passing `scope: 'global'` explicitly. The write lands in the user-wide global scope.
- **Mint the suggested project**: call `project.use({slug: '<suggestedSlug>', autocreate: true})` first. The project is created, pinned to the session, and the original call (re-issued without `scope`) lands in `scope='project'`.

The contract: never autocreate or autopin silently. Surface the choice to the user and let them direct it.

### Deleting sessions

Operators can retire stale sessions from `rembric session delete <id>` or from the `/dashboard/sessions` row form. Delete is **soft**: the row stays in the table with a `deleted_at` timestamp, every `memory.session_id` reference keeps pointing at it (audit trail preserved), but the row is hidden from default listings.

- CLI: `rembric session list --include-deleted` to surface them.
- Dashboard: `?include_deleted=1` on `/dashboard/sessions` or the row's detail view exposes an `Undelete` button.
- MCP: `memory.session_end` / `memory.session_summary` against a deleted row return `code: 'session_deleted'`. Ask the operator to undelete before retrying.

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

## Cursor (pending verification)

Cursor reads MCP configuration from `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

```json
{
  "mcpServers": {
    "rembric": {
      "url": "https://memory.your-host.example/mcp",
      "headers": { "Authorization": "Bearer cursor-token-XXXXXXXX" }
    }
  }
}
```

Drop the [Memory Protocol snippet](#memory-protocol-snippet-paste-into-your-agent-rules) into `.cursor/rules/rembric.mdc` (or the global path) so Cursor invokes the tools proactively.

---

## Windsurf (pending verification)

Windsurf reads MCP configuration from `~/.windsurf/mcp.json`.

```json
{
  "mcpServers": {
    "rembric": {
      "url": "https://memory.your-host.example/mcp",
      "headers": { "Authorization": "Bearer windsurf-token-XXXXXXXX" }
    }
  }
}
```

Add the Memory Protocol snippet to `.windsurfrules` (project root).

---

## VS Code Copilot Chat (pending verification)

VS Code reads MCP configuration from `.vscode/mcp.json` (workspace, recommended) or a user-scoped `mcp.json`.

```json
{
  "servers": {
    "rembric": {
      "type": "http",
      "url": "https://memory.your-host.example/mcp",
      "headers": { "Authorization": "Bearer vscode-token-XXXXXXXX" }
    }
  }
}
```

One-liner from a terminal: `code --add-mcp '{"name":"rembric","type":"http","url":"https://memory.your-host.example/mcp","headers":{"Authorization":"Bearer vscode-token-XXXXXXXX"}}'`.

For Copilot Chat to invoke the tools proactively, paste the Memory Protocol snippet into a `.github/copilot-instructions.md` file at the workspace root.

---

## Gemini CLI (pending verification)

Gemini CLI reads MCP configuration from `~/.gemini/mcp.json`.

```json
{
  "mcpServers": {
    "rembric": {
      "httpUrl": "https://memory.your-host.example/mcp",
      "headers": { "Authorization": "Bearer gemini-token-XXXXXXXX" }
    }
  }
}
```

The system prompt is read from `~/.gemini/system.md` when `GEMINI_SYSTEM_MD=1` is set. Paste the Memory Protocol snippet there.

---

## OpenCode (pending verification)

OpenCode reads MCP configuration from `~/.config/opencode/config.json` (every platform — Windows uses `~/.config/`, not `%APPDATA%`).

```json
{
  "mcp": {
    "rembric": {
      "type": "remote",
      "url": "https://memory.your-host.example/mcp",
      "headers": { "Authorization": "Bearer opencode-token-XXXXXXXX" },
      "enabled": true
    }
  }
}
```

Paste the Memory Protocol snippet into `~/.config/opencode/AGENTS.md`.

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

## Any other MCP agent

Rembric only requires four pieces of information from the agent's MCP client. If the client speaks the MCP spec, plug them in and you're done:

1. **Transport**: Streamable HTTP. Pick the field name your agent uses (`type: 'http'`, `transport: 'streamable-http'`, `httpUrl`, just `url`, …).
2. **URL**: `http(s)://<host>:8787/mcp` for global scope, or `http(s)://<host>:8787/mcp/<slug>` for project scope.
3. **Auth header**: `Authorization: Bearer <agent-token>`. No other headers are read.
4. **System prompt / rules file**: paste the [Memory Protocol snippet](#memory-protocol-snippet-paste-into-your-agent-rules) into whatever instructions file the agent reads at startup. This is what teaches the agent to call `memory.save` proactively, surface conflicts via `memory.judge`, and recover after compaction via `memory.context`.

If your agent only speaks **stdio** MCP, use the `npx @modelcontextprotocol/sdk bridge` pattern shown in the Hermes section above — every stdio JSON-RPC frame becomes an HTTP POST with the bearer header attached. No code on your side.

If your agent speaks neither, it is not yet an MCP client; track upstream support before integrating.

---

## Surviving compaction & context resets

Long-running agents (Claude Code, Codex CLI, Cursor with extended chats) compact their context window when it fills up. Rembric is designed to survive that — but only if the agent calls two specific tools at the right moments:

```
   ┌─ before "I'm done" / before compaction ────────────────┐
   │  memory.session_summary({                              │
   │    Goal, Discoveries, Accomplished, Next Steps, Files  │
   │  })                                                    │
   └────────────────────────────────────────────────────────┘
                            │
                            ▼  context window resets
   ┌─ next message / after compaction ──────────────────────┐
   │  memory.context({                                      │
   │    sessions: 5,    // recent session summaries         │
   │    prompts: 10,    // recent user prompts              │
   │    memories: 20    // recent feedback/decisions        │
   │  })                                                    │
   └────────────────────────────────────────────────────────┘
```

The agent never has to re-derive what happened — the previous session summary plus the recent memory window restore working state in one tool call.

Two further behaviors the Memory Protocol snippet enforces:

- **Proactive saves** — call `memory.save` immediately after any decision, bugfix, convention, or discovery; don't wait for the user to ask. The save returns `candidates[]` with `judgmentRequired:true` whenever the new memory looks similar to an existing one.
- **Close every pending judgment** — for each `candidate`, call `memory.judge({judgmentId, relation, …})` while the context is fresh. Otherwise the consolidator's orphan-promotion pass closes them later with an LLM verdict (still correct, but the agent loses authorial provenance).

### Memory Protocol snippet (paste into your agent rules)

The snippet below is plain text — drop it into whichever rules file your agent reads at startup (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/rembric.mdc`, `.windsurfrules`, `.github/copilot-instructions.md`, `~/.gemini/system.md`, etc.).

```text
You have access to a persistent memory backend exposed via the MCP server `rembric`.

WHEN TO SAVE (call `memory.save` immediately, do not wait to be asked):
- a decision is made (architecture, convention, workflow, tool choice)
- a bug is fixed (include the root cause)
- a non-obvious discovery or gotcha is found
- a user preference or constraint is learned
- a pattern is established (naming, structure, approach)

ON EVERY SAVE: if the response includes `candidates[]` with `judgmentRequired:true`,
close each one with `memory.judge({judgmentId, relation, reason?, confidence?})`
before continuing. Use `supersedes` when the new memory replaces the old,
`conflicts_with` when they disagree but both should remain, `related` /
`compatible` / `scoped` for informational links, `not_conflict` for a false
positive.

EVOLVING TOPICS: when you are updating a topic you have saved before, pass
`topic_key` on `memory.save` (call `memory.suggest_topic_key` first if unsure).
The previous active row in the same `(scope, project_id, topic_key)` slot is
auto-superseded atomically.

SESSION CLOSE: before saying "done" / "listo", call
`memory.session_summary({sessionId, summary})` with sections:
Goal · Discoveries · Accomplished · Next Steps · Relevant Files.

SESSION OPEN / AFTER COMPACTION: call `memory.context({sessions, prompts,
memories})` to recover state from the previous session. Do this before
re-deriving what happened.

PROJECT SCOPE: if a tool returns `code: 'project_suggestion_pending'`, ask
the user whether to (a) save as `scope:'global'` or (b) mint the suggested
project via `project.use({slug, autocreate:true})`. Never autocreate silently.
```

Keep it under your agent's instruction budget (≈800 chars trimmed is enough). The snippet above is ~1.2 KB — trim aggressively if your agent's context is tight.

---

## Verifying the connection

After registering rembric with an agent, ask the agent to list its available tools. You should see all four `memory.*` tools. A quick smoke test:

```
Agent: "Save a memory that I prefer trailing commas in JSON."
```

Then inspect the dashboard at `/dashboard/memories` — the row should appear, with `source.tokenName` matching the token you minted.
