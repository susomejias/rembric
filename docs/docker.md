# Docker operator guide

The canonical install for Rembric. Versioned image at `ghcr.io/susomejias/rembric` (public), one process, one SQLite file, one bind-mount.

## Topologies

Rembric supports two deployment shapes; the only difference is one line of compose config and where you point the plugin URL.

### Remote host (LXC, NAS, server) — the canonical case

Server lives on a different machine than your agent. The compose file ships configured for this — port `8787` is published on **all interfaces** of the host so the agent on your laptop can reach it. Don't expose 8787 to the public internet though — front it with Tailscale, WireGuard, or your VPN.

```
┌─ your laptop ──────────────────┐    ┌─ LXC / NAS / server ──────────────────┐
│ Claude Code / Codex / Hermes   │    │ docker container "rembric"            │
│       │                        │    │   bind: 0.0.0.0:8787:8787 (default)   │
│       │ Tailscale / VPN / LAN  │ ─► │   volume: ./data → /data              │
│       │                        │    │   env_file: .env                      │
│       ▼                        │    │                                       │
│ http://rembric.tailnet:8787    │    │                                       │
└────────────────────────────────┘    └───────────────────────────────────────┘
```

Set `REMBRIC_SERVER_URL` on the plugin side to the reachable hostname:

- Tailscale: `http://rembric.your-tailnet.ts.net:8787`
- LAN: `http://192.168.x.x:8787` (only if your LAN is trusted)
- Reverse proxy with TLS: `https://memory.example.com` (then drop `:8787` if behind 443)

The bearer token is the real security boundary; every endpoint requires `Authorization: Bearer <token>`. Belt-and-suspenders defenses (firewall the port to your trust boundary, Tailscale ACLs, reverse-proxy with mTLS, etc.) are operator's call.

### Same host as your agent — loopback override

If Rembric and your agent live on the same machine and you want the stricter posture, restrict the publish to loopback via an override file. **This is opt-in** — the default compose binds to all interfaces.

```
┌─ your laptop / dev box ───────────────────────────┐
│                                                   │
│  Claude Code / Codex / Hermes                     │
│         │                                         │
│         │  bridge stdio↔HTTP                      │
│         ▼                                         │
│  http://127.0.0.1:8787/mcp/<slug>                 │
│                                                   │
│  ┌─ docker container "rembric" ───────────────┐   │
│  │  bind: 127.0.0.1:8787:8787 (via override)  │   │
│  │  volume: ./data → /data                    │   │
│  │  env_file: .env                            │   │
│  └────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────┘
```

Drop a `docker-compose.override.yml` next to the canonical compose:

```yaml
services:
  rembric:
    ports: !override
      - '127.0.0.1:${REMBRIC_PORT:-8787}:8787'
```

Compose auto-merges `docker-compose.override.yml` on every `up`. The `!override` tag replaces the ports list rather than appending — without it you'd get two bindings (`0.0.0.0:8787` AND `127.0.0.1:8787`) and the loopback one would be redundant.

## Private GHCR access (during the closed-repo phase)

While the image is private, you authenticate against GHCR with a personal access token (classic PAT) that has at least `read:packages` scope.

```bash
# create a classic PAT at https://github.com/settings/tokens (scopes: read:packages)
echo "$GH_PAT" | docker login ghcr.io -u <your-gh-username> --password-stdin
docker compose pull
```

Once the project goes public, this step disappears — `docker compose pull` works without auth.

## Volumes

