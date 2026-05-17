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
  <a href="#hooking-up-hermes-agent">Hermes Agent</a> ·
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

Single Node process, packaged as a multi-arch Docker image (`linux/amd64`, `linux/arm64`); the `pnpm dlx rembric` path stays available as a power-user fallback during the dual-publish window.

Four load-bearing invariants:

- **Append-only**: rows are never deleted; `content` never updated. Lifecycle is `status` flips + `replaces` links. Every consolidation op is reversible.
- **Project scoping by construction**: every memory is `global` or attached to one `project_id`. Consolidation and relations never cross scope.
- **Convergent topics via `topic_key`**: on `memory.save`, the previously-active row in the same `(scope, project_id, topic_key)` is auto-superseded atomically.
- **Fresh-context judgment**: candidate conflicts surface at save time (`candidates[]`); the agent that produced the conflict judges it. The nightly consolidator only handles decay + orphan promotion.

See [docs/relations.md](./docs/relations.md) for the relation taxonomy.

## Quickstart (Docker)

Docker is the canonical install path. The image bundles Node 20 and the native modules (`better-sqlite3`, `sqlite-vec`) pre-built for `linux/amd64` and `linux/arm64`, so the only requirement on your host is Docker.

```bash
git clone https://github.com/susomejias/rembric.git && cd rembric

cp .env.example .env
# edit .env:  set REMBRIC_ADMIN_TOKEN (e.g. `openssl rand -hex 32`)
#             confirm OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL

docker compose up -d
docker compose logs -f rembric
```

MCP at `http://<host>:8787/mcp`, dashboard at `http://<host>:8787/dashboard` (replace `<host>` with `127.0.0.1` if running on the same host as your agent, or the LAN/Tailscale hostname of the box hosting Rembric otherwise).

### Running on a remote host (LXC, NAS, server) — the canonical case

The compose file publishes port `8787` on **all interfaces** of the host so your agent on another machine can reach it. Point the plugin at `http://<host-ip>:8787` (LAN) or `http://rembric.tailnet:8787` (Tailscale). Don't expose port 8787 directly to the public internet — front it with Tailscale, WireGuard, or your reverse proxy of choice. The bearer token is the real security boundary; every endpoint requires `Authorization: Bearer <token>`.

### Running on the same host as your agent — loopback override

If you want to restrict the published port to loopback (stricter posture, same-host dev only), drop a `docker-compose.override.yml` next to the canonical compose:

```yaml
services:
  rembric:
    ports: !override
      - '127.0.0.1:${REMBRIC_PORT:-8787}:8787'
```

Compose auto-merges the override on every `up`. Point your agent at `http://127.0.0.1:8787`. See [`docs/docker.md`](./docs/docker.md) for the full topology guide.

### Upgrading

Docker manages versions for you. With `REMBRIC_VERSION` unset in `.env`, the compose file pulls `:latest`:

```bash
docker compose pull
docker compose up -d
```

Portainer / Arcane detect the new digest automatically and offer a "Recreate container" button — one click. For reproducible deploys, pin a specific version in `.env`:

```ini
REMBRIC_VERSION=0.13.0
```

### Rolling back

Bump `REMBRIC_VERSION` to a previous tag in `.env` and re-run `docker compose up -d`. The bind-mounted `./data/` directory is untouched, so your memory stays intact across version flips.

See [docs/docker.md](./docs/docker.md) for the full operator guide (private GHCR auth, named-volume vs bind-mount, host-on-Linux `host.docker.internal` notes, troubleshooting).

### Backups

```bash
# while the container is running (WAL-safe online backup):
docker compose exec rembric sqlite3 /data/data.db ".backup /data/backup-$(date +%Y%m%d).db"
mv ./data/backup-*.db ./backups/

# or stop + copy for a cold backup:
docker compose down
cp ./data/data.db ./backups/data-$(date +%Y%m%d).db
docker compose up -d
```

**Do not bind-mount `./data/` onto NFS / SMB / network filesystems** — SQLite's POSIX locking guarantees don't hold there, and you'll eventually corrupt the DB.

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

## Hooking up Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) has a native Python `MemoryProvider` ABC, so Rembric ships as a memory-provider plugin from `plugin/.hermes-plugin/`. One-line install:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

Then add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  rembric:
    command: npx
    args:
      [
        '-y',
        'mcp-remote@latest',
        '${REMBRIC_SERVER_URL}/mcp',
        '--header',
        'Authorization: Bearer ${REMBRIC_API_TOKEN}',
        '--allow-http',
      ]

memory:
  provider: rembric
