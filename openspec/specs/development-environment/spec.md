# development-environment Specification

## Purpose

Defines the repo's parallel development stack: a Docker-based dev instance with hot-reload that coexists with a canonical prod instance on the same host, an idempotent seed script that produces a predictable thematic baseline on every boot, a single `pnpm` entry point that brings the stack up with data loaded, and CI gates that protect both Dockerfile stages from regression. The dev stack is isolated from prod by compose project name, container name, host port, and bind-mount directory; every `up` produces a fresh canvas with the same baseline counts (fresh plaintext tokens emitted to stderr per boot) so operators iterate against a known-good state without preserving cruft from previous sessions.

## Requirements

### Requirement: The repo MUST provide a parallel dev stack via `docker-compose.dev.yml` with hot-reload

The repo SHALL ship a `docker-compose.dev.yml` at the root that, when combined with the canonical `docker-compose.yml` via `docker compose -f docker-compose.yml -f docker-compose.dev.yml`, brings up a development-grade instance of the server that does NOT collide with a parallel prod instance on the same host. The dev compose SHALL:

- Declare `name: rembric-dev` (distinct compose project name).
- Override `container_name` to `rembric-dev`.
- Build the image from local source via `build: { context: ., dockerfile: Dockerfile, target: dev }` — targeting the dev stage defined in the Dockerfile.
- Use a distinct bind-mount: `./data-dev:/data` (not `./data:/data`).
- Bind-mount `./src:/app/src` so the container's `tsx watch` sees host-side edits and restarts the Node child sub-second.
- Bind the host port at `127.0.0.1:8788:8787` (loopback-only, distinct from the canonical 8787).
- Set `LOG_LEVEL=debug` and `restart: 'no'` (crash visibility).
- Inherit `env_file: .env` from the canonical compose (no duplicated secrets).

The Dockerfile SHALL contain a `dev` stage (in addition to the existing `builder` and `runtime` stages) that keeps the full dev-deps install (NO prune) and sets `ENTRYPOINT ["tsx", "watch"]` with `CMD ["src/cli.ts", "start"]`. The prod `runtime` stage SHALL remain unchanged and SHALL continue to be the implicit final target for canonical `docker build`.

#### Scenario: Dev and prod stacks coexist on the same host

- **GIVEN** the canonical stack is running via `docker compose up -d` (container `rembric`, volume `./data/`, port `:8787` on all interfaces)
- **WHEN** the operator runs `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`
- **THEN** a second container named `rembric-dev` starts on `127.0.0.1:8788`
- **AND** the second container uses `./data-dev/` exclusively, never reading or writing to `./data/`
- **AND** both containers are visible in `docker compose ls` as distinct projects (`rembric` and `rembric-dev`)

#### Scenario: Dev stack is loopback-only by default

- **WHEN** the operator brings up the dev stack on a host accessible from the LAN
- **THEN** the port `:8788` SHALL respond only to requests originating from `127.0.0.1` on that host
- **AND** requests from other LAN hosts SHALL be unable to reach `:8788`

#### Scenario: Editing source triggers hot-reload

- **GIVEN** the dev stack is running (container `rembric-dev` in `healthy` state)
- **WHEN** the operator saves a file under `./src/**/*.ts` on the host
- **THEN** `tsx watch` inside the container SHALL detect the change within ~1 second
- **AND** the Node child process SHALL be killed and respawned with the updated source
- **AND** the container itself SHALL NOT restart (the tsx watch parent process stays alive)
- **AND** the healthcheck SHALL recover within the configured `start-period` (20s) without flipping the container to `unhealthy`

### Requirement: The repo MUST provide a dev seed script with `--reset` semantics

The repo SHALL ship a TypeScript seed script at `src/scripts/seed-dev.ts` that populates the dev database with thematic baseline data. The script SHALL:

- Open the database via the same `createDb` helper used by the server's bootstrap, honoring `REMBRIC_DATA_DIR` (which is `/data` inside the dev container).
- On invocation without `--reset`: check whether a project with slug `demo` already exists. If yes, emit a one-line stderr message of the form `[seed-dev] data already present; pass --reset to wipe and reseed` and exit `0` without modifying any rows. If no, proceed with the seed.
- On invocation with `--reset`: emit a one-line stderr warning, then `DELETE FROM` the protected tables in dependency order inside a single transaction, then proceed with the seed.
- Insert: exactly 1 project (`demo`), 3 tokens (1 admin scope `*`, 2 project-scoped), approximately 20 memories spread across 5 distinct `topic_key` values, exactly 3 ended sessions with summaries, exactly 2 active sessions, and exactly 1 pending judgment surfaced via a candidate-producing `MemoryService.save` call.
- Emit the plaintext value of all three tokens to stderr exactly once at the end of the run (same pattern as `rembric token create`).
- Be safe to re-run with the same arguments (no-op skip without `--reset`; full wipe + reseed with `--reset`).

The dev container's boot chain SHALL always invoke the seed with `--reset`, giving the operator a predictable, identical starting state on every `pnpm run dev:docker:up`. Operators who want to preserve manually-added rows across container restarts SHALL run the seed manually without `--reset` (or modify the boot chain locally), accepting that the canonical contract is fresh-canvas-per-up.

The `src/test/invariants.test.ts` source-file allow-list for `DELETE FROM` statements SHALL be extended to include `src/scripts/seed-dev.ts`, and SHALL retain a positive assertion that this file contains the expected `DELETE FROM` strings (so the allow-list does not silently expire).

#### Scenario: Fresh DB seed populates the expected counts

- **GIVEN** an empty dev database (`./data-dev/data.db` does not exist or has no rows)
- **WHEN** the dev container's boot chain runs `tsx src/scripts/seed-dev.ts` (invoked automatically as part of `pnpm run dev:docker:up`)
- **THEN** the script SHALL exit `0`
- **AND** the database SHALL contain exactly 1 project, 3 tokens, ~20 memories across 5 `topic_key` clusters, 3 ended sessions with summaries, 2 active sessions, and 1 pending judgment
- **AND** the container's stderr SHALL contain the plaintext value of the 3 minted tokens

#### Scenario: Re-running `pnpm run dev:docker:up` wipes and reseeds (canonical boot)

- **GIVEN** the dev database has already been seeded (a project with slug `demo` exists, plus any rows the operator added manually)
- **WHEN** the operator stops the container (Ctrl-C) and re-runs `pnpm run dev:docker:up`
- **THEN** the boot chain's seed step SHALL emit `[seed-dev] --reset: wiping protected tables before reseeding`
- **AND** the protected tables SHALL be wiped and re-seeded with the same baseline counts as a fresh seed
- **AND** the container's stderr SHALL contain three fresh plaintext tokens (the previous tokens are invalidated by the wipe)

#### Scenario: Running the seed script directly without `--reset` skips

- **GIVEN** the dev database is currently seeded
- **WHEN** the operator runs `docker compose -f docker-compose.yml -f docker-compose.dev.yml exec rembric tsx src/scripts/seed-dev.ts` (no `--reset`)
- **THEN** the script SHALL exit `0`
- **AND** stderr SHALL contain `[seed-dev] data already present; pass --reset to wipe and reseed`
- **AND** the row counts in the database SHALL be unchanged

#### Scenario: `--reset` wipes and reseeds

- **GIVEN** the dev database has already been seeded and the dev container is running
- **WHEN** the operator runs the seed with `--reset` (via `docker compose -f docker-compose.yml -f docker-compose.dev.yml exec rembric tsx src/scripts/seed-dev.ts --reset`)
- **THEN** the previous rows SHALL be deleted from the protected tables in a single transaction
- **AND** the seed SHALL run to completion producing the same target counts as a fresh seed