The compose file bind-mounts `./data:/data` (relative to the compose file's directory). This is **deliberate**: the SQLite file is visible to the operator, easy to back up with regular tools, and easy to inspect with `sqlite3 ./data/data.db`.

### Named volume alternative

If you prefer Docker-managed volumes (more portable, but the data is hidden inside the Docker root):

```yaml
services:
  rembric:
    volumes:
      - rembric-data:/data

volumes:
  rembric-data:
```

### Don't bind-mount onto network filesystems

SQLite's POSIX-locking guarantees don't hold over NFS / SMB / CIFS. You will eventually corrupt the database. Stick to a local filesystem — Btrfs / ZFS / ext4 / APFS / XFS are all fine.

### UID mismatch on Linux

The container runs as `UID 10001` (non-root). If you bind-mount a pre-populated `./data/` whose files are owned by your host user, the container can't write to them and will fail at startup with `EACCES`. Fix:

```bash
sudo chown -R 10001:10001 ./data
```

On macOS via Docker Desktop, this is usually transparent (the bind-mount layer handles UID translation).

## Backups

The DB is one file: `./data/data.db` (plus `.data/data.db-shm` and `./data/data.db-wal` if you grab the backup while the server is running). Two recipes:

**Online backup** (server stays up):

```bash
docker compose exec rembric sqlite3 /data/data.db ".backup /data/backup-$(date +%Y%m%d).db"
mkdir -p ./backups && mv ./data/backup-*.db ./backups/
```

Uses SQLite's online backup API. Safe against concurrent writes (WAL is checkpointed atomically).

**Cold backup** (a few seconds of downtime):

```bash
docker compose down
cp ./data/data.db   ./backups/data-$(date +%Y%m%d).db
cp ./data/data.db-* ./backups/  2>/dev/null || true
docker compose up -d
```

Always copy the `-shm` and `-wal` siblings — they hold transactions not yet checkpointed into the main file.

## Upgrade & rollback

### Upgrade (rolling, with `:latest`)

```bash
docker compose pull        # fetches the new manifest for :latest
docker compose up -d       # recreates the container with the new image
```

Portainer / Arcane detect the new digest automatically and offer a "Recreate" button — this is the canonical click for the GUI flow. The bind-mounted `./data/` is untouched; migrations are applied at startup.

### Pinning a specific version

Edit `.env`:

```ini
REMBRIC_VERSION=0.13.0
```

`docker compose up -d` now uses that exact tag. Useful when you want to gate upgrades manually or run in production-like reproducibility mode.

### Rollback

Change `REMBRIC_VERSION` in `.env` to the previous tag and recreate:

```bash
docker compose up -d
```

If the new server version included a schema migration that your old data hadn't seen, the rollback is still safe **as long as you didn't manually trigger a migration that's not reversible**. Migrations in Rembric are append-only; existing data isn't transformed by upgrades. Worst case: restore from a backup.

### Watchtower (auto-update)

Not recommended yet. Watchtower would auto-pull `:latest` and recreate the container without your involvement — if a release ships a breaking server↔plugin API change (e.g. the `/healthz` auth hardening in `0.13.0`), Watchtower would update the server while your plugin still runs the old `0.5.x` and break silently. Stick to the manual "click after release" pattern until the project stabilizes.

## `host.docker.internal` and Ollama

If your LLM (Ollama, LM Studio, vLLM) runs on the **host**, the compose file already wires `host.docker.internal:host-gateway` so the container can reach it. Set the endpoint in `.env`:

```ini
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
```

On macOS and Windows (Docker Desktop), `host.docker.internal` is built-in — the `extra_hosts` line is a no-op. On Linux nativo, the `extra_hosts: ["host.docker.internal:host-gateway"]` in compose creates the alias. Both routes work.

If your LLM runs in another container, point at it by service name within the same compose network. If it runs on another host, use the LAN IP or hostname.

## Healthchecks

The container's healthcheck calls `GET /healthz` every 30s with `Authorization: Bearer $REMBRIC_ADMIN_TOKEN`. The endpoint runs a `SELECT 1` against SQLite and returns:

- `200 {ok:true, version:"<x.y.z>"}` on success
- `503 {ok:false, code:"db_unavailable"}` if the DB is closed / locked / IO-errored
- `401` without/with invalid auth

External monitoring (Uptime Kuma, Healthchecks.io, Grafana, etc.) needs to send the same bearer header. Use a project-scoped token if you don't want your admin token in those tools — `/healthz` accepts any valid bearer.

## Troubleshooting

| Symptom                                                            | Cause / Fix                                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull access denied` / `manifest unknown` on `docker compose pull` | The image is private and you're not authenticated. Run `docker login ghcr.io` with a PAT that has `read:packages`.                                                                     |
| `Error: REMBRIC_ADMIN_TOKEN is not set` on startup                 | Add the token to `.env`. The server intentionally refuses to start without it.                                                                                                         |
| Container goes `unhealthy` after upgrade                           | Check `docker compose logs rembric`. If it's `db_unavailable`, the WAL might be locked by a stale process — `docker compose down && docker compose up -d` clears it.                   |
| Hermes provider says memory is unavailable                         | The plugin must be on `0.6.0+` to talk to a Rembric `0.13.0+` server. The `/healthz` endpoint now requires auth; older plugins probe without it and see 401. Upgrade the plugin.       |
| Bind-mount `EACCES` errors in container logs                       | On Linux: `sudo chown -R 10001:10001 ./data`. On macOS Docker Desktop: usually a permission issue with the parent directory; ensure your user owns the parent of `./data/`.            |
| `host.docker.internal: name or service not known` from container   | Linux + Docker < 20.10. Either upgrade Docker, or replace `host.docker.internal` with your host's LAN IP, or switch to `--network=host` (loses the published-port isolation).          |
| Dashboard reachable but the agent can't connect                    | The agent's `REMBRIC_SERVER_URL` doesn't match the host's published port. Verify with `curl -H "Authorization: Bearer $TOKEN" http://<your-url>/healthz` and adjust the plugin config. |
| Memory list shows nothing after upgrade                            | You're looking at a freshly-bind-mounted `./data/` that's empty. The previous data is wherever the old install kept it — check the npm-install path `~/.rembric/` and migrate.         |

## Local dev stack

When you need to hack on Rembric itself — change source, see the result, iterate — the dev stack gives you a parallel container alongside your prod deployment without colliding on data, port, container name, or network.

It's NOT the right tool for the prod operator. For prod, follow the Quickstart at the top of this doc. The dev stack is for **contributors and the author** iterating on the codebase.

### What it gives you

- **Hot-reload via tsx watch.** Edit a file under `apps/server/src/**/*.ts` on the host, and the running Node process inside the container restarts within ~1–2 seconds. No rebuild, no recompile loop. The container itself stays up; only its Node child cycles.
- **Isolated state.** Volume `./data-dev/` (gitignored), container `rembric-dev`, compose project `rembric-dev`, network `rembric-dev_default`, port `127.0.0.1:8788`. Your prod stack (if any) on the same host is untouched.
- **Loopback only.** The dev port binds to `127.0.0.1` to keep half-cooked debug builds off the LAN. Opt into LAN exposure via a personal `docker-compose.override.yml` if you really need it.
- **A populated dashboard out of the box.** The seed script creates a demo project, 3 tokens, ~23 memories across 5 `topic_key` clusters, 3 ended sessions with summaries, 2 active sessions, and 1 pending judgment. Every dashboard surface renders meaningfully on first login.

### Quickstart

```bash
pnpm run dev:docker:up
# one command: builds the dev image, runs build:css + copy-assets + seed --reset,
# starts the server in the foreground with tsx watch.
# Boot chain takes ~25-35s on first run; subsequent runs are faster.
# Logs stream to this terminal. Ctrl-C stops the container.

# In EVERY boot output you'll see (fresh tokens minted on every up):
#   [seed-dev] tokens (plaintext shown exactly once — copy now):
#     admin-dev:    <copy this for dashboard login>
#     demo-reader:  ...
#     demo-writer:  ...

open http://127.0.0.1:8788/dashboard
# log in with the 'admin-dev' token captured above
# iterate on apps/server/src/... — tsx watch reloads in ~2s on save
```

### Every `up` is a fresh canvas

The boot chain runs `seed-dev.ts --reset` unconditionally. Every `up` wipes `./data-dev/` and reseeds with the same baseline counts + three FRESH plaintext tokens. **Rows you create manually through the dashboard or MCP during a session DO NOT survive a Ctrl-C + `up` cycle** — that's the dev contract.

If you want to preserve manual additions between sessions (uncommon), run the seed without `--reset` once and then use `docker compose -f docker-compose.yml -f docker-compose.dev.yml start rembric` (not `up`) to restart without re-running the boot chain:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  exec rembric tsx src/scripts/seed-dev.ts --reset
```

This emits a one-line stderr warning and then deletes from `memory_relations`, `confirmations`, `consolidation_ops`, `consolidation_runs`, `prompts`, `memory`, `sessions`, `tokens`, `projects` (children-first, in one transaction). Triggers clean up `memory_vec` and `memory_fts` automatically.

`--reset` is the only path outside the operator-only purges (`apps/server/src/services/memory.ts::purgeDisconnectedArchived` and `apps/server/src/services/agent-sessions.ts::purgeEmpty`) permitted to `DELETE FROM` the protected tables. The invariant test (`apps/server/src/test/invariants.test.ts`) pins this allow-list and asserts that `apps/server/src/scripts/seed-dev.ts` actually contains the expected `DELETE FROM` strings — so removing the script's seed wouldn't silently expand the allow-list.

### How it avoids colliding with prod

Compose v2 generates container / network names from the project name. The canonical compose hardcodes `container_name: rembric` and uses project `rembric`. The dev compose sets `name: rembric-dev` at the top level and `container_name: rembric-dev`. The two stacks never see each other:

| Resource        | Prod                    | Dev                   |
| --------------- | ----------------------- | --------------------- |
| Container       | `rembric`               | `rembric-dev`         |
| Compose project | `rembric`               | `rembric-dev`         |
| Network         | `rembric_default`       | `rembric-dev_default` |
| Volume          | `./data`                | `./data-dev`          |
| Published port  | `<all interfaces>:8787` | `127.0.0.1:8788`      |

`docker compose ls` shows both as distinct entries; `docker ps` shows both containers. `pnpm run dev:docker:down` only affects the dev stack.

### When NOT to use the dev stack

- **For raw fast iteration on TypeScript**, plain `pnpm run dev` on the host is faster (sub-second tsc rebuilds, no Docker layer). Use Docker dev when you need to validate the packaged image's behavior or you want the seeded dashboard handy.
- **For running unit/integration tests**, use `pnpm test`. Vitest spins up isolated in-memory DBs in <10s. The dev stack is a long-running sandbox, not a test runner.

### Opting into LAN exposure (advanced)

If you want to view the dev dashboard from another machine on your LAN (e.g. for screen-share debugging), drop a `docker-compose.override.yml` next to the canonical files with:

```yaml
services:
  rembric:
    ports: !override
      - '0.0.0.0:8788:8787'
```

Compose auto-merges `docker-compose.override.yml` on every `up`. The bearer token remains the actual security boundary; expose only to networks you trust.
