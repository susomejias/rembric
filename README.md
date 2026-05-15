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
                                           │  URL path: /mcp/<slug>  (or /mcp + project.use)
                                           ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                       rembric  (single Node process)                  │
   │                                                                       │
   │   ┌────────────────────────────┐   ┌───────────────────────────────┐  │
   │   │  /mcp       /mcp/<slug>    │   │  /dashboard                   │  │
   │   │  Streamable HTTP transport │   │  SSR HTML + HTMX              │  │
   │   │  + initialize.instructions │   │  ┌─────────────────────────┐  │  │
   │   │  ┌──────────────────────┐  │   │  │ /login   /memories      │  │  │
   │   │  │ memory.{save,search, │  │   │  │ /sessions  /consolidat. │  │  │
   │   │  │   get,confirm}       │  │   │  │ /projects  /tokens      │  │  │
   │   │  │ memory.session_*     │  │   │  └─────────────────────────┘  │  │
   │   │  │ memory.context       │  │   │                               │  │
   │   │  │ memory.timeline      │  │   │                               │  │
   │   │  │ memory.capture_pass. │  │   │                               │  │
   │   │  │ memory.doctor/stats  │  │   │                               │  │
   │   │  │ memory.save_prompt   │  │   │                               │  │
   │   │  │ memory.suggest_topic │  │   │                               │  │
   │   │  │ memory.judge         │  │   │                               │  │
   │   │  │ memory.compare       │  │   │                               │  │
   │   │  │ project.{use,list,   │  │   │                               │  │
   │   │  │          current}    │  │   │                               │  │
   │   │  └──────────────────────┘  │   │                               │  │
   │   └─────────────┬──────────────┘   └─────────────┬─────────────────┘  │
   │                 │                                │                    │
   │                 ▼                                ▼                    │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  Service layer                                                │   │
   │   │   MemoryService (save = insert + topic_key upsert +           │   │
   │   │                  save-time candidate detection)               │   │
   │   │   RelationsService · ProjectsService · TokensService          │   │
   │   │   AgentSessionsService · PromptsService · SessionRouter       │   │
   │   └───────────────────────────────┬───────────────────────────────┘   │
   │                                   │                                   │
   │                                   ▼                                   │
   │   ┌───────────────────────────────────────────────────────────────┐   │
   │   │  SQLite (Drizzle ORM, append-only + tombstones)               │   │
   │   │   memory (+ topic_key) · projects · confirmations · tokens    │   │
   │   │   sessions (+ deleted_at) · prompts · memory_relations        │   │
   │   │   consolidation_runs · consolidation_ops · dashboard_sessions │   │
   │   │   + memory_fts  (FTS5)      + memory_vec  (sqlite-vec)        │   │
   │   └───────────────────────────────▲───────────────────────────────┘   │
   │                                   │                                   │
   │                                   │ pending → judged | orphaned       │
   │   ┌───────────────────────────────┴───────────────────────────────┐   │
   │   │  Background workers                                           │   │
   │   │   EmbeddingWorker          (every 30s + pre-consolidation)    │   │
   │   │   ConsolidationScheduler   (CONSOLIDATION_CRON, default 03:00)│   │
   │   │     ├── decay              (deterministic, no LLM)            │   │
   │   │     └── orphan promotion   (LLM judge over pending relations  │   │
   │   │                              older than JUDGMENT_ORPHAN_*)    │   │
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

The save → judge flow (when `memory.save` finds similar memories):

```
   agent ──▶ memory.save({type, content, topic_key?})
                │
                ▼ atomic transaction
   ① insert row     ② if topic_key, supersede previous in slot
                              │
                              ▼
                ③ candidate detection (FTS5 + vec kNN, scoped)
                              │
                              ▼
                ④ insert memory_relations rows (status='pending')
                              │
                              ▼
                ⑤ return { id, candidates[], judgmentRequired }
                              │
                              ▼
   agent reads response, judges per candidate:
     memory.judge({judgmentId, relation: 'supersedes' | 'related' | …})
       ├─ 'supersedes' → target → status='superseded',
       │                  source.replaces += target.id  (atomic)
       └─ other         → metadata-only update on the relation row

   agent never judged in time?
       └─ consolidator's orphan-promotion pass picks it up after
          JUDGMENT_ORPHAN_AFTER_MS (default 24h) and either
          promotes it via the LLM judge or marks it orphaned.
```

Four load-bearing invariants:

