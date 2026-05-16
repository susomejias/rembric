<p align="center">
  <img src="./docs/banner.png" alt="Rembric" width="100%">
</p>

<p align="center">
  <b>Self-hosted memory layer for AI coding agents</b>
</p>

<p align="center">
  <i>One npm package, one process, one SQLite file. Multi-client by construction, reversible by design.</i>
</p>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#hooking-up-claude-code-recommended">Claude Code</a> ·
  <a href="#hooking-up-codex-cli">Codex CLI</a> ·
  <a href="#hooking-up-other-mcp-clients">Other Clients</a> ·
  <a href="#cli-operations">CLI</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

> **rembric** /ˈrem.brɪk/ — _coined, from_ remember + fabric: the woven memory layer beneath your agents. One brain, shared across every MCP-capable tool — Claude Code, Codex CLI, Cursor, and beyond.

## Architecture

```
                  ┌─────────────────────────────────────────────────┐
                  │              Agents (MCP clients)               │
                  │     Claude Code · Codex CLI · Cursor · …        │
                  └────────────────────────┬────────────────────────┘
                                           │
                                           │  HTTP(S) + Bearer token
                                           │  URL path: /mcp/<slug>  (or /mcp + project.use)
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                       rembric  (single Node process)                  │
   │                                                                       │
   │   ┌────────────────────────────┐   ┌───────────────────────────────┐  │
   │   │  /mcp       /mcp/<slug>    │   │  /dashboard                   │  │
   │   │  Streamable HTTP transport │   │  SSR HTML + HTMX              │  │
   │   │  + initialize.instructions │   │                               │  │
   │   │  memory.{save,search,…}    │   │  /memories /sessions          │  │
   │   │  memory.session_*          │   │  /consolidation /projects     │  │
   │   │  memory.judge / compare    │   │  /tokens                      │  │
   │   │  project.{use,list,current}│   │                               │  │
   │   └─────────────┬──────────────┘   └─────────────┬─────────────────┘  │
   │                 ▼                                ▼                    │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  Service layer                                                │   │
   │   │   MemoryService · RelationsService · ProjectsService          │   │
   │   │   TokensService · AgentSessionsService · SessionRouter        │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   │                                   ▼                                   │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  SQLite (Drizzle, append-only + tombstones)                   │   │
   │   │   memory · projects · tokens · sessions · prompts             │   │
   │   │   memory_relations · consolidation_{runs,ops}                 │   │
   │   │   + memory_fts (FTS5)      + memory_vec (sqlite-vec)          │   │
   │   └───────────────────────────────▲───────────────────────────────┘   │
   │   ┌───────────────────────────────┴───────────────────────────────┐   │
   │   │  Background workers                                           │   │
   │   │   EmbeddingWorker (every 30s) · ConsolidationScheduler        │   │
   │   │     decay (deterministic) + orphan promotion (LLM judge)      │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   └───────────────────────────────────┼───────────────────────────────────┘
                                       │  OpenAI-compatible HTTP
                                       ▼
                   ┌────────────────────────────────────────┐
                   │   LLM endpoint                         │
                   │   Ollama · OpenAI · LM Studio · …      │
                   └────────────────────────────────────────┘
```

Four load-bearing invariants:

- **Append-only**: rows are never deleted; `content` never updated. Lifecycle is `status` flips + `replaces` links. Every consolidation op is reversible.
- **Project scoping by construction**: every memory is `global` or attached to one `project_id`. Consolidation and relations never cross scope.
- **Convergent topics via `topic_key`**: on `memory.save`, the previously-active row in the same `(scope, project_id, topic_key)` is auto-superseded atomically.
- **Fresh-context judgment**: candidate conflicts surface at save time (`candidates[]`); the agent that produced the conflict judges it. The nightly consolidator only handles decay + orphan promotion.

See [docs/relations.md](./docs/relations.md) for the relation taxonomy.

## Quickstart

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)

pnpm dlx rembric              # one-shot
# or:
pnpm add -g rembric && rembric
```

MCP at `http://127.0.0.1:8787/mcp`, dashboard at `http://127.0.0.1:8787/dashboard`.

The server binds to `127.0.0.1` by default. Remote exposure is up to you; how you host it is out of scope here.

## Hooking up Claude Code (recommended)

**Strongly recommended path.** The bundled plugin replaces hand-editing `.mcp.json`, stores your token in the keychain, registers `/rembric:*` commands, and ships hooks that trigger memory ops at the right lifecycle moments without the model needing to remember them.

```bash
claude plugin marketplace add https://github.com/susomejias/rembric.git
claude plugin install rembric@rembric
```

You'll be prompted for two values at install time:

- **Rembric server URL** — base URL **without** `/mcp` (e.g. `https://memory.example.com`). The plugin appends the path itself.
- **API token** — issued by `rembric token create <name>`. Stored in your system keychain.

To pin a project per repo, drop a `.rembric` file at the root:

```bash
echo "PROJECT_SLUG=my-app" > .rembric
```

