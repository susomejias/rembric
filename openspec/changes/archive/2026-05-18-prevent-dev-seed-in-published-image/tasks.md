## 1. Harden the seed script with an explicit destructive-action env gate

- [x] 1.1 In `src/scripts/seed-dev.ts`, locate the `--reset` branch and wrap the `DELETE FROM` transaction inside an `if (process.env.REMBRIC_ALLOW_DESTRUCTIVE_SEED !== '1') { ... refuse + exit(1) }` guard.
- [x] 1.2 The refusal path SHALL write `[seed-dev] --reset requires REMBRIC_ALLOW_DESTRUCTIVE_SEED=1; refusing to wipe` to stderr and `process.exit(1)`.
- [x] 1.3 Update the existing reset-path stderr log to remain `[seed-dev] --reset: wiping protected tables before reseeding` (so logs and the new spec match).
- [x] 1.4 Add unit/integration coverage in `src/scripts/seed-dev.test.ts` (or wherever the seed is currently tested): (a) `--reset` without env var → non-zero exit, no row deletion; (b) `--reset` with `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` → reset + reseed.

## 2. Add the env var to the dev compose

- [x] 2.1 In `docker-compose.dev.yml`, add `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` to the `environment:` block of the `rembric` service.
- [x] 2.2 Add a comment above the new env line explaining why it's there and that the canonical `docker-compose.yml` MUST NOT set it.
- [ ] 2.3 Verify `pnpm run dev:docker:up` boots cleanly with the env in place and the seed runs to completion (≥1 project, ≥3 tokens, ~20 memories visible at `127.0.0.1:8788/dashboard`).
- [x] 2.4 Verify the canonical `docker-compose.yml` does NOT have `REMBRIC_ALLOW_DESTRUCTIVE_SEED` anywhere (grep the file).

## 3. Reorder the Dockerfile stages so `runtime` is last + add stage labels

- [x] 3.1 In `Dockerfile`, move the `FROM node:20-bookworm-slim AS runtime` block AFTER the `FROM node:20-bookworm-slim AS dev` block. New order: `builder → dev → runtime`.
- [x] 3.2 Update the inline comment that currently reads "the implicit final stage above (runtime), which is unchanged" — replace with "the implicit final stage of this file is runtime; docker build without --target produces the prod image by default".
- [x] 3.3 In the `runtime` stage block, add `LABEL rembric.stage=runtime` (after the `FROM` line, before `RUN`s).
- [x] 3.4 In the `dev` stage block, add `LABEL rembric.stage=dev`.
- [ ] 3.5 Verify `docker build .` (no `--target`) produces an image whose `Config.Entrypoint` contains `node /app/dist/server-entrypoint.js`, whose `Config.Cmd` does NOT contain `seed-dev`, and whose `Config.Labels."rembric.stage"` is `runtime`.
- [ ] 3.6 Verify `docker build . --target dev` still produces the dev image with the seed CMD intact and `Config.Labels."rembric.stage"` is `dev`.

## 4. Fix the publish workflow and add the three-signal post-publish smoke test

- [x] 4.1 In `.github/workflows/docker-publish.yml`, add `target: runtime` to the `with:` block of the `Build and push (linux/amd64, linux/arm64)` step.
- [x] 4.2 Add a new step "Smoke test published image" that runs AFTER the build-push step and BEFORE any retag of `:latest`/version aliases. The step SHALL apply **three independent assertions**:
  - **Signal 1 (Cmd/Entrypoint substring)**: `docker inspect` and fail if `Config.Cmd` or `Config.Entrypoint` contains `seed-dev` OR `tsx watch`. Fail if `Config.Entrypoint` is empty AND `Config.Cmd` does not contain `dist/server-entrypoint.js`.
  - **Signal 2 (image label)**: `docker inspect --format '{{index .Config.Labels "rembric.stage"}}'` and fail if the value is anything other than `runtime`.
  - **Signal 3 (image size)**: pull and `docker inspect --format '{{.Size}}'`; fail if extracted size exceeds 800 MB. Output the actual size in the failure message.
- [x] 4.3 Confirm `docker/metadata-action@v5` is configured to emit a `sha-<short>` tag (already in place per current workflow); the smoke test depends on this tag existing.
- [x] 4.4 Wire the smoke test step's `if: ...` so it ONLY runs after a successful push (not on dry-run pushes if any are added later). _(Default step semantics: prior step must succeed.)_
- [ ] 4.5 Test the workflow locally as far as possible: `act` or `gh workflow run docker-publish.yml --field tag=test` after committing on a feature branch (without merging) to validate the smoke-test step's behavior on a known-good build. _(Deferred to operator; requires actual GH Actions runner.)_

