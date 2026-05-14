# Backup strategy

Rembric's entire state is a single SQLite file (plus its WAL sidecar) under `$REMBRIC_DATA_DIR` (default `~/.rembric/`). Three strategies are supported, from least to most operationally complex.

## TL;DR

| Strategy           | Recovery point | Recovery time | Setup cost | Best for                          |
| ------------------ | -------------- | ------------- | ---------- | --------------------------------- |
| `rsync` + cron     | minutes-hours  | seconds       | trivial    | single-machine deployments        |
| Periodic snapshots | hours-day      | seconds       | trivial    | dev / personal use                |
| litestream         | seconds        | seconds-mins  | moderate   | multi-machine / cloud deployments |

> **Append-only is a backup ally.** Because rembric never DELETEs from `memory` and never overwrites `content`, even partial backups are useful: an older snapshot is missing rows, never corrupted by overwrites. The same property holds for `memory_relations` (the judgment graph) and the `sessions` table — both are append-only with status FSMs.

---

## 1. `rsync` + cron (recommended for single-machine)

Add a cron entry that copies the data dir to a separate disk or remote host. Always stop the server (or use `.backup` checkpoint) before copying — copying a live WAL-mode SQLite file is safe **only** with the `.backup` API.

```cron
# Every 30 minutes, snapshot to /var/backups/rembric/
*/30 * * * * /usr/bin/sqlite3 /home/rembric/.rembric/data.db ".backup '/var/backups/rembric/data.db'"
```

Restore: stop rembric, copy the backup over `$REMBRIC_DATA_DIR/data.db`, restart. Migrations run automatically on startup; the schema version is recorded in the file itself.

## 2. Periodic snapshots

The simplest possible setup:

```bash
sqlite3 ~/.rembric/data.db ".backup '/path/to/snapshots/$(date +%Y-%m-%dT%H).db'"
```

Run from a daily cron. Keep snapshots for whatever retention window suits you — the file is small (typically <50 MB even with thousands of memories).

## 3. litestream (streaming replication)

For deployments where minutes-level data loss is unacceptable. [Litestream](https://litestream.io) reads the SQLite WAL continuously and ships it to S3 / GCS / SFTP.

Minimal `litestream.yml`:

```yaml
dbs:
  - path: /home/rembric/.rembric/data.db
    replicas:
      - type: s3
        bucket: my-rembric-backup
        path: rembric/
        region: us-east-1
        access-key-id: AKIA...
        secret-access-key: ...
```

Run litestream alongside rembric (a systemd unit pair is the simplest setup; see `examples/systemd/`). Recovery:

```bash
litestream restore -o /home/rembric/.rembric/data.db s3://my-rembric-backup/rembric/
```

Then restart rembric. Migrations are idempotent; the restored DB is immediately usable.

---

## What NOT to do

- **Don't copy `data.db-wal` and `data.db-shm` by themselves.** They're meaningless without the matching `data.db` and you'll likely end up with a corrupt restore.
- **Don't copy the file while rembric is running** unless you use `sqlite3 .backup` or litestream. A naive `cp data.db backup.db` can capture a partially-flushed WAL state.
- **Don't try to merge backups from two live rembric instances.** The append-only model means you can union the row sets in principle, but you'll need a custom dedup pass on `id` and you'll lose the consolidation journal. If you need multi-host writes, file an issue; HA is out of scope for v0.
