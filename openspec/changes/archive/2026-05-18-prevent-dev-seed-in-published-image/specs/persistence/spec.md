## ADDED Requirements

### Requirement: The distributed Docker image MUST NOT execute destructive data operations on startup

The image artifact published to `ghcr.io/susomejias/rembric:*` (and any successor registry/repository name) SHALL invoke the runtime server entrypoint (`node /app/dist/server-entrypoint.js`) on container start and SHALL NOT execute any code path that issues `DELETE FROM` against operator-visible tables (`memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, `consolidation_ops`) as part of its boot sequence.

Operator-visible tables MAY be modified by the server's normal startup path (`AgentSessionsService.abandonStale` flips `active` sessions to `abandoned` after a TTL, migration runner inserts into `_migrations`, embedding worker enqueues but does not delete) — these are non-destructive UPDATE/INSERT operations against a small subset of rows and are NOT covered by this prohibition. The prohibition specifically targets `DELETE FROM <table>` and `TRUNCATE` of any row whose loss is not deterministically reconstructible from operator action.

The seed script `src/scripts/seed-dev.ts` exists in the source tree and SHALL be present in the dev-stage Docker image, but SHALL NOT be invoked by the runtime-stage image's `ENTRYPOINT` or `CMD`. Compliance with this requirement is verified by:

1. **Source-tree invariant** (`src/test/invariants.test.ts`): assert that the Dockerfile's last `FROM ... AS <name>` stage is `runtime`, AND that the runtime stage's `ENTRYPOINT` is `["node", "/app/dist/server-entrypoint.js"]`, AND that the runtime stage has no `CMD` (or only an empty `CMD []`).
2. **Publish-time smoke test** (`.github/workflows/docker-publish.yml`): after `docker push`, pull the just-pushed immutable `:sha-<short>` tag and inspect its `Config.Cmd`/`Config.Entrypoint`. Fail the workflow if either contains the substrings `seed-dev` or `tsx watch`. Fail if `Config.Entrypoint` is empty and `Config.Cmd` does not contain `dist/server-entrypoint.js`. The retag of `:latest` (and any version/major aliases) SHALL be gated on this smoke test passing.

This requirement complements the existing append-only contract on the `memory` table by closing a parallel pipeline-level gap: the runtime code is structurally append-only, but the artifact that delivers the runtime code can subvert that contract if built from the wrong source. The two layers together ensure no operator can lose data without explicitly invoking a documented destructive admin action.

#### Scenario: A correctly-published image carries the runtime entrypoint

- **WHEN** a release publishes `ghcr.io/susomejias/rembric:<version>` via `docker-publish.yml`
- **AND** the post-publish smoke test step runs
- **THEN** `docker inspect <image>` SHALL show `Config.Entrypoint` containing `node /app/dist/server-entrypoint.js`
- **AND** `Config.Cmd` SHALL NOT contain `seed-dev` or `tsx watch`
- **AND** the workflow SHALL proceed to retag `:latest` and the version/major aliases

#### Scenario: An image built from the wrong Dockerfile stage is blocked

- **GIVEN** a regression that causes `docker-publish.yml` to produce an image with `CMD ["sh", "-c", "... seed-dev.ts --reset && exec tsx watch ..."]`
- **WHEN** the post-publish smoke test inspects the pushed `:sha-<short>` tag
- **THEN** the smoke test SHALL detect `seed-dev` in `Config.Cmd`
- **AND** the workflow SHALL fail with a non-zero exit code BEFORE retagging `:latest`
- **AND** the `:sha-<short>` immutable tag remains in the registry but is NEVER promoted to `:latest`

#### Scenario: Container start against a populated data dir preserves all rows

- **GIVEN** a properly-published runtime image is pulled and started against a bind-mounted data directory containing 50 memories across 3 projects
- **WHEN** the container starts (including a `--force-recreate` or image-version-bump scenario)
- **THEN** the server SHALL apply any pending migrations (additive only — `ALTER TABLE ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`)
- **AND** the server MAY UPDATE `sessions.status` for stale active sessions (`AgentSessionsService.abandonStale`)
- **AND** the server SHALL NOT issue `DELETE FROM` against `memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, or `consolidation_ops`
- **AND** after startup, the 50 memories and 3 projects SHALL still be present in the same numerical counts as before

#### Scenario: Invariant test enforces the rule at the source layer

- **WHEN** `src/test/invariants.test.ts` runs the "distributed image is non-destructive" assertion
- **THEN** the test SHALL parse the Dockerfile and verify the `runtime` stage is the last `AS <name>` stage
- **AND** verify the `runtime` stage's `ENTRYPOINT` is `["node", "/app/dist/server-entrypoint.js"]`
- **AND** verify the `runtime` stage has no destructive command (no `CMD` referencing `seed-dev` or `tsx watch`)
- **AND** verify `.github/workflows/docker-publish.yml` contains a build-push step with `target: runtime`
- **AND** verify `.github/workflows/docker-publish.yml` contains the post-publish smoke-test step that greps `Config.Cmd`/`Config.Entrypoint` for the forbidden substrings

### Requirement: The server MUST refuse to start when operator-visible tables shrink by ≥ 50% since the last clean shutdown

The server SHALL maintain a state marker file at `${REMBRIC_DATA_DIR}/.rembric-state.json` recording the counts of operator-visible tables as of the last successful startup and the last clean shutdown. On every startup AFTER migrations apply but BEFORE the HTTP listener binds, the server SHALL:

1. Read the state marker if present. If absent, log `[bootstrap] no prior state marker; treating as first boot` to stderr and proceed to step 4 with no comparison.
2. Query current counts for `memory`, `projects`, `sessions`, `tokens`, `prompts` (the operator-visible tables).
3. For each table, compute the ratio `current_count / last_known_count`. If the ratio is below `0.5` for ANY table (and `last_known_count > 0`), flag a "data-loss event".
4. If a data-loss event is flagged AND `process.env.REMBRIC_ALLOW_DATA_SHRINKAGE !== '1'`:
   - Emit a multi-line stderr error containing: the data dir path, both count vectors (last_known vs current), and the offending table name(s).
   - The error SHALL include a recovery hint: "to acknowledge intentional data shrinkage, set REMBRIC_ALLOW_DATA_SHRINKAGE=1 and restart".
   - The server SHALL exit with code `78` (EX_CONFIG) WITHOUT binding the HTTP listener.
5. Write a fresh state marker with current counts and `last_seen_at: Date.now()`.

The server SHALL also write a fresh marker (best-effort) on `SIGTERM`/`SIGINT` clean-shutdown paths so the next boot has a recent comparison baseline. A periodic write every 60s SHALL also occur so an abrupt kill (`SIGKILL`, OOM, host reboot) leaves a recent-enough marker for the next start.

The state marker file SHALL have JSON schema version `1`:

```json
{
  "version": 1,
  "last_seen_at": 1716000000000,
  "counts": {
    "memory": 82,
    "projects": 6,
    "sessions": 59,
    "tokens": 6,
    "prompts": 1
  }
}
```

Future schema versions MAY be introduced with explicit migration logic; an unknown `version` SHALL be treated as "marker absent" (proceed without comparison, log a warning).

The dev compose (`docker-compose.dev.yml`) SHALL set `REMBRIC_ALLOW_DATA_SHRINKAGE=1` because the dev seed legitimately wipes the DB on every `up`. The canonical prod compose SHALL NOT set this env var.

#### Scenario: First boot writes a fresh marker

- **GIVEN** `${REMBRIC_DATA_DIR}/.rembric-state.json` does not exist
- **WHEN** the server starts
- **THEN** the server SHALL log `[bootstrap] no prior state marker; treating as first boot` to stderr
- **AND** after the HTTP listener binds, the server SHALL write `${REMBRIC_DATA_DIR}/.rembric-state.json` with `version: 1`, the current `last_seen_at`, and current counts
- **AND** the server SHALL serve traffic normally

#### Scenario: Subsequent boot with stable counts proceeds normally

- **GIVEN** a marker exists recording `{ memory: 82, projects: 6, ... }`
- **AND** the actual DB still has those counts (or higher)
- **WHEN** the server starts
- **THEN** the comparison SHALL find no table below the 50% threshold
- **AND** the server SHALL proceed without emitting a guard error
- **AND** the marker SHALL be rewritten with current counts

#### Scenario: Mass row loss without the env gate aborts startup

- **GIVEN** a marker exists recording `{ memory: 82, projects: 6, sessions: 59, tokens: 6, prompts: 1 }`
- **AND** the current DB has `{ memory: 0, projects: 0, sessions: 0, tokens: 0, prompts: 0 }` (e.g., because a buggy boot script just wiped it, or the bind mount was replaced)
- **AND** `REMBRIC_ALLOW_DATA_SHRINKAGE` is NOT set to `1`
- **WHEN** the server starts (after migrations apply)
- **THEN** the server SHALL emit a stderr error containing both count vectors and the offending tables
- **AND** the server SHALL exit with code `78` WITHOUT binding the HTTP listener
- **AND** the data marker file SHALL be unchanged (so a retry produces the same diagnostic)

#### Scenario: Mass row loss WITH the env gate proceeds and rewrites the marker

- **GIVEN** the same condition as the previous scenario
- **AND** `REMBRIC_ALLOW_DATA_SHRINKAGE=1` is set in the environment
- **WHEN** the server starts
- **THEN** the server SHALL log a warning `[bootstrap] data-loss guard bypassed via REMBRIC_ALLOW_DATA_SHRINKAGE=1`
- **AND** the server SHALL proceed to serve traffic
- **AND** the marker SHALL be rewritten with the new (lower) counts as the new baseline

#### Scenario: Clean shutdown updates the marker

- **GIVEN** the server is running with current counts `{ memory: 90, projects: 6, ... }`
- **WHEN** the operator sends `SIGTERM` (e.g., `docker compose down`)
- **THEN** the shutdown handler SHALL update the marker file with the latest counts and `last_seen_at: Date.now()`
- **AND** the server SHALL then exit cleanly

#### Scenario: Dev compose tolerates seed wipes

- **GIVEN** the dev compose sets `REMBRIC_ALLOW_DATA_SHRINKAGE=1` and `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1`
- **AND** the previous boot left a marker with seeded counts
- **WHEN** `pnpm run dev:docker:up` re-runs (seed wipes + reseeds)
- **THEN** the data-loss guard SHALL bypass on the new boot (env gate honored)
- **AND** the marker SHALL be rewritten with post-reseed counts (~20 memories, 1 project, 3 tokens, 5 sessions)

### Requirement: The server MUST log a structured startup banner with current row counts

After migrations apply and the data-loss guard passes, but BEFORE binding the HTTP listener, the server SHALL emit a structured stderr banner containing the running version, the data directory path, and the count of every operator-visible table. The banner SHALL use the prefix `[bootstrap]` for every line so operators can grep `docker compose logs rembric | grep bootstrap` to extract the startup summary.

The banner SHALL include at minimum these lines (in this order):

```
[bootstrap] rembric v<x.y.z> ready
[bootstrap] data_dir=<resolved path>
[bootstrap] counts: memory=N projects=M sessions=S tokens=T prompts=P
[bootstrap] listening on <host>:<port>
```

This makes "started with an unexpectedly empty DB" loud and obvious in operator logs, complementing the data-loss guard (which refuses to start on mass loss) by also exposing the *positive* case ("server is up with the expected counts").

#### Scenario: Operator sees row counts on every restart

- **WHEN** the operator runs `docker compose up -d` and then `docker compose logs --tail=20 rembric`
- **THEN** the output SHALL contain a `[bootstrap]` line listing the counts of each operator-visible table
- **AND** the operator can immediately confirm by reading the log whether the restart preserved their data

#### Scenario: Banner appears AFTER the data-loss guard

- **WHEN** the server starts and the data-loss guard refuses to start
- **THEN** the operator SHALL NOT see the `[bootstrap] listening on ...` line because the listener never binds
- **AND** the operator SHALL see the guard's error output instead, making the failure unambiguous
