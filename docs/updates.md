# Updates

Rembric tells you when a new version is out and — if you opt in — updates itself from the dashboard, Arcane-style: backup → pull → container swap → automatic page reload.

## What you get with zero configuration

Nothing to enable. Every deployment that runs `docker compose pull && docker compose up -d` gets:

- An **update badge** next to the version in the dashboard sidebar when a newer release exists.
- A **per-version modal** with the release changelog and a copy-paste update command. "Later" dismisses it until the next release.
- **Automatic reload**: after you run the update command on the host, the open dashboard page detects the new version and reloads itself.

The check calls the GitHub Releases API at most once per 24 hours, fails silently when offline (air-gapped hosts see no errors and no badge), and can be disabled entirely:

```ini
# .env
REMBRIC_UPDATE_CHECK=off
```

## One-click updates (opt-in)

With access to the Docker socket, the **Update** button performs the whole cycle from the dashboard: pre-update database backup, image pull with progress, container swap with health-check and automatic rollback, page reload on the new version.

### Enable it

Uncomment the socket mount in `docker-compose.yml` (or add it via `docker-compose.override.yml`):

```yaml
services:
  rembric:
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    # Required on most Linux hosts (socket is root:docker mode 660):
    group_add:
      - '<docker-gid>' # stat -c '%g' /var/run/docker.sock
```

Then `docker compose up -d` once. The dashboard detects the socket at runtime — no flag, no restart loop.

> [!WARNING]
> **Mounting the Docker socket is root-equivalent on the host.** Anyone who obtains your admin token can then control Docker on the machine, not just your memory data. Only enable this on hosts where you accept that trade, keep the port off the public internet (Tailscale/WireGuard/reverse proxy), and consider the loopback-only override from the README when agent and server share a host.

The container itself keeps running as the unprivileged `rembric` user. If the socket is mounted but not readable by that user, the dashboard degrades to the copy-paste flow and logs a single hint about `group_add` — see [troubleshooting](./troubleshooting.md#dashboard-still-shows-manual-update-with-the-docker-socket-mounted).

### Pinned versions disable one-click

If your `.env` pins `REMBRIC_VERSION=x.y.z`, the compose file declares that exact tag — a self-update would be silently reverted by your next `docker compose up`. Rembric therefore refuses one-click on pinned deployments and the modal explains why. To switch to dashboard-driven updates, remove the pin and run `docker compose up -d` once. To stay pinned, update by bumping the version in `.env`.

### What an update does, in order

1. **Backup** — `VACUUM INTO /data/backups/pre-update-v<target>-<ts>.sqlite`. If this fails (e.g. disk full) the update aborts before any container is touched. The 3 most recent pre-update backups are kept.
2. **Pull** — the new image is downloaded; the running container is untouched until the pull succeeds.
3. **Swap** — a one-shot upgrader container (created from the new image, labeled `rembric.upgrader=1`) stops the old container, renames it aside, recreates it under the original name with identical configuration (ports, volumes, env, labels, restart policy) and the new image, and waits for the health check.
4. **Verify or roll back** — healthy: the old container is removed and your dashboard page reloads on the new version. Unhealthy: the replacement is removed, the old container is renamed back and restarted — you stay on the previous version and the upgrader's logs (`docker logs <upgrader>`) explain what happened.

## Recovery

**Interrupted swap** (host reboot at exactly the wrong moment): if `docker ps -a` shows a stopped `rembric-old-<ts>` and no `rembric`, restore by hand:

```bash
docker rename rembric-old-<ts> rembric
docker start rembric
```

**Rolled back, but the old version won't boot** (the failed release migrated the database forward before dying): the upgrader detects this — after a rollback it waits for the restored container to become healthy and, if it never does, its logs name the exact pre-update snapshot to restore. The rollback deliberately does **not** restore the database automatically: writes may have landed during the failed update's brief life, and silently discarding memories is the one thing Rembric never does — that trade is yours to make. To restore:

```bash
docker stop rembric
cd <your-compose-dir>
rm -f data/data.db-wal data/data.db-shm
cp data/backups/pre-update-v<target>-<ts>.sqlite data/data.db
docker start rembric
```

Anything written between the backup and the restore is lost — that window is the failed update's lifetime, typically under three minutes.

**Bad release** (healthy but misbehaving): pin the previous version in `.env` and `docker compose up -d`. Your data directory is untouched by updates; if you also need the pre-update state of the database, stop the container and copy `data/backups/pre-update-v<target>-<ts>.sqlite` over `data/data.db` (remove `data.db-wal` / `data.db-shm` first).

## Updating across the distroless boundary (one-time, v0.21.14)

Starting with the runtime image shipped in **v0.21.14**, Rembric runs on a **distroless** base: Node lives at `/nodejs/bin/node` and there is **no bare `node` on `PATH`**. Crossing this boundary takes one manual step, because the _old_ server (≤ v0.21.14) drives the upgrade and still calls bare `node`.

**Symptom** — the dashboard one-click update fails with:

```
error during container init: exec: "node": executable file not found in $PATH
```

Your running container is **not** harmed: the swap fails while launching the upgrader, before the live container is touched, so you keep serving the old version. (A manual `docker compose pull && up` with an old compose file instead starts fine but shows the container `unhealthy` — same cause: the old compose health check runs bare `node`.)

**Why** — the image moved to distroless in v0.21.14; the self-update orchestrator and the compose health check in versions **≤ v0.21.14** still invoke bare `node`. Both were fixed in **v0.21.15**, but the fix only takes effect once a fixed version is the _source_ of an update — so the bookworm→distroless hop itself cannot be done from the dashboard. The fix lives in the version you are updating _from_, not the one you are going _to_.

**Fix — do this once to reach ≥ v0.21.15:**

- **Installer / TUI (recommended):** re-run the installer's server update. It re-fetches `docker-compose.yml` (with the corrected `/nodejs/bin/node` health check) and brings the stack up via `docker compose`, bypassing the broken self-update path. Nothing else to touch.

- **Manual** — in your compose directory:

  ```bash
  docker rm $(docker ps -aq --filter name=rembric-upgrader) 2>/dev/null   # clear failed upgraders
  # new image is distroless → point the compose health check at the absolute node path
  sed -i 's#^\(\s*-\s*\)node$#\1/nodejs/bin/node#' docker-compose.yml
  docker compose pull && docker compose up -d
  docker ps --filter name=rembric                                          # expect: Up (healthy)
  ```

**After this** you are on ≥ v0.21.15 and the dashboard one-click update works normally again — the orchestrator launches the upgrader with `/nodejs/bin/node`, and recreated containers use the image's own health check, independent of your local compose file.

## Testing the flow locally

For development, point the release feed at a stub and serve the image from a local registry:

```ini
# .env
REMBRIC_UPDATE_CHECK_URL=http://<stub-host>/releases.json
```

The stub must answer with the GitHub releases JSON shape (`tag_name: server-v<semver>`, `body`, `html_url`, `published_at`). Combined with a `localhost:5000` registry and a `latest` tag, the full one-click cycle can be exercised without touching GHCR or GitHub.
