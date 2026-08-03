# Backup strategy

Rembric's entire state is one SQLite file (+ WAL sidecar) under `$REMBRIC_DATA_DIR` — `/data` in the canonical Docker deployment (bind-mounted to `./data` by `docker-compose.yml`), `~/.rembric/` for a bare-metal run.

The runtime container is [distroless](./docker.md#the-container-has-no-shell): it has no shell and no `sqlite3` binary. Any procedure that shells into the container (`docker compose exec rembric sqlite3 ...`) cannot work against the published image — use one of the two mechanisms below instead.

| Strategy                | RPO           | Setup    | Best for                                         |
| ----------------------- | ------------- | -------- | ------------------------------------------------ |
| Dashboard backup        | minutes-hours | none     | the default — works against the published image  |
| Cold copy (`down`+`cp`) | on demand     | none     | a one-off snapshot, or scripting outside the box |
| litestream              | seconds       | moderate | multi-machine / cloud deployments, lowest RPO    |

> **Append-only is a backup ally.** Rows are never DELETEd and `content` is never overwritten. An older snapshot is missing recent rows, never corrupted or internally inconsistent.

> **Only `memory` (and the other operator tables) hold primary data.** Eight tables are derived and fully regenerable from the append-only rows alone: `memory_fts`, `memory_fts_vocab`, `prompts_fts` and `memory_vec` (search, term-statistics and vector indexes), `memory_replaces` (the reverse-edge table), plus `memory_entities`, `memory_entity_links` and `memory_entity_scan` (the entity index). The authoritative list is `apps/server/src/test/schema-inventory.ts::DERIVED_TABLES`, which the invariants suite asserts against the migrated schema. A backup that carries them is fine; a restore that loses them costs a rebuild, not data. What a restore _can_ get wrong is leaving them pinned to the wrong recipe — see [Restoring a snapshot](#restoring-a-snapshot) step 3.

## Dashboard backup (the default, online, no shell needed)

Open the dashboard → **Maintenance** → **Backup now**. This runs SQLite's online backup API (`VACUUM INTO`) in-process — the same mechanism the self-update flow uses before every upgrade — and writes the snapshot into `$REMBRIC_DATA_DIR/backups/`. Every snapshot in that directory is individually downloadable from the same page, including the mandatory pre-update snapshot self-update takes before an upgrade.

This is a dashboard form, not an API: the route authenticates by dashboard session cookie and CSRF token, so a bearer token gets a redirect to the login page and a cron job built on one acquires zero backups while looking successful. For unattended backups use **litestream** (below) or script the **cold copy** — both work without a session. Clicking it periodically is fine for personal/small deployments; on-demand snapshots keep only the 3 most recent, so nothing grows unbounded if you forget.

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
3. **Delete the two derived-index recipe markers** next to the database:

   ```bash
   rm -f ./data/entity-state.json ./data/embedding-state.json
   ```

   These record which extraction/embedding recipe the derived tables inside the DB were built with. A **missing** marker is the safe direction: the server treats the identity as unknown, wipes the derived index and re-derives it from the restored rows. A **surviving marker that matches** the running build is the hazard — the server concludes the restored index is already current, and because the restored `memory_entity_scan` says every row was scanned, the backfill drain finds nothing to do. The index then stays pinned to whatever recipe built the snapshot, indefinitely and with no error anywhere. Deleting the markers costs one background rebuild; keeping them can cost silently wrong entity lookups.

4. **If the restored file has ≥ 50% fewer rows than the live one in any monitored table**, the data-loss guard refuses to boot. It compares `memory`, `projects`, `sessions`, `tokens` and `prompts` against the counts in `./data/.rembric-state.json` and trips only when a table's previous count was above zero and its new count is below half of it — a smaller-but-similar snapshot boots normally, and so does a restore into an empty deployment. To acknowledge the shrink, uncomment the line in your `.env` and start the server:

   ```dotenv
   REMBRIC_ALLOW_DATA_SHRINKAGE=1
   ```

   It must go in `.env`, not in your shell: the compose service passes `env_file: .env` and declares no `environment:` block, so `REMBRIC_ALLOW_DATA_SHRINKAGE=1 docker compose up -d` is only interpolated into the compose file and never reaches the container — you get the identical refusal. Confirm the server starts and the data looks right, then **comment the line out again**: it is a one-time acknowledgment, not a standing config flag.

5. Start the server: `docker compose up -d`. Migrations apply automatically on boot; the schema version lives in the file itself, so an older snapshot from a prior Rembric version upgrades in place. The derived indexes rebuild in paced background batches — `memory.search`'s dense branch and entity lookups return partial results until the drain finishes, visible as `embeddings.backlog` / `entities.backlog` in `memory.doctor` and on the dashboard maintenance page.

## What NOT to do

- Don't copy `data.db-wal` / `data.db-shm` alone — they're meaningless without `data.db` and will likely corrupt the restore.
- Don't `cp` the live file while the server is running without going through the dashboard backup or `VACUUM INTO` — a raw copy of a file mid-write can capture an inconsistent snapshot. The cold-copy recipe above is safe specifically because the server is stopped first.
- Don't merge backups from two live instances. HA is out of scope for v0.
- Don't rely on backups living on the same volume as the live database for disaster recovery — a lost or corrupted volume takes the snapshots with it. Litestream (or any off-box copy of the downloaded dashboard snapshots) is the mitigation.
