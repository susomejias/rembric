# Rembric

A self-hosted MCP memory server for AI agents. One npm package, one process,
one SQLite file. Multi-client memory shared across Claude Code, Codex CLI,
Hermes Agent, and any other MCP-capable tool. Background consolidation keeps the
memory clean using a configurable LLM endpoint (local Ollama by default).

Brand: **Rembric**. CLI / binary / npm package: `rembric` (singular).

> **Status:** v0 in active development. The spec lives under
> [`openspec/changes/add-rembric/`](./openspec/changes/add-rembric/).

## Architecture

```
                  ┌─────────────────────────────────────────────────┐
                  │              Agents (MCP clients)               │
                  │     Claude Code · Codex CLI · Hermes · …        │
                  └────────────────────────┬────────────────────────┘
                                           │
                                           │  HTTPS via your reverse proxy
                                           │  Authorization: Bearer <token>
                                           │  X-Rembric-Project: <slug>
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                       rembric  (single Node process)                  │
   │                                                                       │
   │   ┌────────────────────────────┐   ┌───────────────────────────────┐  │
   │   │  /mcp        /mcp/<slug>   │   │  /dashboard                   │  │
   │   │  Streamable HTTP transport │   │  SSR HTML + HTMX              │  │
   │   │  ┌──────────────────────┐  │   │  ┌─────────────────────────┐  │  │
   │   │  │ memory.save          │  │   │  │ /login   /memories      │  │  │
   │   │  │ memory.search (FTS5) │  │   │  │ /consolidation /tokens  │  │  │
   │   │  │ memory.get  + history│  │   │  │ /projects               │  │  │
   │   │  │ memory.confirm       │  │   │  └─────────────────────────┘  │  │
   │   │  └──────────────────────┘  │   │                               │  │
   │   └─────────────┬──────────────┘   └─────────────┬─────────────────┘  │
   │                 │                                │                    │
   │                 ▼                                ▼                    │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  Service layer                                                │   │
   │   │   MemoryService · ProjectsService · TokensService · Sessions  │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   │                                   │                                   │
   │                                   ▼                                   │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  SQLite (Drizzle ORM, append-only + tombstones)               │   │
   │   │   memory · projects · confirmations · tokens · sessions       │   │
   │   │   consolidation_runs · consolidation_ops                      │   │
   │   │   + memory_fts  (FTS5)      + memory_vec  (sqlite-vec)        │   │
   │   └───────────────────────────────▲───────────────────────────────┘   │
   │                                   │                                   │
   │   ┌───────────────────────────────┴───────────────────────────────┐   │
   │   │  Background workers                                           │   │
   │   │   EmbeddingWorker          (every 30s + pre-consolidation)    │   │
   │   │   ConsolidationScheduler   (CONSOLIDATION_CRON, default 03:00)│   │
   │   │     └── candidate detection  →  LLM judge  →  atomic ops      │   │
   │   │         (redundancy / drift / contradiction / decay)          │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   │                                   │                                   │
   └───────────────────────────────────┼───────────────────────────────────┘
                                       │
                  OpenAI-compatible HTTP (/v1/chat/completions, /v1/embeddings)
                                       │
                                       ▼
                   ┌────────────────────────────────────────┐
                   │   LLM endpoint                         │
                   │   Ollama · OpenAI · LM Studio · …      │
                   └────────────────────────────────────────┘
```

Three load-bearing invariants:

- **Append-only memory**: rows are never DELETEd; `content` is never UPDATEd. Lifecycle is `status` flips (`active` → `superseded` | `archived`) and `replaces` links. Every consolidation op lands in a reversible journal.
- **Project scoping by construction**: every memory is `global` or attached to a single `project_id`. The consolidation engine never crosses scope boundaries.
- **Provider-namespaced env vars**: `LLM_PROVIDER=openai` (only option today) routes to `OPENAI_*` namespace. The same code works against OpenAI, Ollama, LM Studio, vLLM, etc.

## Quickstart

```bash
# 1. Set a strong admin token (required on first run)
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)

# 2. Run the server (uses Ollama at http://localhost:11434 by default)
pnpm dlx rembric        # pnpm — one-shot, no install
# or:
npx rembric             # npm — one-shot, no install
# or, for a long-lived install:
pnpm add -g rembric && rembric
```

The MCP endpoint is at `http://127.0.0.1:8787/mcp`. The dashboard at
`http://127.0.0.1:8787/dashboard`. The server binds to `127.0.0.1` by default
so it is not reachable from the network until you put a reverse proxy in
front (see [`examples/`](./examples/)).

## Hooking up an agent

Add to your MCP-capable agent's config (Claude Code, Codex, ...).

**Path-scoped (recommended)** — every memory saved or searched is automatically
scoped to the project named in the URL slug:

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://rembric.example.com/mcp/my-cool-app",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

**Global (no scope)** — agents save / search global memories by default;
project-scoped operations require the agent to specify a project explicitly,
and the server will respond with a helpful `project_required` error otherwise:

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://rembric.example.com/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