Without that file the bridge connects path-less (`/mcp`) and operates in global scope.

Full plugin docs: [`plugin/README.md`](./plugin/README.md).

## Hooking up Codex CLI

Codex CLI installs the same `plugin/` directory via its native marketplace, alongside its own `.codex-plugin/plugin.json` manifest and a Codex-specific `hooks.codex.json`. One source tree, both clients:

```bash
codex plugin marketplace add https://github.com/susomejias/rembric.git
codex plugin install rembric
```

Codex's plugin manifest has no keychain prompt — set `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` as env vars in the shell that launches `codex`. Drop `.rembric` files per project to path-scope the slug automatically (same flow as the Claude Code plugin).

> **Extra Codex-only steps for hooks to fire** (as of `codex-cli 0.130.0`): after the install + env exports, run `codex features enable plugin_hooks` and then approve the 4 hooks via `/hooks` inside Codex. Without these two one-time steps, MCP works but `/dashboard/sessions` stays empty. Full walk-through (including the symptom-vs-cause troubleshooting table) in [docs/agents.md](./docs/agents.md#enable-plugin_hooks-and-trust-hooks-required).

Full details and the manual config.toml fallback: [docs/agents.md](./docs/agents.md).

## Hooking up other MCP clients

Cursor, Windsurf, VS Code Copilot Chat, Gemini CLI, OpenCode, etc. — they all speak Streamable HTTP. The shape is identical:

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://memory.example.com/mcp/my-app",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

Drop `/my-app` from the URL for global scope. Per-client config-file locations and validation status: [docs/agents.md](./docs/agents.md).

## CLI operations

| Command                                          | Purpose                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `rembric project create <slug> [--name <name>]`  | Mint a project. Slug must match `[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?`. |
| `rembric project list [--all] [--table]`         | List projects (JSON default; `--table` for humans).                   |
| `rembric session list [--include-deleted]`       | Inspect agent sessions.                                               |
| `rembric session delete <id>`                    | Soft-delete (audit trail preserved).                                  |
| `rembric token create <name> [--project <slug>]` | Mint a bearer token. Plaintext shown exactly once.                    |
| `rembric token revoke <name>`                    | Revoke a token (effective immediately).                               |

Projects are also creatable from `/dashboard/projects`.

## Configuration

All config via environment variables. Required on first run: `REMBRIC_ADMIN_TOKEN` (used to log into the dashboard and mint other tokens).

### Server

| Variable           | Default      | Description                          |
| ------------------ | ------------ | ------------------------------------ |
| `REMBRIC_HOST`     | `127.0.0.1`  | Bind address.                        |
| `REMBRIC_PORT`     | `8787`       | Bind port.                           |
| `REMBRIC_DATA_DIR` | `~/.rembric` | Where the SQLite file lives.         |
| `LOG_LEVEL`        | `info`       | `debug` / `info` / `warn` / `error`. |

### LLM provider (chat + embeddings)

Provider selection uses generic vars; per-provider config lives under that provider's namespace. Today the only implemented provider is `openai`, which also covers Ollama, LM Studio, vLLM, Groq, Together, etc. (all expose an OpenAI-compatible `/v1`).

| Variable                 | Default                     | Description                                        |
| ------------------------ | --------------------------- | -------------------------------------------------- |
| `OPENAI_BASE_URL`        | `http://localhost:11434/v1` | Endpoint URL including `/v1`.                      |
| `OPENAI_API_KEY`         | _(empty)_                   | Required for OpenAI proper; Ollama ignores it.     |
| `OPENAI_MODEL`           | `qwen2.5:7b`                | Chat model.                                        |
| `OPENAI_EMBEDDING_MODEL` | `nomic-embed-text`          | Embedding model.                                   |
| `EMBEDDING_ENABLED`      | `true`                      | If `false`, consolidation falls back to FTS5 only. |

### Consolidation

| Variable                   | Default     | Description                                                 |
| -------------------------- | ----------- | ----------------------------------------------------------- |
| `CONSOLIDATION_ENABLED`    | `true`      | Background consolidation toggle.                            |
| `CONSOLIDATION_CRON`       | `0 3 * * *` | Cron schedule.                                              |
| `JUDGMENT_ORPHAN_AFTER_MS` | `86400000`  | Age past which pending judgments are sent to the LLM judge. |

## Backups

The DB is one SQLite file in `REMBRIC_DATA_DIR` (`~/.rembric/data.db` by default). Cold backup: stop the server, copy the file. Live backup: use SQLite's online backup API or `litestream`. Recipes: [docs/backup.md](./docs/backup.md).

## More docs

- [docs/agents.md](./docs/agents.md) — per-client MCP config (Codex, Cursor, Windsurf, VS Code, Gemini, …).
- [docs/backup.md](./docs/backup.md) — backup strategies.
- [docs/troubleshooting.md](./docs/troubleshooting.md) — common errors and recovery.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Commits follow Conventional Commits; pre-commit lints and typechecks; pre-push runs the full test suite.

## License

MIT — see [LICENSE](./LICENSE).