```

The provider gives you lifecycle (session create / summary-on-compact / end-on-close), the MCP bridge gives you the full tool surface. Wire both. Full docs (slug cascade, env vars, troubleshooting): [`plugin/.hermes-plugin/README.md`](./plugin/.hermes-plugin/README.md).

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

The CLI is invoked inside the running container with `docker compose exec`:

| Command                                                                      | Purpose                                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `docker compose exec rembric rembric project create <slug> [--name <name>]`  | Mint a project. Slug must match `[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?`. |
| `docker compose exec rembric rembric project list [--all] [--table]`         | List projects (JSON default; `--table` for humans).                   |
| `docker compose exec rembric rembric session list [--include-deleted]`       | Inspect agent sessions.                                               |
| `docker compose exec rembric rembric session delete <id>`                    | Soft-delete (audit trail preserved).                                  |
| `docker compose exec rembric rembric token create <name> [--project <slug>]` | Mint a bearer token. Plaintext shown exactly once.                    |
| `docker compose exec rembric rembric token revoke <name>`                    | Revoke a token (effective immediately).                               |

If you prefer the native CLI on the host (Node 20+ required), see "Development" below for the npm install path. Projects are also creatable from `/dashboard/projects`.

## Dashboard maintenance (manual purges)

The dashboard exposes `/dashboard/maintenance` for two **irreversible**, **operator-triggered** physical purges. Both are gated to dashboard sessions whose underlying token has scope `*` (admin):

- **Purge empty sessions** — removes `ended` / `abandoned` session rows that have no summary, no manual title, no referencing memories/prompts/confirmations, are not operator-soft-deleted, and ended over 1 hour ago.
- **Purge disconnected archived memories** — removes `archived` memory rows whose ids are referenced by NO other row in the graph (`memory.replaces`, `consolidation_ops.affected_ids` / `created_id`, `memory_relations.{source,target}_id`, `confirmations.memory_id`). The matching `memory_vec` and `memory_fts` shadow rows are dropped in the same transaction.

Each click shows a count and a confirmation modal. The deletion is journaled in `consolidation_ops` (`op_type = 'session_purge'` or `'archived_memory_purge'`) so the operator can audit what was removed even after the rows are gone. **Consolidation undo on operations whose rows have been purged returns a structured error** — the dashboard surfaces it inline naming the missing ids.

To reclaim file-level disk after a large purge, run `VACUUM` against the SQLite file. The maintenance page surfaces the freelist size so you know how much would be reclaimed.

## Configuration

All config via environment variables. With Docker, these live in `.env` and are loaded automatically by `docker compose up`. Required: `REMBRIC_ADMIN_TOKEN` (used to log into the dashboard and mint other tokens).

### Server

| Variable           | Default                           | Description                                                                                                   |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `REMBRIC_HOST`     | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address. Pinned to `0.0.0.0` inside the container so the published port works; never override in Docker. |
| `REMBRIC_PORT`     | `8787`                            | Bind port.                                                                                                    |
| `REMBRIC_DATA_DIR` | `~/.rembric` (`/data` in Docker)  | Where the SQLite file lives. Pinned to `/data` inside the container; bind-mount `./data:/data` in compose.    |
| `LOG_LEVEL`        | `info`                            | `debug` / `info` / `warn` / `error`.                                                                          |

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

| Variable                   | Default     | Description                                                                                |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `CONSOLIDATION_ENABLED`    | `true`      | Background consolidation toggle.                                                           |
| `CONSOLIDATION_CRON`       | `0 3 * * *` | Cron schedule.                                                                             |
| `CONSOLIDATION_BATCH_SIZE` | `50`        | Maximum candidate pairs evaluated per consolidation run. Higher = more LLM cost per night. |
| `JUDGMENT_ORPHAN_AFTER_MS` | `86400000`  | Age (ms) past which pending judgments are sent to the LLM judge. Default 24h; max 30 days. |

### Rate limiting

Per-token token-bucket limiter on `/mcp` requests. Disabled by default — single-user localhost deployments don't need it. Enable when exposing the server to multiple agents that might burst-call.

| Variable             | Default | Description                                                                                                |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED` | `false` | Master toggle. `true` activates the limiter; misbehaving tokens get `429 rate_limited` with `Retry-After`. |
| `RATE_LIMIT_RPS`     | `10`    | Refill rate per token, in requests per second.                                                             |
| `RATE_LIMIT_BURST`   | `30`    | Burst capacity per token. The first N requests after a quiet period are free; beyond that, RPS applies.    |

### Sessions

| Variable                   | Default    | Description                                                                                                                                                    |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_ABANDON_AFTER_MS` | `86400000` | At server startup, sessions with `status='active'` whose `started_at` is older than this are flipped to `abandoned`. Default 24h; floor 1min, ceiling 30 days. |

### Candidate detection (save-time judgment)

Controls how `memory.save` surfaces conflict candidates to the agent for fresh-context judgment.

| Variable                  | Default | Description                                                                                                             |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CANDIDATES_PER_SAVE_MAX` | `5`     | Max number of similar memories surfaced per save. `0` disables surfacing (pending rows are still inserted for nightly). |
| `CANDIDATE_VEC_THRESHOLD` | `0.85`  | Cosine-similarity floor on the embedding match. Range `0..1`. Lower = more candidates, more noise.                      |
| `CANDIDATE_FTS_THRESHOLD` | `0.4`   | BM25-derived score floor on the FTS5 match. Range `0..1`.                                                               |

## Development

### Running without Docker (power users only)

If you already have Node 20+ and want the native CLI on the host (e.g. `rembric token create` invoked directly), the npm package keeps working:

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)

pnpm dlx rembric                 # one-shot
# or:
pnpm add -g rembric && rembric
```

The npm path is **secondary**. Docker is the canonical install everyone else gets pointed at; npm stays available during a dual-publish window so the native CLI doesn't disappear overnight. It will be sunset eventually — see `openspec/changes/make-docker-primary-distribution/design.md::Decision 10`.

### Hacking on Rembric itself

```bash
pnpm install
pnpm run dev          # tsc --watch
pnpm test             # full vitest suite + Hermes Python tests
pnpm run typecheck    # tsc --noEmit
pnpm run lint
```

For a clean Docker build from source:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## More docs

- [docs/docker.md](./docs/docker.md) — Docker operator guide (topologies, private GHCR auth, upgrade/rollback, troubleshooting).
- [docs/agents.md](./docs/agents.md) — per-client MCP config (Codex, Cursor, Windsurf, VS Code, Gemini, …).
- [docs/troubleshooting.md](./docs/troubleshooting.md) — common errors and recovery.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Commits follow Conventional Commits; pre-commit lints and typechecks; pre-push runs the full test suite.

## License

MIT — see [LICENSE](./LICENSE).