The `X-Rembric-Project: <slug>` header is also accepted as an equivalent way
to scope, useful when an agent doesn't let you change the URL path.

Generate a token with `rembric token create <name>`.

## Configuration

All configuration is via environment variables. See
[`docs/env.md`](./docs/env.md) once written, or the
[design document](./openspec/changes/add-rembric/design.md) for the
current contract.

Required on first run:

| Variable              | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `REMBRIC_ADMIN_TOKEN` | Bootstrap admin token. Used to log into the dashboard and to create other tokens. |

### Server

| Variable           | Default      | Description                          |
| ------------------ | ------------ | ------------------------------------ |
| `REMBRIC_HOST`     | `127.0.0.1`  | Bind address.                        |
| `REMBRIC_PORT`     | `8787`       | Bind port.                           |
| `REMBRIC_DATA_DIR` | `~/.rembric` | Where the SQLite file lives.         |
| `LOG_LEVEL`        | `info`       | `debug` / `info` / `warn` / `error`. |

### Providers (chat + embeddings)

Provider selection uses generic vars. Per-provider config lives under that
provider's namespace. Today the only implemented provider is `openai`, which
also covers Ollama (since it exposes an OpenAI-compatible API at `/v1`),
LM Studio, vLLM, Groq, Together, etc.

| Variable                 | Default                     | Description                                        |
| ------------------------ | --------------------------- | -------------------------------------------------- |
| `LLM_PROVIDER`           | `openai`                    | Which chat provider to use.                        |
| `EMBEDDING_PROVIDER`     | `openai`                    | Which embedding provider to use.                   |
| `OPENAI_BASE_URL`        | `http://localhost:11434/v1` | Endpoint URL including `/v1`.                      |
| `OPENAI_API_KEY`         | _(empty)_                   | Required for OpenAI proper; Ollama ignores it.     |
| `OPENAI_MODEL`           | `qwen2.5:7b`                | Chat model name.                                   |
| `OPENAI_EMBEDDING_MODEL` | `nomic-embed-text`          | Embedding model name.                              |
| `EMBEDDING_ENABLED`      | `true`                      | If `false`, consolidation falls back to FTS5 only. |

Common patterns:

```bash
# Real OpenAI
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
export OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Local Ollama
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama   # any non-empty value; Ollama ignores it
export OPENAI_MODEL=qwen2.5:7b-instruct-q4_K_M
export OPENAI_EMBEDDING_MODEL=nomic-embed-text:latest
```

### Consolidation

| Variable                   | Default     | Description                                |
| -------------------------- | ----------- | ------------------------------------------ |
| `CONSOLIDATION_ENABLED`    | `true`      | Background consolidation toggle.           |
| `CONSOLIDATION_CRON`       | `0 3 * * *` | Cron schedule for the consolidation.       |
| `CONSOLIDATION_BATCH_SIZE` | `50`        | Memories considered per consolidation run. |

## Running it as a long-lived service

The npm package is the only deliverable. Bring your own supervisor:

- **systemd** (Linux): see [`examples/systemd/rembric.service`](./examples/systemd/rembric.service)
- **pm2** (cross-platform): see [`examples/pm2/ecosystem.config.cjs`](./examples/pm2/ecosystem.config.cjs)
- **launchd** (macOS): see [`examples/launchd/com.rembric.plist`](./examples/launchd/com.rembric.plist)

## Putting it behind a reverse proxy

The server speaks plain HTTP on `127.0.0.1`. Add your TLS-terminating proxy
of choice. Examples in [`examples/`](./examples/):

- Caddy (auto Let's Encrypt)
- Nginx + Certbot
- Traefik (via docker-compose labels)
- Cloudflare Tunnel

## Updating

```bash
sudo systemctl stop rembric
pnpm add -g rembric@latest        # or: npm i -g rembric@latest
sudo systemctl start rembric
```

Migrations are idempotent and applied on startup.

## Backups

The DB is one SQLite file in `REMBRIC_DATA_DIR` (`~/.rembric/data.db` by
default). Cold backup: stop the server, copy the file. Live backup: use
SQLite's online backup API or a tool like `litestream` streaming to S3/R2.
See [docs/backup.md](./docs/backup.md) for `rsync` / snapshot / litestream
recipes and what NOT to copy.

## More docs

- [docs/agents.md](./docs/agents.md) — wiring Claude Code, Codex CLI, and Hermes to rembric
- [docs/backup.md](./docs/backup.md) — backup strategies (rsync, snapshots, litestream)
- [docs/troubleshooting.md](./docs/troubleshooting.md) — common errors, LLM endpoint issues, locked-DB recovery

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Commit messages must follow the
Conventional Commits spec; the pre-commit hook formats, lints, and
typechecks; the pre-push hook runs the full test suite.

## License

MIT — see [LICENSE](./LICENSE).