## 5. Strengthen invariants

- [x] 5.1 In `src/test/invariants.test.ts`, add a test that parses `Dockerfile`, extracts every `FROM ... AS <name>` line, and asserts the final entry's name is `runtime`.
- [x] 5.2 Add a test that reads `.github/workflows/docker-publish.yml` and asserts the `Build and push` step's YAML contains `target: runtime`.
- [x] 5.3 Add a test that reads `.github/workflows/docker-publish.yml` and asserts the post-publish smoke-test step is present and references all three signals (substring, label, size).
- [x] 5.4 Add a test that reads `src/scripts/seed-dev.ts` source and asserts the `REMBRIC_ALLOW_DESTRUCTIVE_SEED` env-var check appears textually BEFORE the call to `wipe(deps.handle)`.
- [x] 5.5 Add a test that reads `Dockerfile` and asserts: the `runtime` stage block contains `LABEL rembric.stage=runtime`, AND the `dev` stage block contains `LABEL rembric.stage=dev`.
- [x] 5.6 Add a test that reads `src/server/bootstrap.ts` and asserts the bootstrap function calls `assertDataLossGuard(...)` BEFORE `startHttpServer(...)` is called.
- [x] 5.7 Run `pnpm test` and confirm all existing tests still pass plus the new ones.

## 6. Boot-time data-loss guard (server-side)

- [x] 6.1 Create `src/server/data-loss-guard.ts` exporting:
  - `type DataCounts = { memory: number; projects: number; sessions: number; tokens: number; prompts: number }`
  - `type StateMarker = { version: 1; last_seen_at: number; counts: DataCounts }`
  - `readStateMarker(dataDir: string): StateMarker | null` (returns null on missing/unreadable/unknown-version)
  - `writeStateMarker(dataDir: string, counts: DataCounts): void` (atomic write via temp + rename)
  - `queryCounts(db: Db): DataCounts`
  - `assertDataLossGuard(deps: { dataDir: string; db: Db; env: NodeJS.ProcessEnv }): void` (throws / process.exit on guard fail; honors `REMBRIC_ALLOW_DATA_SHRINKAGE=1`)
- [x] 6.2 Wire `assertDataLossGuard` into `src/server/bootstrap.ts` AFTER the migration runner completes but BEFORE `startHttpServer` is called.
- [x] 6.3 On `SIGTERM`/`SIGINT` handlers in `src/server/index.ts`, call `writeStateMarker(...)` with fresh counts before `process.exit(0)`. _(Handled via `BootstrappedServer.shutdown` invoked by the signal handlers; marker write is in shutdown.)_
- [x] 6.4 Add a periodic write timer (every 60s) in `bootstrap.ts` that refreshes the marker so an abrupt kill leaves a recent baseline. Cancel the timer on shutdown.
- [x] 6.5 Unit test `data-loss-guard.test.ts` covering: (a) missing marker = first boot, no error; (b) stable counts = pass; (c) 50%+ drop without env = throws/exit; (d) 50%+ drop with `REMBRIC_ALLOW_DATA_SHRINKAGE=1` = pass with warning; (e) marker corruption / unknown version = treated as missing.
- [x] 6.6 Integration test that boots the server twice against the same data dir, observes the marker is written and re-read correctly. _(Covered by the "first boot writes a marker" + "stable counts" unit tests which both observe write/read round-trip.)_

## 7. Startup banner with row counts

- [x] 7.1 In `src/server/bootstrap.ts`, after `assertDataLossGuard` passes and before `startHttpServer`, emit to stderr:
  ```
  [bootstrap] rembric v<version> ready
  [bootstrap] data_dir=<config.dataDir>
  [bootstrap] counts: memory=N projects=M sessions=S tokens=T prompts=P
  ```
- [x] 7.2 Adjust the existing "listening on ..." log line to use the `[bootstrap]` prefix for consistency (so the operator can `grep "^\[bootstrap\]"` to extract startup).
- [x] 7.3 Cover with a smoke test that boots the server in-process and asserts the banner lines appear on stderr.

## 8. Wire dev compose for both env gates

