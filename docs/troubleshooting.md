# Troubleshooting

> If your symptom isn't here, probe `curl -sS -H "Authorization: Bearer $REMBRIC_ADMIN_TOKEN" http://127.0.0.1:8787/healthz` (200 + `{"ok":true,...}` = liveness + DB ping passed) and check the server logs (structured JSON on stderr). The startup banner dumps env vars with secrets redacted.

## Startup

### `REMBRIC_ADMIN_TOKEN is required on first run`

On a fresh data dir, set the env var before launching:

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose up -d
```

Once a row exists, the env var is ignored on subsequent runs. Rotate via the dashboard at `/dashboard/tokens`.

### `Invalid configuration: OPENAI_API_KEY is required …`

Required when `CONSOLIDATION_ENABLED=true` (default). For Ollama / LM Studio, any non-empty string works (`OPENAI_API_KEY=sk-local`). For OpenAI proper, use a real `sk-…`. To disable all LLM calls: `CONSOLIDATION_ENABLED=false` and `EMBEDDING_ENABLED=false`.

### `Error: address already in use :::8787`

Another process holds the port. `lsof -i :8787` to find it, or set `REMBRIC_PORT`. A force-killed instance can leave the WAL dirty — SQLite recovers on restart.

## LLM endpoint

Probe the configured endpoint directly:

```bash
curl -sS -H "Authorization: Bearer $OPENAI_API_KEY" "$OPENAI_BASE_URL/models"
```

### Connection refused / timeout

`OPENAI_BASE_URL` is unreachable from the rembric host. If running rembric inside Docker against an Ollama / LM Studio on the host, the URL must be reachable from inside the container (use `host.docker.internal` on Mac/Windows or the host's LAN IP on Linux, not `127.0.0.1`). Confirm `OPENAI_BASE_URL` ends in `/v1`.

### `401` / `403` on `/models`

For OpenAI proper, the key is wrong or revoked. For Ollama / LM Studio, the upstream is rejecting the request — the `/models` listing should include the value configured in `OPENAI_MODEL`.

### Consolidation runs are very slow

Round cost = (candidate pairs) × (LLM judge latency). Lower `CONSOLIDATION_BATCH_SIZE` (default 50) for slow local models. Per-op `reasoning` is visible at `/dashboard/consolidation/<id>`.

## Database

### `SQLITE_BUSY: database is locked`

Three causes:

1. Two writers running (two `rembric` processes, or one + an open `sqlite3` shell). WAL allows many readers but one writer.
2. A backup's `.backup` write lock — retry; rembric has a 5s `busy_timeout`.
3. A long external transaction (close any shells you opened against the data dir).

### A migration failed mid-flight

Each migration runs in one transaction, so partial migrations roll back. If startup still fails: restore the latest backup (see `docs/backup.md`), reset `_migrations` to drop the failed row, restart.

## MCP transport

### Pending judgments piling up in search annotations

Every save inserts `memory_relations` rows with `status='pending'` for each candidate. If the agent ignores `candidates[]`, they accumulate as `pending_conflict` annotations.

- The consolidator's orphan-promotion pass closes them after `JUDGMENT_ORPHAN_AFTER_MS` (default 24h).
- If the agent never calls `memory.judge`, confirm the tool is in `tools/list` and paste the relations excerpt into the agent's prompt.

See [docs/relations.md](./relations.md).

### Agent never calls `memory.session_summary` before saying "done"

The protocol-teaching `instructions` block fires at handshake but some MCP clients ignore the field. Confirm:

1. The client honors `initialize.instructions` (Claude Code and Codex CLI do).
2. `tools/list` returns `memory.session_summary` with a description.

Workaround: paste the summary protocol into the client's per-project rules file.

### Agent reports `expected "Bearer <token>"`

The agent sent a plain token. Configure the MCP entry to set `Authorization: Bearer <token>` explicitly.

### Saves succeed but `memory.search` returns nothing

Three possibilities:

1. **Scope mismatch.** `/mcp` connections see only global; `/mcp/<slug>` sees only that project. Crossed scopes return empty by design.
2. **FTS5 query syntax.** Default tokenizer treats `-`, `:`, `.` as separators. `agent-name` searches as two tokens.
3. **Decay archived it.** Check the dashboard with `status=archived` (overview counters at `/dashboard` show archived totals too).

### `code: scope_locked`

You connected to `/mcp/<slug>` and asked for `scope=global`. Open a second connection at `/mcp` for user-wide writes.
