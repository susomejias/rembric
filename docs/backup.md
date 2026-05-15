# Backup strategy

Rembric's entire state is one SQLite file (+ WAL sidecar) under `$REMBRIC_DATA_DIR` (default `~/.rembric/`).

| Strategy           | RPO           | Setup    | Best for                          |
| ------------------ | ------------- | -------- | --------------------------------- |
| `sqlite3 .backup`  | minutes-hours | trivial  | single-machine deployments        |
| Periodic snapshots | hours-day     | trivial  | dev / personal use                |
| litestream         | seconds       | moderate | multi-machine / cloud deployments |

> **Append-only is a backup ally.** Rows are never DELETEd and `content` is never overwritten. Older snapshots are missing rows, never corrupted.

## `sqlite3 .backup` + cron

```cron
*/30 * * * * /usr/bin/sqlite3 /home/rembric/.rembric/data.db ".backup '/var/backups/rembric/data.db'"
```

Restore: stop rembric, copy the backup over `$REMBRIC_DATA_DIR/data.db`, restart. Migrations run automatically; the schema version lives in the file itself.

## Periodic snapshots

```bash
sqlite3 ~/.rembric/data.db ".backup '/path/to/snapshots/$(date +%Y-%m-%dT%H).db'"
```

The file is small (typically <50 MB).

## litestream

For deployments where minutes-level data loss is unacceptable. [Litestream](https://litestream.io) tails the SQLite WAL and ships to S3 / GCS / SFTP. See its docs for the YAML; point `dbs[].path` at your `data.db`. Run it alongside rembric under whatever supervisor you use. Recovery: `litestream restore -o $REMBRIC_DATA_DIR/data.db <replica-url>`, then restart.

## What NOT to do

- Don't copy `data.db-wal` / `data.db-shm` alone — they're meaningless without `data.db` and will likely corrupt the restore.
- Don't `cp` the file while rembric is running. Use `sqlite3 .backup` or litestream.
- Don't merge backups from two live instances. HA is out of scope for v0.
