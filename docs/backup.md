# Backup strategy

Rembric's entire state is one SQLite file (+ WAL sidecar) under `$REMBRIC_DATA_DIR` — `/data` in the canonical Docker deployment (bind-mounted to `./data` by `docker-compose.yml`), `~/.rembric/` for a bare-metal run.

The runtime container is [distroless](./docker.md#the-container-has-no-shell): it has no shell and no `sqlite3` binary. Any procedure that shells into the container (`docker compose exec rembric sqlite3 ...`) cannot work against the published image — use one of the two mechanisms below instead.

| Strategy                | RPO           | Setup    | Best for                                         |
| ----------------------- | ------------- | -------- | ------------------------------------------------ |
| Dashboard backup        | minutes-hours | none     | the default — works against the published image  |
| Cold copy (`down`+`cp`) | on demand     | none     | a one-off snapshot, or scripting outside the box |
| litestream              | seconds       | moderate | multi-machine / cloud deployments, lowest RPO    |

> **Append-only is a backup ally.** Rows are never DELETEd and `content` is never overwritten. An older snapshot is missing recent rows, never corrupted or internally inconsistent.

## Dashboard backup (the default, online, no shell needed)

Open the dashboard → **Maintenance** → **Backup now**. This runs SQLite's online backup API (`VACUUM INTO`) in-process — the same mechanism the self-update flow uses before every upgrade — and writes the snapshot into `$REMBRIC_DATA_DIR/backups/`. Every snapshot in that directory is individually downloadable from the same page, including the mandatory pre-update snapshot self-update takes before an upgrade.

Automate it by hitting the same form endpoint from cron with a valid admin bearer token (the dashboard session cookie, or scripted form POST with CSRF — see `apps/server/src/dashboard/maintenance.ts` for the exact routes), or simply click it periodically for personal/small deployments; on-demand snapshots keep only the 3 most recent, so unattended cron isn't required to avoid unbounded growth.

## Cold copy (works against any image, a few seconds of downtime)

```bash
docker compose down
cp ./data/data.db     ./backups/data-$(date +%Y%m%d).db
cp ./data/data.db-*   ./backups/  2>/dev/null || true   # -wal / -shm siblings, if present
docker compose up -d
```

Always copy the `-wal` / `-shm` siblings if they exist — they hold transactions not yet checkpointed into the main file.

## litestream (lowest RPO, multi-machine)

For deployments where minutes-level data loss is unacceptable. [Litestream](https://litestream.io) tails the SQLite WAL and ships to S3 / GCS / SFTP continuously. Point `dbs[].path` at `$REMBRIC_DATA_DIR/data.db` (the bind-mounted `./data/data.db` on the host, or run litestream as a sidecar container sharing the same volume) and run it under whatever supervisor you use. Recovery: `litestream restore -o $REMBRIC_DATA_DIR/data.db <replica-url>`, then follow the restore steps below before starting Rembric.

## Restoring a snapshot

1. Stop the server: `docker compose down` (or however you run it).
2. Replace the live file: `cp /path/to/snapshot.sqlite ./data/data.db` (remove any stale `./data/data.db-wal` / `./data/data.db-shm` first — they must not survive from the pre-restore state).
3. **If the snapshot is older/smaller than the current file**, the data-loss guard refuses to boot: it compares row counts recorded in a state marker against the file you just restored, and a shrink looks indistinguishable from an operator overwriting the DB with stale data by mistake. The boot error names the fix:

   ```
   REMBRIC_ALLOW_DATA_SHRINKAGE=1
   ```

   Set that environment variable for the restore boot (e.g. `REMBRIC_ALLOW_DATA_SHRINKAGE=1 docker compose up -d`), confirm the server starts and the data looks right, then **remove the variable again** — it is an explicit one-time acknowledgment, not a standing config flag. Restoring a snapshot that is newer than or equal to the live file's row counts does not trip the guard at all.

4. Start the server: `docker compose up -d`. Migrations apply automatically on boot; the schema version lives in the file itself, so an older snapshot from a prior Rembric version upgrades in place.

## What NOT to do

- Don't copy `data.db-wal` / `data.db-shm` alone — they're meaningless without `data.db` and will likely corrupt the restore.
- Don't `cp` the live file while the server is running without going through the dashboard backup or `VACUUM INTO` — a raw copy of a file mid-write can capture an inconsistent snapshot. The cold-copy recipe above is safe specifically because the server is stopped first.
- Don't merge backups from two live instances. HA is out of scope for v0.
- Don't rely on backups living on the same volume as the live database for disaster recovery — a lost or corrupted volume takes the snapshots with it. Litestream (or any off-box copy of the downloaded dashboard snapshots) is the mitigation.