- **Append-only memory**: rows are never DELETEd; `content` is never UPDATEd. Lifecycle is `status` flips (`active` → `superseded` | `archived`) and `replaces` links. Every consolidation op lands in a reversible journal.
- **Project scoping by construction**: every memory is `global` or attached to a single `project_id`. The consolidation engine and `memory_relations` never cross scope boundaries.
- **Convergent topics via `topic_key`**: when supplied on `memory.save`, the previously-active row in the same `(scope, project_id, topic_key)` is auto-superseded atomically. The agent declares identity; the server enforces uniqueness of the head.
- **Fresh-context judgment**: candidate conflicts surface at `memory.save` time (`candidates[]` in the response). The agent that produced the conflict is the agent that judges it. The nightly consolidator no longer does LLM-driven detection — it only handles decay + orphan promotion of pending judgments the agent never closed.
- **Provider-namespaced env vars**: `LLM_PROVIDER=openai` (only option today) routes to `OPENAI_*` namespace. The same code works against OpenAI, Ollama, LM Studio, vLLM, etc.

See [docs/relations.md](./docs/relations.md) for the relation taxonomy and how annotations propagate to search results.

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

### Claude Code plugin (easiest)

If you use Claude Code, install the bundled plugin instead of editing `.mcp.json`
by hand. The plugin ships the MCP server config, a memory-usage skill, four
`/rembric:*` commands, and lifecycle hooks that fire memory ops without the
model having to remember them. See [`plugin/README.md`](./plugin/README.md) for
the algorithm details and token budget.

```bash
claude plugin marketplace add git@github.com:susomejias/rembric.git
claude plugin install rembric@rembric
```

You'll be prompted for your server URL and API token at install time. The
token is stored in your system keychain, never in `settings.json`.

### Manual config (any MCP client)

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

### Operating the CLI

| Command                                                           | Purpose                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `rembric project create <slug> [--name <name>]`                   | Mint a project. Slug must match `[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?`.                    |
| `rembric project list [--all] [--table]`                          | List active (or `--all`) projects. JSON by default; `--table` for human-readable output. |
| `rembric session list [--status …] [--include-deleted] [--table]` | Inspect agent sessions. Add `--include-deleted` to surface soft-deleted rows.            |
| `rembric session delete <id>`                                     | Soft-delete a session (audit trail preserved; hidden from default listings).             |
| `rembric token create <name> [--project <slug>]`                  | Mint a bearer token. Plaintext is shown exactly once.                                    |
| `rembric token revoke <name>`                                     | Revoke a token (effective immediately).                                                  |

Projects are also creatable from `/dashboard/projects` via the always-visible
form at the top of the page — same validation, same end state.

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

| Variable                   | Default     | Description                                                    |
| -------------------------- | ----------- | -------------------------------------------------------------- |
| `CONSOLIDATION_ENABLED`    | `true`      | Background consolidation toggle.                               |
| `CONSOLIDATION_CRON`       | `0 3 * * *` | Cron schedule for the consolidation.                           |
| `CONSOLIDATION_BATCH_SIZE` | `50`        | Pending relations considered per orphan-promotion pass.        |
| `JUDGMENT_ORPHAN_AFTER_MS` | `86400000`  | Age threshold past which a pending judgment is sent to the LLM |
|                            |             | judge during consolidation; verdicts the LLM can't resolve are |
|                            |             | marked `orphaned`.                                             |

### Save-time candidate detection

| Variable                  | Default | Description                                                             |
| ------------------------- | ------- | ----------------------------------------------------------------------- |
| `CANDIDATES_PER_SAVE_MAX` | `5`     | Max candidates surfaced to the agent in `memory.save.candidates[]`. Set |
|                           |         | to `0` to disable surfacing (pending rows are still inserted for the    |
|                           |         | consolidator). Range 0–25.                                              |
| `CANDIDATE_VEC_THRESHOLD` | `0.85`  | Cosine-similarity floor for vec candidate detection (0..1).             |
| `CANDIDATE_FTS_THRESHOLD` | `0.4`   | Normalized BM25-rank floor for FTS5 candidate detection (0..1).         |

### Sessions

| Variable                   | Default    | Description                                                |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `SESSION_ABANDON_AFTER_MS` | `86400000` | At startup, agent sessions stuck `active` longer than this |
|                            |            | are flipped to `abandoned`.                                |

### Rate limiting

| Variable             | Default | Description                                                |
| -------------------- | ------- | ---------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `false` | Per-token token-bucket rate limiter on the `/mcp` surface. |
| `RATE_LIMIT_RPS`     | `10`    | Sustained requests-per-second per token.                   |
| `RATE_LIMIT_BURST`   | `30`    | Bucket capacity (max burst before sustained rate applies). |

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
