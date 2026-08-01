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

### `⚠ ignoring removed env vars …` warning at boot

Older deployments configured a chat LLM, a consolidation cron, or an external embedding provider (`LLM_PROVIDER`, `OPENAI_*`, `CONSOLIDATION_*`, `EMBEDDING_*`, `CANDIDATE_*_THRESHOLD`). None of that exists anymore: the sweep is deterministic and the embedding model runs in-process from the image. The warning is informational — remove the listed vars from `.env` to silence it.

### `Error: address already in use :::8787`

Another process holds the port. `lsof -i :8787` to find it, or set `REMBRIC_PORT`. A force-killed instance can leave the WAL dirty — SQLite recovers on restart.

## Embeddings (in-process)

### `embedding worker error: …` in the logs

The in-process embedder failed an inference. Failed rows are retried on the next 30s drain tick; candidate detection falls back to FTS5 in the meantime. Persistent failures usually mean the container is memory-starved — check `docker stats` against the 1 GB minimum.

### The server exits at boot with a model-load error

The embedding model is required: a missing, corrupt, or incompatible model aborts the boot (fail fast — there is no degraded no-embeddings mode). In the Docker image this indicates a broken image build (the build itself validates the model, so prefer re-pulling). On bare metal, the first boot downloads the model (~300 MB, one-time) — a network failure there also aborts; retry with connectivity.

### Vectors missing right after an upgrade

A model change wipes stale vectors and re-embeds the corpus in background batches (`↻ embedding identity reset → N stale vector(s) wiped` in the logs, then a `◆ embedding drain complete` line with similarity percentiles). FTS-based detection works throughout; vec-sourced candidates for OLD rows resume when the drain completes. New saves embed inline and are unaffected.

A second warning naming `embedding-state.json` means the identity marker could not be written. The boot proceeds either way. If it appears **without** a wipe line, nothing was removed and the index still holds vectors from the previous recipe — `memory.doctor` reports that as an owed reset while the rows are still there, and dense search stays unreliable until a boot with a writable data dir succeeds. If it appears **after** a wipe line, the rebuild is already under way but may be repeated on the next boot. Both cases are usually a full or read-only `REMBRIC_DATA_DIR`.

## Database

### `SQLITE_BUSY: database is locked`

Three causes:

1. Two writers running (two `rembric` processes, or one + an open `sqlite3` shell). WAL allows many readers but one writer.
2. A backup's `.backup` write lock — retry; rembric has a 5s `busy_timeout`.
3. A long external transaction (close any shells you opened against the data dir).

### A migration failed mid-flight

Each migration runs in one transaction, so partial migrations roll back. If startup still fails: restore the latest backup (see `docs/backup.md`), reset `_migrations` to drop the failed row, restart.

## One-click updates

### Dashboard still shows "Manual update" with the Docker socket mounted

The container runs as the unprivileged `rembric` user, and on most Linux hosts `/var/run/docker.sock` is `root:docker` mode `660` — mounted but unreadable. The logs confirm it:

```
ℹ docker socket at /var/run/docker.sock is mounted but not usable (check group_add); one-click updates disabled
```

Grant the socket's group to the container and recreate it:

```bash
stat -c '%g' /var/run/docker.sock   # e.g. 991
```

```yaml
services:
  rembric:
    group_add:
      - '991'
```

Capability detection is cached for 30 s — reload the dashboard after `docker compose up -d`.

### Update button missing on a pinned version

If `.env` pins `REMBRIC_VERSION=x.y.z`, one-click is refused by design (the next `docker compose up` would silently revert a self-update). The modal explains the pin; see [docs/updates.md](./updates.md#pinned-versions-disable-one-click).

### `exec: "node": executable file not found in $PATH` when updating to v0.21.14+

The runtime image moved to a distroless base in v0.21.14 (node is at `/nodejs/bin/node`, not bare `node`). Updating _from_ a pre-fix version (≤ v0.21.14) via the dashboard fails this way, because the old server launches the upgrader with bare `node`. Your live container is untouched — you keep serving the old version. This is a one-time hop; see [docs/updates.md](./updates.md#updating-across-the-distroless-boundary-one-time-v02114).

## MCP transport

### Pending judgments piling up in search annotations

Every save inserts `memory_relations` rows with `status='pending'` for each candidate. If the agent ignores `candidates[]`, they accumulate as `pending_conflict` annotations.

- After `JUDGMENT_ORPHAN_AFTER_MS` (default 24h) they re-surface in `memory.context.pendingJudgments[]` for any agent to close with `memory.judge` — unless one of the pair has since left `active`, in which case the queue withholds it (the sweep still orphans it at the deadline, and `/dashboard/judgments` still lists it).
- After `JUDGMENT_ORPHAN_DEADLINE_MS` (default 14 days) the deterministic sweep marks them `orphaned` (journaled, undoable from `/dashboard/consolidation`).
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
