## MODIFIED Requirements

### Requirement: The distributed Docker image MUST NOT execute destructive data operations on startup

The image artifact published to `ghcr.io/susomejias/rembric:*` (and any successor registry/repository name) SHALL invoke the published runtime entrypoint (`node /app/apps/web/server.js`) on container start and SHALL NOT execute any code path that issues `DELETE FROM` against operator-visible tables (`memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, `consolidation_ops`) as part of its boot sequence.

Operator-visible tables MAY be modified by the server's normal startup path (`AgentSessionsService.abandonStale` flips `active` sessions to `abandoned` after a TTL, migration runner inserts into `_migrations`, embedding worker enqueues but does not delete) — these are non-destructive UPDATE/INSERT operations against a small subset of rows and are NOT covered by this prohibition. The prohibition specifically targets `DELETE FROM <table>` and `TRUNCATE` of any row whose loss is not deterministically reconstructible from operator action. Note that operator-invoked purge actions (session purge, archived-memory purge, deleted-prompt purge) issued via `/dashboard/maintenance` are EXEMPT — they are explicit operator intent, not boot-sequence behaviour.

The seed script `apps/server/src/scripts/seed-dev.ts` exists in the source tree and SHALL be present in the dev-stage Docker image, but SHALL NOT be invoked by the runtime-stage image's `ENTRYPOINT` or `CMD`. The published artifact is the `runner` stage of `apps/web/Dockerfile`, which ships no seed script at all — it copies only `apps/web` and `packages/*`, and its traced tree carries `apps/server/package.json` and nothing else from the server app. The entrypoint assertion below is kept as defence in depth: the prohibition is on the boot path, not on which files happen to be present.

Compliance with this requirement is verified by:

1. **Source-tree invariant** (`apps/server/src/test/invariants.test.ts`): assert that `apps/server/Dockerfile`'s last `FROM ... AS <name>` stage is `runtime`, AND that the runtime stage's `ENTRYPOINT` is `["node", "/app/dist/server-entrypoint.js"]`, AND that the runtime stage has no `CMD` (or only an empty `CMD []`). The same test file SHALL assert that `docker-publish.yml` passes `target: runner` with `dockerfile: ./apps/web/Dockerfile` and that its smoke test's expected entrypoint substring is `apps/web/server.js`, so the workflow's expectation and the Dockerfile's `ENTRYPOINT` cannot drift apart unnoticed.
2. **Publish-time smoke test** (`.github/workflows/docker-publish.yml`): after each build job pushes its per-architecture image by digest, the job SHALL pull **that digest** and inspect its `Config.Cmd`/`Config.Entrypoint`. Fail the job if either contains the substrings `seed-dev` or `tsx watch`. Fail the job if `Config.Entrypoint` does not contain `apps/web/server.js` — the entrypoint `apps/web/Dockerfile`'s `runner` stage starts, and therefore the one the published artifact must have. The retag of the immutable `:<version>`/`:sha-<short>` manifest list (and any version/major aliases) SHALL be gated on this smoke test passing on every architecture: the merge job `needs:` both build jobs.

This requirement complements the existing append-only contract on the `memory` table by closing a parallel pipeline-level gap: the runtime code is structurally append-only, but the artifact that delivers the runtime code can subvert that contract if built from the wrong source. The two layers together ensure no operator can lose data without explicitly invoking a documented destructive admin action.

#### Scenario: A correctly-published image carries the web runtime entrypoint

- **WHEN** a release publishes `ghcr.io/susomejias/rembric:<version>` via `docker-publish.yml`
- **AND** the post-publish smoke test step runs
- **THEN** `docker inspect <image>` SHALL show `Config.Entrypoint` containing `node /app/apps/web/server.js`
- **AND** `Config.Cmd` SHALL NOT contain `seed-dev` or `tsx watch`
- **AND** the workflow SHALL proceed to retag `:latest` and the version/major aliases

#### Scenario: An image built from the wrong stage or the wrong app is blocked

- **GIVEN** a regression that causes `docker-publish.yml` to produce an image that does not start the web server — a mutated `CMD ["sh", "-c", "... seed-dev.ts --reset && exec tsx watch ..."]`, or a dropped web override that falls back to `apps/server/Dockerfile`
- **WHEN** the per-arch smoke test inspects the pushed digest
- **THEN** the smoke test SHALL detect `seed-dev` in `Config.Cmd` or the missing `apps/web/server.js` entrypoint
- **AND** the build job SHALL fail with a non-zero exit code BEFORE any tag is created
- **AND** no `:<version>`, `:sha-<short>`, `:latest` or alias tag SHALL be created

#### Scenario: Container start against a populated data dir preserves all rows

- **GIVEN** a properly-published runtime image is pulled and started against a bind-mounted data directory containing 50 memories across 3 projects
- **WHEN** the container starts (including a `--force-recreate` or image-version-bump scenario)
- **THEN** the server SHALL apply any pending migrations (additive only — `ALTER TABLE ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`)
- **AND** the server MAY UPDATE `sessions.status` for stale active sessions (`AgentSessionsService.abandonStale`)
- **AND** the server SHALL NOT issue `DELETE FROM` against `memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, or `consolidation_ops`
- **AND** after startup, the 50 memories and 3 projects SHALL still be present in the same numerical counts as before