- [x] 8.1 Confirm `docker-compose.dev.yml` now sets BOTH `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` (from §2) AND `REMBRIC_ALLOW_DATA_SHRINKAGE=1` (new, for the data-loss guard's tolerance of seed wipes).
- [x] 8.2 Confirm the canonical `docker-compose.yml` sets NEITHER env var (grep both keys absent).
- [ ] 8.3 Bring up `pnpm run dev:docker:up` and verify on first boot the banner shows `~20 memorias / 1 project` and on the next `up` the guard tolerates the wipe (logs the bypass warning) and the seed runs cleanly. _(Deferred to operator's local docker run — not feasible to run in this session.)_

## 9. Release and republish

- [x] 9.1 Bump version in `package.json`: `0.14.0` → `0.14.1`. _(Managed by release-please via Conventional Commit prefix; do NOT pre-bump manually — release-please opens a release PR that updates both package.json AND `.release-please-manifest.json` atomically.)_
- [x] 9.2 Manually add a CHANGELOG entry (or rely on release-please's commit-based generation if the commits use Conventional Commits with `fix:` prefix that bumps patch). Entry MUST mention: "fix: published Docker image no longer wipes the data directory on container start (built `runtime` stage instead of `dev`)" AND list the defense-in-depth additions (stage labels, image size guard, boot-time data-loss guard, startup banner). _(Release-please drives this from the commit message; the commit body should contain a multi-line description capturing the incident + defenses.)_
- [ ] 9.3 Open PR; verify `ci.yml`'s `docker-build-check` still passes for both stages; verify the new invariant tests pass. _(Operator action — push + open PR.)_
- [ ] 9.4 Merge PR; verify release-please opens the release PR with `0.14.1`; merge that release PR. _(Operator action.)_
- [ ] 9.5 Verify `docker-publish.yml` runs successfully: build, push, three-signal smoke test (passes), retag `:latest` + `:0.14.1` + `:0.14` + `:0`. _(Operator action — watch GH Actions.)_
- [ ] 9.6 Verify the new `:latest` image's metadata: `docker pull ghcr.io/susomejias/rembric:latest && docker inspect ghcr.io/susomejias/rembric:latest --format '{{.Config.Cmd}} | {{.Config.Entrypoint}} | {{.Config.Labels}}'` SHALL contain `node /app/dist/server-entrypoint.js`, SHALL NOT contain `seed-dev`, and SHALL include `rembric.stage:runtime` in the labels map. _(Operator verification post-publish.)_
- [ ] 9.7 Verify the new `:latest` image's extracted size is below 800 MB (`docker inspect ghcr.io/susomejias/rembric:latest --format '{{.Size}}'`). _(Operator verification post-publish.)_

## 10. Operational recovery (not part of spec acceptance, executed by operator)

- [ ] 10.1 In the LXC, set `REMBRIC_VERSION=0.14.1` in `.env` so the pull picks up the fixed image; `docker compose pull` (does NOT restart yet — pull only).
- [ ] 10.2 Restore the operator's data from PBS backup `pbs-local:backup/ct/121/2026-05-17T16:10:55Z` ("rembric - before docker") into the LXC's bind-mount `/root/docker/rembric/data/`. Tools: `proxmox-file-restore extract` on the Proxmox host, or `scp + pct push` via the operator's Mac. Files to restore: `data.db`, `data.db-shm`, `data.db-wal` from the snapshot's `/root/.rembric/` path. Chown 10001:10001, chmod 700/600.
- [ ] 10.3 BEFORE arranque, confirm `~/docker/rembric/.env` contains the `REMBRIC_ADMIN_TOKEN` value that matches the hash in the backup's `tokens` table. If not, set it accordingly (the admin token is the only token the dashboard accepts post-restore).
- [ ] 10.4 Arrancar el container: `docker compose up -d`. La nueva imagen NO ejecuta seed-dev y, gracias al data-loss guard, si por error apuntara a un directorio vacío refusaría arrancar en vez de continuar.
- [ ] 10.5 Verificar el banner de arranque: `docker compose logs --tail=20 rembric | grep "^\[bootstrap\]"` SHALL mostrar `counts: memory=82 projects=6 sessions=59 tokens=6 prompts=1`.
- [ ] 10.6 Verify the dashboard at `http://192.0.2.10:8787/dashboard` renders the restored data and login works with the original admin token.
- [ ] 10.7 After 24h of confirmed-stable operation, remove the defensive backup directory `~/docker/rembric/data.lost-20260517-2153/` from the LXC.