### Requirement: The repo MUST expose a single pnpm script that brings up the dev stack with data loaded

The `package.json::scripts` block SHALL contain one entry for the dev stack:

- `dev:docker:up` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` (foreground — logs stream to the operator's terminal; Ctrl-C stops the container)

The dev container's startup chain — defined in the Dockerfile `dev` stage's `CMD` — SHALL run the seed automatically before launching `tsx watch`:

```
pnpm run build:css \
  && node scripts/copy-assets.mjs \
  && tsx src/scripts/seed-dev.ts \
  && exec tsx watch src/cli.ts start
```

The boot chain passes `--reset` to the seed unconditionally, so every `up` produces a predictable canvas with the same baseline counts and **fresh plaintext tokens emitted on every boot**. Operators who want to preserve manual additions between `up`s SHALL invoke the seed manually without `--reset` (or fork the Dockerfile dev stage locally).

Foreground `up` is intentional: logs go straight to the operator's terminal, Ctrl-C stops the container, and there's no detached state to forget about.

#### Scenario: Operator runs `pnpm run dev:docker:up` against a fresh data-dev directory

- **GIVEN** `./data-dev/` does not exist or is empty
- **WHEN** the operator runs `pnpm run dev:docker:up`
- **THEN** the dev container SHALL build `dist/dashboard/public/...`, run `seed-dev.ts --reset` (wipe-then-seed; the wipe is a no-op on empty tables), and start `tsx watch` in that order
- **AND** the container's stderr SHALL contain the plaintext value of the 3 seeded tokens exactly once per boot
- **AND** the dashboard at `http://127.0.0.1:8788/dashboard` SHALL render populated counters on first login (≥1 project, ≥3 tokens, ≥20 memories, ≥3 ended sessions, ≥2 active sessions, ≥1 pending judgment)

#### Scenario: Re-running `pnpm run dev:docker:up` produces fresh canvas every time

- **GIVEN** `./data-dev/` was previously seeded (a `demo` project exists, plus any rows the operator added manually)
- **WHEN** the operator stops the container (Ctrl-C) and re-runs `pnpm run dev:docker:up`
- **THEN** the boot chain's seed step SHALL wipe the protected tables and reseed with the same baseline counts as a fresh DB
- **AND** the operator's manual additions SHALL be lost (canonical contract)
- **AND** three fresh plaintext tokens SHALL be printed to the container's stderr (previous tokens are invalidated)

#### Scenario: Operator brings the dev stack up via the pnpm wrapper

- **WHEN** the operator runs `pnpm run dev:docker:up`
- **THEN** the underlying `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` SHALL execute in the foreground
- **AND** the `rembric-dev` container SHALL transition to `healthy` within the configured healthcheck window
- **AND** Ctrl-C SHALL stop the container cleanly (SIGTERM propagated)

### Requirement: CI MUST verify both Dockerfile stages build cleanly on every change

The repo's CI workflows SHALL include a `docker-build-check` job that triggers on `pull_request` and `push` to `main`. The job SHALL build BOTH the `runtime` and `dev` Dockerfile stages (on `linux/amd64` only — multi-arch validation is reserved for release publishes) using `docker/build-push-action@v5` with `push: false`. Failures SHALL fail the workflow and block merge by default.

This catches Dockerfile-level regressions (broken `COPY` paths, missing dependencies, native-module compile failures, dev-deps drift) before they reach a release publish.

#### Scenario: PR with a broken Dockerfile is caught before merge

- **GIVEN** a PR that introduces a `Dockerfile` change that causes the `runtime` stage to fail to build
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job SHALL fail
- **AND** the PR's overall status check SHALL be red

#### Scenario: PR that only modifies docs does not waste CI on a Docker build

- **GIVEN** a PR that modifies only `docs/**/*` or `*.md` files
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job MAY skip (if path filters are configured) or run-and-pass quickly via cache hits
