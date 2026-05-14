# Troubleshooting

> If you don't find your symptom here, run `rembric status` for a quick health snapshot and check the server logs (rembric prints structured JSON to stderr). A clean reproduction goes a long way — file an issue with the env-var dump from the startup banner (secrets are already redacted).

## Startup

### `REMBRIC_ADMIN_TOKEN is required on first run`

The very first time rembric starts against a fresh data dir, it needs a value to seed the `admin` token row. Generate a strong random value and export it before launching the server:

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)
npx rembric
```

On subsequent runs the env var is **ignored** — once a row exists, rotating the admin token is done via the dashboard (`/dashboard/tokens`) or `rembric token create` + revoke.

### `Invalid configuration: OPENAI_API_KEY is required …`

Set when `CONSOLIDATION_ENABLED=true` (the default). For Ollama / LM Studio / local stacks, any non-empty string works:

```bash
export OPENAI_API_KEY=sk-local
```

For OpenAI proper, use a real `sk-…` key. If you don't want any LLM calls, set `CONSOLIDATION_ENABLED=false` and `EMBEDDING_ENABLED=false`.

### `Error: address already in use :::8787`

Another process holds the port. Find it with `lsof -i :8787` or set `REMBRIC_PORT` to another value. If you intended to reuse the port: check whether a previous instance shut down cleanly, and if not, kill it. Rembric ignores `SIGKILL` cleanup so a force-killed process can leave the WAL file dirty (still safe to restart against — SQLite recovers).

---

## LLM endpoint

### `rembric llm ping` reports `network` / `timeout`

The configured `OPENAI_BASE_URL` is unreachable. Sanity-check from the same machine:

```bash
curl -sS -X POST $OPENAI_BASE_URL/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"'"$OPENAI_MODEL"'","messages":[{"role":"user","content":"ping"}]}'
```

If that fails, the problem is below rembric (firewall, missing Ollama, wrong base URL). If it succeeds, double-check `OPENAI_BASE_URL` actually ends in `/v1`.

### `rembric llm ping` reports `auth`

For OpenAI proper, the key is wrong or revoked. For Ollama / LM Studio, the upstream rejected the model name — they're permissive about the key but strict about the model. Run `curl $OPENAI_BASE_URL/models` and confirm `OPENAI_MODEL` appears in the list.

### Consolidation runs are very slow

Pull-the-thread approach: in the dashboard at `/dashboard/consolidation/<id>`, look at the `model` and the per-op `reasoning`. A consolidation round = (number of candidate pairs) × (LLM judge latency). If you're on a slow local model, lower `CONSOLIDATION_BATCH_SIZE` (default 50) to bound the work per cron tick.

---

## Migrations

### `database is locked` during `rembric db migrate`

The server is running. Migrations on disk are a single-writer operation — run `rembric db migrate` only with the server stopped. Inside a normal startup, migrations run automatically.

### A migration failed mid-flight and now nothing starts

Each migration is wrapped in a single transaction, so partial migrations roll back cleanly. If you see this, it's almost always one of:

1. An `ALTER TABLE` that requires a backfill — open the failing migration and look for the rollback hint in the comments.
2. A foreign key violation due to legacy data inserted outside the service layer. Inspect with `sqlite3 ~/.rembric/data.db '.tables'` and report a bug.

Recovery: restore the most recent backup (see `docs/backup.md`), reset `_migrations` so the failed entry is gone, and re-run startup.

---

## Locked database

### `SQLITE_BUSY: database is locked`

Three causes, in order of likelihood:

1. **A second writer is running.** Two `rembric` processes, or one `rembric` plus a `sqlite3` shell with `BEGIN IMMEDIATE`. Only one writer at a time. The server's WAL mode lets many readers run concurrently, but the writer is exclusive.
2. **A backup grabbed the write lock.** `sqlite3 .backup` takes a write lock briefly. Retry — rembric also retries internally with a 5-second `busy_timeout`.
3. **A long transaction.** Should not happen with rembric (every write is short), but if you've poked at the data dir manually, close any open shells.

### The dashboard is slow or unresponsive

Run `rembric status` from another shell. If that hangs, the SQLite handle is contended (see above). If it returns instantly, the dashboard process is healthy and the issue is upstream (browser, reverse proxy).

---

## MCP transport

### Too many pending judgments showing up in `memory.search` annotations

The new save flow (v0.5+) inserts a `memory_relations` row with `status='pending'` for every candidate it surfaces to the agent. When the agent ignores `candidates[]` in the save response, those rows accumulate and surface as `pending_conflict` annotations on subsequent searches.

Two paths:

1. **Wait for the consolidator.** After `JUDGMENT_ORPHAN_AFTER_MS` (default 24h), the consolidator's orphan-promotion pass runs the LLM judge over each pending row and resolves or orphans it.
2. **Check why the agent isn't calling `memory.judge`.** Inspect `tools/list` from the client; confirm `memory.judge` is exposed. If the agent ignores `judgmentRequired: true` in the save response, paste the relation-flow excerpt from `docs/relations.md` into the agent's prompt.

See [docs/relations.md](./relations.md) for the full lifecycle and the relation taxonomy.

### Agent never calls `memory.session_summary` before saying "done"

The protocol-teaching `instructions` block fires at handshake but some MCP clients ignore the field. Two checks:

1. **Confirm the client honors `instructions`.** Claude Code and Codex CLI inject it into the LLM system prompt. Older or stripped builds may not. Check the client's docs.
2. **Confirm `tools/list` returns `memory.session_summary` with a description.** If the description is missing or the tool is absent, the LLM has no nudge to call it. Run a `tools/list` request manually to verify.

Workaround: paste the protocol from `docs/agents.md` into the agent's per-project / per-session prompt manually. The tool descriptions teach the same thing, but a system-prompt nudge raises the hit rate further.

### Agent reports `expected "Bearer <token>"`

The agent is sending a plain token, not a `Bearer <token>` header. Configure the agent's MCP entry to set `Authorization: Bearer <token>` explicitly.

### Agent saves succeed but `memory.search` returns nothing

Three possibilities:

1. **Scope mismatch.** A `/mcp` connection sees only **global** memories; `/mcp/<slug>` sees only that project. If the agent saved under one and is searching under the other, results will be empty by design.
2. **FTS5 query syntax.** The default tokenizer treats `-`, `:`, and `.` as separators. `agent-name` is searched as two tokens; `agent` alone matches.
3. **The save was archived by decay.** Run `rembric status` and check the `archived` count; or query the dashboard with `status=archived`.

### `code: scope_locked` when saving from a path-scoped agent

You connected to `/mcp/<slug>` and asked for `scope=global`. That's intentionally rejected — open a second MCP connection at `/mcp` (no slug) for user-wide writes.

---

## Reverse proxy

### Agent sees 502 from Caddy / Nginx

The MCP transport uses Server-Sent Events for the response stream. Your proxy needs:

- `proxy_buffering off;` (Nginx) — otherwise SSE chunks queue indefinitely.
- `flush_interval 0s` (Caddy) — same reason.

The reference configs under `examples/` already set these. Diff your config against them if you copy-pasted from a generic template.
