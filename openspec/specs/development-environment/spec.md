# development-environment Specification

## Purpose

Defines the repo's parallel development stack: a Docker-based dev instance with hot-reload that coexists with a canonical prod instance on the same host, an idempotent seed script that produces a predictable thematic baseline on every boot, a single `pnpm` entry point that brings the stack up with data loaded, and CI gates that protect both Dockerfile stages from regression. The dev stack is isolated from prod by compose project name, container name, host port, and bind-mount directory; every `up` produces a fresh canvas with the same baseline counts (fresh plaintext tokens emitted to stderr per boot) so operators iterate against a known-good state without preserving cruft from previous sessions.

## Requirements

### Requirement: The repo MUST provide a parallel dev stack via `docker-compose.dev.yml` with hot-reload

The repo SHALL ship a `docker-compose.dev.yml` at the root that, when combined with the canonical `docker-compose.yml` via `docker compose -f docker-compose.yml -f docker-compose.dev.yml`, brings up a development-grade instance of the server that does NOT collide with a parallel prod instance on the same host. The dev compose SHALL:

- Declare `name: rembric-dev` (distinct compose project name).
- Override `container_name` to `rembric-dev`.
- Build the image from local source via `build: { context: ., dockerfile: apps/server/Dockerfile, target: dev }` — targeting the dev stage defined in the server's Dockerfile.
- Use a distinct bind-mount: `./data-dev:/data` (not `./data:/data`).
- Bind-mount `./apps/server/src:/app/src` so the container's `tsx watch` sees host-side edits and restarts the Node child sub-second.
- Bind the host port at `127.0.0.1:8788:8787` (loopback-only, distinct from the canonical 8787).
- Set `LOG_LEVEL=debug` and `restart: 'no'` (crash visibility).
- Inherit `env_file: .env` from the canonical compose (no duplicated secrets).

The Dockerfile at `apps/server/Dockerfile` SHALL contain a `dev` stage (in addition to the existing `builder` and `runtime` stages) that keeps the full dev-deps install (NO prune) and sets `ENTRYPOINT ["tsx", "watch"]` with `CMD ["src/cli.ts", "start"]`. The prod `runtime` stage SHALL remain unchanged and SHALL continue to be the implicit final target for canonical `docker build`.

The docker-compose build context SHALL remain the repo root (`.`) so the pnpm workspace lockfile and `pnpm-workspace.yaml` are available to the Docker build. The Dockerfile SHALL copy `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, and each workspace's `package.json` separately before running `pnpm install --frozen-lockfile --filter @rembric/server...` to install only the server's dependency closure.

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
- **WHEN** the operator saves a file under `./apps/server/src/**/*.ts` on the host
- **THEN** `tsx watch` inside the container SHALL detect the change within ~1 second
- **AND** the Node child process SHALL be killed and respawned with the updated source
- **AND** the container itself SHALL NOT restart (the tsx watch parent process stays alive)
- **AND** the healthcheck SHALL recover within the configured `start-period` (20s) without flipping the container to `unhealthy`

### Requirement: The repo MUST provide a dev seed script with `--reset` semantics

The repo SHALL ship a seed script at `apps/server/src/scripts/seed-dev.ts` that populates the dev database with thematic baseline data. The script SHALL:

- Open the database via the same `createDb` helper used by the server's bootstrap, honoring `REMBRIC_DATA_DIR` (which is `/data` inside the dev container).
- On invocation without `--reset`: check whether a project with slug `demo` already exists. If yes, emit a one-line stderr message of the form `[seed-dev] data already present; pass --reset to wipe and reseed` and exit `0` without modifying any rows. If no, proceed with the seed.
- On invocation with `--reset`: gate the destructive path behind the env var `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1`.
  - When `REMBRIC_ALLOW_DESTRUCTIVE_SEED` is unset or any value other than `1`: emit a stderr message of the form `[seed-dev] --reset requires REMBRIC_ALLOW_DESTRUCTIVE_SEED=1; refusing to wipe` and exit with a non-zero code WITHOUT modifying any rows.
  - When `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1`: emit a one-line stderr warning, then `DELETE FROM` the protected tables in dependency order inside a single transaction, then proceed with the seed.
- Insert: exactly 1 project (`demo`), 3 tokens (1 admin scope `*`, 2 project-scoped), approximately 20 memories spread across 5 distinct `topic_key` values, exactly 3 ended sessions with summaries, exactly 2 active sessions, and exactly 1 pending judgment surfaced via a candidate-producing `MemoryService.save` call.
- Emit the plaintext value of all three tokens to stderr exactly once at the end of the run (same pattern as `rembric token create`).
- Be safe to re-run with the same arguments (no-op skip without `--reset`; full wipe + reseed only when `--reset` + env gate are both present).

The dev container's boot chain SHALL always invoke the seed with `--reset` AND SHALL ensure the env var `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` is set in the seed's process environment. This SHALL be accomplished by declaring the env in `docker-compose.dev.yml`'s `environment:` block for the `rembric` service. The canonical prod compose (`docker-compose.yml`) SHALL NOT set this env var.

Operators who want to preserve manually-added rows across container restarts SHALL run the seed manually without `--reset` (or modify the boot chain locally), accepting that the canonical dev contract is fresh-canvas-per-up.

The `apps/server/src/test/invariants.test.ts` source-file allow-list for `DELETE FROM` statements SHALL include `scripts/seed-dev.ts` (relative to `apps/server/src/`), and SHALL retain a positive assertion that this file contains the expected `DELETE FROM` strings (so the allow-list does not silently expire). The invariants test SHALL additionally assert that the `DELETE FROM` block in `seed-dev.ts` is reached only after a runtime check of `process.env.REMBRIC_ALLOW_DESTRUCTIVE_SEED === '1'`.

#### Scenario: Fresh DB seed populates the expected counts

- **GIVEN** an empty dev database (`./data-dev/data.db` does not exist or has no rows)
- **AND** the dev compose sets `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` in the container's environment
- **WHEN** the dev container's boot chain runs `tsx apps/server/src/scripts/seed-dev.ts --reset` (invoked automatically as part of `pnpm run dev:docker:up`)
- **THEN** the script SHALL exit `0`
- **AND** the database SHALL contain exactly 1 project, 3 tokens, ~20 memories across 5 `topic_key` clusters, 3 ended sessions with summaries, 2 active sessions, and 1 pending judgment
- **AND** the container's stderr SHALL contain the plaintext value of the 3 minted tokens

#### Scenario: `--reset` without the env gate refuses to wipe

- **GIVEN** the dev database has been seeded (contains data the operator cares about) OR is empty (doesn't matter for the gate)
- **AND** `REMBRIC_ALLOW_DESTRUCTIVE_SEED` is unset OR set to a value other than `1`
- **WHEN** `tsx apps/server/src/scripts/seed-dev.ts --reset` is invoked (from any context — manual `docker exec`, prod container by accident, a misrouted CI job)
- **THEN** the script SHALL emit `[seed-dev] --reset requires REMBRIC_ALLOW_DESTRUCTIVE_SEED=1; refusing to wipe` to stderr
- **AND** the script SHALL exit with a non-zero code
- **AND** NO rows SHALL be deleted from the protected tables
- **AND** NO new seed rows SHALL be inserted

#### Scenario: Re-running `pnpm run dev:docker:up` wipes and reseeds (canonical boot)

- **GIVEN** the dev database has already been seeded (a project with slug `demo` exists, plus any rows the operator added manually)
- **AND** the dev compose sets `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` in the container's environment
- **WHEN** the operator stops the container (Ctrl-C) and re-runs `pnpm run dev:docker:up`
- **THEN** the boot chain's seed step SHALL emit `[seed-dev] --reset: wiping protected tables before reseeding`
- **AND** the protected tables SHALL be wiped and re-seeded with the same baseline counts as a fresh seed
- **AND** the container's stderr SHALL contain three fresh plaintext tokens (the previous tokens are invalidated by the wipe)

#### Scenario: Running the seed script directly without `--reset` skips

- **GIVEN** the dev database is currently seeded
- **WHEN** the operator runs `docker compose -f docker-compose.yml -f docker-compose.dev.yml exec rembric node apps/server/src/scripts/seed-dev.ts` (no `--reset`)
- **THEN** the script SHALL exit `0`
- **AND** stderr SHALL contain `[seed-dev] data already present; pass --reset to wipe and reseed`
- **AND** the row counts in the database SHALL be unchanged

#### Scenario: Operator runs `--reset` manually inside the dev container

- **GIVEN** the dev database has already been seeded and the dev container is running
- **AND** the dev compose has set `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` for the container
- **WHEN** the operator runs the seed with `--reset` (via `docker compose -f docker-compose.yml -f docker-compose.dev.yml exec rembric tsx apps/server/src/scripts/seed-dev.ts --reset`)
- **THEN** the env var inherited from the container environment SHALL be present
- **AND** the previous rows SHALL be deleted from the protected tables in a single transaction
- **AND** the seed SHALL run to completion producing the same target counts as a fresh seed

### Requirement: The repo MUST expose a single pnpm script that brings up the dev stack with data loaded

The root `package.json::scripts` block SHALL contain one entry for the dev stack:

- `dev:docker:up` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` (foreground — logs stream to the operator's terminal; Ctrl-C stops the container)

The dev container's startup chain — defined in the `apps/server/Dockerfile` `dev` stage's `CMD` — SHALL run the seed automatically before launching `tsx watch`:

```
pnpm run --filter @rembric/server build:css \
  && node apps/server/scripts/copy-assets.mjs \
  && tsx apps/server/src/scripts/seed-dev.ts --reset \
  && exec tsx watch apps/server/src/cli.ts start
```

The boot chain passes `--reset` to the seed unconditionally. For the destructive path to execute, the env var `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` MUST also be present in the seed process's environment. This is supplied by `docker-compose.dev.yml`'s `environment:` block, which SHALL contain `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` for the `rembric` service. The canonical prod compose (`docker-compose.yml`) SHALL NOT contain this env var. If someone were to run the dev image with the prod compose, or vice versa, the env-var gate prevents the seed from wiping data.

Every `up` produces a predictable canvas with the same baseline counts and **fresh plaintext tokens emitted on every boot**. Operators who want to preserve manual additions between `up`s SHALL invoke the seed manually without `--reset` (or fork the Dockerfile dev stage locally).

Foreground `up` is intentional: logs go straight to the operator's terminal, Ctrl-C stops the container, and there's no detached state to forget about.

#### Scenario: Operator runs `pnpm run dev:docker:up` against a fresh data-dev directory

- **GIVEN** `./data-dev/` does not exist or is empty
- **AND** `docker-compose.dev.yml` sets `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` in the rembric service's environment
- **WHEN** the operator runs `pnpm run dev:docker:up`
- **THEN** the dev container SHALL build dashboard assets, run `tsx src/scripts/seed-dev.ts --reset` (the env gate is satisfied; wipe is a no-op on empty tables), and start `tsx watch` in that order
- **AND** the container's stderr SHALL contain the plaintext value of the 3 seeded tokens exactly once per boot
- **AND** the dashboard at `http://127.0.0.1:8788/dashboard` SHALL render populated counters on first login

#### Scenario: Re-running `pnpm run dev:docker:up` produces fresh canvas every time

- **GIVEN** `./data-dev/` was previously seeded
- **AND** the dev compose still provides `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1`
- **WHEN** the operator stops the container (Ctrl-C) and re-runs `pnpm run dev:docker:up`
- **THEN** the boot chain's seed step SHALL wipe the protected tables and reseed with the same baseline counts as a fresh DB
- **AND** three fresh plaintext tokens SHALL be printed to the container's stderr

#### Scenario: Operator brings the dev stack up via the pnpm wrapper

- **WHEN** the operator runs `pnpm run dev:docker:up`
- **THEN** the underlying `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` SHALL execute in the foreground
- **AND** the `rembric-dev` container SHALL transition to `healthy` within the configured healthcheck window
- **AND** Ctrl-C SHALL stop the container cleanly (SIGTERM propagated)

### Requirement: CI MUST verify both Dockerfile stages build cleanly on every change

The repo's CI workflows SHALL include a `docker-build-check` job that triggers on `pull_request` and `push` to `main`. The job SHALL build BOTH the `runtime` and `dev` stages of `apps/server/Dockerfile` (on `linux/amd64` only — multi-arch validation is reserved for release publishes) using `docker/build-push-action@v5` with `push: false` and `context: .`, `file: apps/server/Dockerfile`. Failures SHALL fail the workflow and block merge by default.

In addition, the `docker-publish.yml` workflow SHALL:

- Pass `target: runtime` to the `docker/build-push-action@v5` step explicitly, regardless of Dockerfile stage order. The `context:` SHALL be `.` and `file:` SHALL be `apps/server/Dockerfile`.
- After `docker push` but BEFORE retagging `:latest` (and any version/major aliases), run a smoke-test step that pulls the freshly-pushed immutable `:sha-<short>` tag and inspects its image config. The smoke test SHALL apply **three independent assertions**, ANY of which can fail the workflow:
  - **Cmd/Entrypoint substring check**: fail if `Config.Cmd` or `Config.Entrypoint` contains the substring `seed-dev` or `tsx watch`. Fail if `Config.Entrypoint` is empty AND `Config.Cmd` does NOT include the substring `dist/server-entrypoint.js`.
  - **Image label check**: fail if `Config.Labels."rembric.stage"` is missing OR not equal to the string `runtime`.
  - **Image size check**: pull the image's compressed size from the registry manifest and fail if the total exceeds 600 MB.
- If ANY of the three checks fails, `:latest` and the version aliases SHALL NOT be retagged. The immutable `:sha-<short>` tag remains in the registry as forensic evidence of the failed build.

The `apps/server/Dockerfile` SHALL be structured so that:

- The `runtime` stage is the **last** `FROM ... AS <name>` declaration. This makes `docker build .` (without `--target`) produce the runtime image by default.
- The `runtime` stage SHALL declare `LABEL rembric.stage=runtime`.
- The `dev` stage SHALL declare `LABEL rembric.stage=dev` (purely diagnostic).

This catches Dockerfile-level regressions before they reach a release publish, AND prevents the dev stage from being shipped as the canonical image.

#### Scenario: PR with a broken Dockerfile is caught before merge

- **GIVEN** a PR that introduces a change to `apps/server/Dockerfile` causing the `runtime` stage to fail to build
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job SHALL fail
- **AND** the PR's overall status check SHALL be red

#### Scenario: PR that only modifies docs does not waste CI on a Docker build

- **GIVEN** a PR that modifies only `docs/**/*` or `*.md` files
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job MAY skip (if path filters are configured) or run-and-pass quickly via cache hits

#### Scenario: Publish workflow targets runtime explicitly

- **GIVEN** the release workflow has triggered `docker-publish.yml`
- **WHEN** the `Build and push` step runs
- **THEN** the step SHALL invoke `docker/build-push-action@v5` with `target: runtime`, `context: .`, `file: apps/server/Dockerfile`
- **AND** the produced image's `Config.Cmd` and `Config.Entrypoint` SHALL match the `runtime` stage definition

#### Scenario: Post-publish smoke test catches a dev-stage publish via Cmd substring

- **GIVEN** a faulty Dockerfile change has been merged that shifts the `runtime` stage so the `dev` stage ends up being the last
- **WHEN** `docker-publish.yml` runs the post-publish smoke test against the just-pushed `:sha-<short>` tag
- **THEN** the smoke test SHALL detect `seed-dev` in `Config.Cmd` and fail the workflow
- **AND** `:latest`, `:<version>`, and the major/minor aliases SHALL NOT be retagged

#### Scenario: Image label check catches a wrong-stage publish independently

- **GIVEN** a faulty build where the published image's `Cmd` was rewritten such that the substring check no longer matches, but the image is still built from a stage that lacks `rembric.stage=runtime`
- **WHEN** the smoke test inspects `Config.Labels."rembric.stage"`
- **THEN** the smoke test SHALL fail because the label is missing or has a value other than `runtime`
- **AND** `:latest` SHALL NOT be retagged

#### Scenario: Image size check catches a wrong-stage publish independently

- **GIVEN** a faulty publish that produces a >1 GB image regardless of what `Config.Cmd`/`Labels` say
- **WHEN** the smoke test queries the manifest size
- **THEN** the size SHALL exceed 600 MB
- **AND** the smoke test SHALL fail with a clear "image too large" message naming the actual size

#### Scenario: Dockerfile last stage is runtime (invariant test)

- **WHEN** `apps/server/src/test/invariants.test.ts` runs the "Dockerfile stage order" check
- **THEN** the test SHALL parse `apps/server/Dockerfile`, identify all `FROM ... AS <name>` lines in order, and assert the final entry's name is `runtime`

#### Scenario: Dockerfile declares stage labels (invariant test)

- **WHEN** `apps/server/src/test/invariants.test.ts` runs the "image labels" check
- **THEN** the test SHALL verify the `runtime` stage block contains a line matching `LABEL rembric.stage=runtime`
- **AND** the test SHALL verify the `dev` stage block contains a line matching `LABEL rembric.stage=dev`

### Requirement: The repo MUST pin pnpm via `packageManager` to a version ≥ 10.26 that supports `blockExoticSubdeps`, `minimumReleaseAge`, and the `onlyBuiltDependencies` allowlist

The `package.json::packageManager` field SHALL declare a pnpm version ≥ `10.26.0` (pnpm 10.x or 11.x line) so that all repo install paths — local clones, the CI matrix, both Dockerfile stages, and any downstream tooling that honors corepack — resolve to a pnpm version that natively supports the three supply-chain flags this capability now enforces. The version SHALL be a literal pin (no caret, no tilde) so corepack activates the same binary across every environment. The implementing change pins `pnpm@11.1.2` (the upstream `dist-tags.latest` at the time of merge); future bumps SHALL be reviewed as standalone PRs.

**Node runtime coupling:** pnpm 11 requires Node.js ≥ `22.13`. The repo SHALL declare `package.json::engines.node = ">=22.13"`, AND all three Dockerfile stages (`builder`, `dev`, `runtime`) SHALL use a `node:22-*` base image, AND `.github/workflows/ci.yml`'s `actions/setup-node@v4` step SHALL pin `node-version: '22'`, AND `.devcontainer/devcontainer.json` SHALL use a Node 22 base, AND the repo SHALL ship `.nvmrc` at the root pinning Node `22` (or a specific 22.x) so contributors using `nvm`/`asdf`/`fnm` automatically activate the correct major when entering the repo. Pinning pnpm without bumping every Node install path produces a `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite` at install time because pnpm 11 imports `node:sqlite` which only exists in Node ≥ 22.

`corepack enable` SHALL be the supported pnpm bootstrap method in CI workflows; `pnpm/action-setup@v4` MAY be used as a wrapper but its `version:` input SHALL be either omitted or set to read from `packageManager`, never hard-coded to a literal that could drift from `package.json`.

#### Scenario: A fresh clone resolves the pinned pnpm version

- **GIVEN** a contributor on a workstation with `corepack` enabled but no pnpm globally installed
- **WHEN** they run `pnpm --version` from the repo root
- **THEN** corepack SHALL fetch and activate the version declared in `package.json::packageManager`
- **AND** the resolved version SHALL be ≥ `10.26.0`

#### Scenario: CI install path resolves to the same pinned version

- **GIVEN** a GitHub Actions runner with the `Install pnpm` step configured to use corepack or `pnpm/action-setup@v4` (without a hard-coded `version:`)
- **WHEN** the workflow runs `pnpm --version` before any install step
- **THEN** the resolved version SHALL match `package.json::packageManager`

### Requirement: The repo MUST ship `.npmrc` setting `ignore-scripts=true` and `pnpm-workspace.yaml` declaring an `allowBuilds` map

The repo SHALL contain a root-level `.npmrc` whose contents include `ignore-scripts=true`. This SHALL apply to every `pnpm install` invocation in every context (developer workstation, CI runner, Dockerfile stages — both the dev stage and the runtime stage) and SHALL prevent dependency lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare` when run by a dependency) from executing during installation.

The repo SHALL contain a root-level `pnpm-workspace.yaml` whose contents include an `allowBuilds:` per-package boolean map setting `husky: true`, `better-sqlite3: true`, and `sqlite-vec: true`, with explicit `false` entries for any transitive that pnpm flags during install (initially `esbuild: false`). Husky's `prepare` script registers git hooks; `better-sqlite3` and `sqlite-vec` are native bindings that require postinstall execution to download platform-specific prebuilt binaries. These three are the only third-party lifecycle scripts the repo permits to run; any future dependency that requires a postinstall SHALL be added to `allowBuilds` with `true` explicitly and reviewed in a PR.

The legacy `package.json::pnpm.onlyBuiltDependencies` field (which previously contained `[better-sqlite3, sqlite-vec]` under pnpm 9) SHALL be removed — pnpm 11 reads the allowlist from `pnpm-workspace.yaml::allowBuilds`, so leaving the legacy field would split the source of truth. Note: pnpm 10.x uses a different syntax (`onlyBuiltDependencies:` as a list). Both syntaxes are documented in the skill at `.agents/skills/npm-security-best-practices/references/pnpm-config.md`; the repo SHALL use the pnpm 11 `allowBuilds:` map since `package.json::packageManager` pins pnpm 11.

The Dockerfile's `runtime` stage SHALL retain `--ignore-scripts` on its `pnpm install` line as defense in depth even though the policy is now redundant via `.npmrc`. An inline comment on the install line SHALL reference the `.npmrc` policy so future readers understand the duplication.

#### Scenario: Fresh `pnpm install` runs only the three allowlisted lifecycle scripts

- **GIVEN** a clean clone of the repo with no `node_modules/`
- **WHEN** the contributor runs `pnpm install`
- **THEN** the install SHALL complete successfully
- **AND** only the lifecycle scripts of `husky`, `better-sqlite3`, and `sqlite-vec` SHALL execute
- **AND** `.husky/_/` SHALL be populated (verified by triggering a no-op `git commit` and observing the `pre-commit` hook fire)
- **AND** `better-sqlite3` and `sqlite-vec` native bindings SHALL be present under `node_modules/.pnpm/` (verified by `node -e "require('better-sqlite3')(':memory:')"` exiting 0)

#### Scenario: Adding a dep that wants a postinstall surfaces in code review

- **GIVEN** a contributor opens a PR adding a dependency whose `package.json` declares a `postinstall` script
- **WHEN** another contributor reviews the PR
- **THEN** the new dep SHALL fail to execute its postinstall under the repo's policy
- **AND** the diff SHALL require an accompanying edit to `pnpm-workspace.yaml::allowBuilds` for the script to run
- **AND** that edit SHALL be visible to reviewers as a separate, auditable line in the PR

### Requirement: `pnpm-workspace.yaml` MUST enforce `blockExoticSubdeps: true` and `minimumReleaseAge: 4320`

The repo's `pnpm-workspace.yaml` SHALL set `blockExoticSubdeps: true` so any transitive dependency whose resolved source is a git URL, a tarball URL, or any non-registry origin SHALL cause `pnpm install` to fail with an error identifying the offending dep. This SHALL apply to every install context (workstation, CI, both Dockerfile stages).

The repo's `pnpm-workspace.yaml` SHALL set `minimumReleaseAge: 4320` (minutes — equivalent to 3 days). `pnpm install` SHALL refuse to install any dependency version published within the last 3 days, surfacing the offending version in the error. The 3-day threshold corresponds to the upstream-recommended default in `npm-security-best-practices` practice #3 and approximates the median time-to-detection for compromised npm publishes.

An escape hatch SHALL exist for genuine security-patch overrides: contributors MAY temporarily lower the threshold in `pnpm-workspace.yaml`, OR add the offending package to `minimumReleaseAgeExclude`, and re-tighten in a follow-up PR. The escape hatch SHALL be documented in `CONTRIBUTING.md`.

#### Scenario: Install fails on an exotic transitive source

- **GIVEN** a hypothetical PR introduces a dep `foo@1.0.0` whose `pnpm-lock.yaml` entry points at `git+https://github.com/example/foo.git#abc123`
- **WHEN** CI runs `pnpm install --frozen-lockfile`
- **THEN** pnpm SHALL exit with a non-zero code
- **AND** the error SHALL identify `foo@1.0.0` as the offender and cite `blockExoticSubdeps`

#### Scenario: Install fails on a fresh-publish version

- **GIVEN** a PR bumps a dep to a version published 2 hours ago
- **WHEN** CI runs `pnpm install --frozen-lockfile`
- **THEN** pnpm SHALL exit with a non-zero code citing `minimumReleaseAge`
- **AND** the error SHALL identify the dep + version + the age delta

### Requirement: The repo MUST enforce lockfile integrity through pnpm's native validation chain (integrity hashes + blockExoticSubdeps + frozen-lockfile)

The lockfile-injection attack class (a PR that rewrites lockfile entries to point at attacker-controlled hosts or to bypass checksum validation) SHALL be blocked by three layered pnpm-native defenses, NOT by an external linter. The original plan was to use `lockfile-lint` as a fourth defense, but `lockfile-lint@4.x` does not support `pnpm-lock.yaml` (it only parses npm's `package-lock.json` JSON format and yarn's `yarn.lock`). The three native pnpm defenses cover the same threat model:

- **`pnpm install --frozen-lockfile`** in `.github/workflows/ci.yml` enforces exact lockfile/`package.json` consistency. Any drift (added dep, removed dep, version change) fails the workflow before any tarball is fetched.
- **Integrity hashes** in `pnpm-lock.yaml` are validated against fetched tarball content at install time. Any URL swap that doesn't preserve the original tarball's SHA-512 hash fails the install.
- **`blockExoticSubdeps: true`** in `pnpm-workspace.yaml` refuses transitive deps fetched from git URLs or non-registry tarball URLs, surfacing the offender at install time.

`.github/workflows/ci.yml` SHALL contain an inline comment above the `pnpm install --frozen-lockfile` step explaining the three-defense layering for future readers. The skill `.agents/skills/npm-security-best-practices/SKILL.md` SHALL document `lockfile-lint` under practice #5 as an option for npm-based projects (not pnpm) with a caveat about its pnpm-lock.yaml limitations.

#### Scenario: CI rejects a PR that swaps a tarball URL without changing the integrity hash

- **GIVEN** a PR rewrites a `pnpm-lock.yaml` entry's `resolution.tarball` to `https://attacker.example.com/payload.tgz` but leaves the original `integrity:` hash intact
- **WHEN** `pnpm install --frozen-lockfile` runs in `ci.yml`
- **THEN** pnpm SHALL fetch the URL, compute its SHA-512, observe the mismatch with the lockfile's `integrity:` value, and abort the install with a non-zero exit code
- **AND** the workflow SHALL fail before any further step

#### Scenario: CI rejects a PR that introduces a git-URL transitive dep

- **GIVEN** a PR adds a dep whose `pnpm-lock.yaml` resolution points at `git+https://github.com/example/foo.git`
- **WHEN** `pnpm install --frozen-lockfile` runs in `ci.yml`
- **THEN** `blockExoticSubdeps: true` SHALL cause pnpm to refuse the install with an error identifying the offending dep
- **AND** the workflow SHALL fail before any further step

#### Scenario: CI rejects a PR that desynchronizes the lockfile from `package.json`

- **GIVEN** a PR adds a `dependencies` entry in `package.json` without updating `pnpm-lock.yaml`
- **WHEN** `pnpm install --frozen-lockfile` runs in `ci.yml`
- **THEN** pnpm SHALL exit non-zero with `ERR_PNPM_OUTDATED_LOCKFILE`
- **AND** the workflow SHALL fail before any tarball is fetched

### Requirement: The repo MUST ship a reusable npm-security skill at `.agents/skills/npm-security-best-practices/` with a `.claude/skills/` symlink

The repo SHALL contain `.agents/skills/npm-security-best-practices/` with the following files:

- `SKILL.md` — frontmatter (`name: npm-security-best-practices`, `description:` tuned to fire on dep-addition / install-config / supply-chain review contexts) plus body covering all 17 practices from `https://github.com/lirantal/npm-security-best-practices` in **general** language reusable across any npm-ecosystem project. The body SHALL include concrete commands for npm, pnpm, yarn, and bun where the practice has a package-manager flag. Rembric-specific guidance (the husky allowlist, the 3-day cooldown) SHALL NOT appear in `SKILL.md` itself.
- `references/checklist.md` — one-page summary table of the 17 practices.
- `references/pnpm-config.md` — annotated `.npmrc` and `pnpm-workspace.yaml` snippets with npm/yarn equivalents.
- `references/ci-snippets.md` — copy-pasteable GitHub Actions step examples.
- `references/source.md` — upstream URL, commit SHA snapshot, calendar date of the read, and a reminder to re-read quarterly.

The repo SHALL contain a symlink at `.claude/skills/npm-security-best-practices` pointing to `../../.agents/skills/npm-security-best-practices`, matching the symlink pattern already used for `bun`, `mcp-builder`, `skill-creator`, `plugin-creator`, `plugin-settings`, `plugin-structure`, `rembric-dashboard-ui`, `find-skills`, and `sqlite-database-expert`.

The skill's `description` SHALL trigger on phrases consistent with dep-addition or supply-chain-review intent (e.g., "I want to add express", "review my .npmrc", "should I bump this lockfile?") and SHALL NOT trigger on generic security questions or routine `pnpm install` invocations.

`CONTRIBUTING.md` SHALL contain a section "Adding a dependency" linking to this skill. `CLAUDE.md` SHALL contain a "Supply-chain hygiene" pointer to the skill near the existing "Plugin development discipline" section.

#### Scenario: An agent loads the skill when a contributor proposes adding a dep

- **GIVEN** a contributor opens a chat asking "I want to add `axios` to handle HTTP requests"
- **WHEN** the agent's skill loader scans available skills
- **THEN** `npm-security-best-practices` SHALL be a high-confidence match
- **AND** the agent SHALL surface practice #14 (reduce dep tree — consider `fetch()` instead of axios) and #15 (consult Snyk DB) before recommending the addition

#### Scenario: The skill does NOT load on a generic install command

- **GIVEN** a contributor runs `pnpm install` to refresh `node_modules` after a `git pull`
- **WHEN** the agent's skill loader scans the context
- **THEN** `npm-security-best-practices` SHALL NOT be loaded (no dep-addition signal, no config-edit signal)

### Requirement: The repo MUST ship a `.devcontainer/devcontainer.json` for VSCode / Codespaces isolation

The repo SHALL contain `.devcontainer/devcontainer.json` declaring a containerised development environment that VSCode's Dev Containers extension and GitHub Codespaces consume on "Reopen in Container". The devcontainer SHALL pin the same Node and pnpm versions as the rest of the repo (Node ≥ 22.13 from `package.json::engines`, pnpm from `package.json::packageManager` via corepack), so a contributor opening the repo in a fresh container gets the same toolchain the host stack produces.

The devcontainer SHALL:

- Use the official `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` base (or equivalent published Microsoft image pinned to Node 22) so the underlying OS is a known-good Debian variant rather than an ad-hoc image.
- Run `corepack enable && pnpm install --frozen-lockfile` as a `postCreateCommand` so a freshly-created container is ready to develop against without manual steps. The install SHALL honor the repo's `.npmrc` (`ignore-scripts=true`) and `pnpm-workspace.yaml` (allowlist, exotic-block, cooldown).
- Declare runArgs `--security-opt=no-new-privileges:true` and a non-root `remoteUser: node` to limit the blast radius of a malicious `postinstall` script (defense in depth alongside the `ignore-scripts=true` policy).
- Forward host port `8787` so the dashboard remains reachable at `http://127.0.0.1:8787/dashboard` when the contributor runs `pnpm start` inside the devcontainer.

The devcontainer SHALL coexist with the existing `docker-compose.dev.yml` stack: opening the repo in VSCode → "Reopen in Container" produces a dev environment for the LANGUAGE TOOLCHAIN (typecheck, lint, test) while `pnpm run dev:docker:up` continues to be the canonical way to run a SERVER instance. The two paths SHALL NOT collide on host ports (compose dev binds `127.0.0.1:8788`; the devcontainer forwards `8787`).

#### Scenario: VSCode opens the repo in a devcontainer with the toolchain ready

- **GIVEN** a contributor with VSCode + Dev Containers extension installed
- **WHEN** they open the repo folder and invoke "Dev Containers: Reopen in Container"
- **THEN** VSCode SHALL build the container using `.devcontainer/devcontainer.json`
- **AND** the `postCreateCommand` SHALL run `pnpm install` to completion
- **AND** the contributor SHALL be able to run `pnpm test`, `pnpm run typecheck`, and `pnpm run lint` from the integrated terminal without any further setup
- **AND** the running container SHALL operate as the `node` user (not root), verified by `whoami` returning `node`

### Requirement: The repo MUST declare a pnpm workspaces layout under `apps/` and `packages/`

The repository root SHALL contain a `pnpm-workspace.yaml` that declares a `packages:` block listing exactly two glob entries: `apps/*` and `packages/*`. The existing supply-chain policy entries (`allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge`, `minimumReleaseAgeExclude` where present) SHALL remain in place verbatim — adding the `packages:` block SHALL NOT remove or alter the policy.

The `apps/` directory SHALL contain two workspace members on day one:

- `apps/server/` — the Node MCP+dashboard server (the Docker image target).
- `apps/plugin/` — the multi-client plugin tree (Claude Code, Codex CLI, Hermes Agent, opencode all under one directory).

The `packages/` directory SHALL exist (even if initially empty) so the layout convention is in place for future library extractions (e.g., a future `packages/bridge/` npm-published bridge) without requiring a follow-up restructure.

Each workspace member SHALL contain a `package.json` declaring `"name": "@rembric/<member>"` and `"private": true`. `apps/plugin/package.json` MAY be a minimal stub (name + version + private) because the directory contains assets that are not strictly importable npm modules; the stub exists so `pnpm` recognises the directory as a workspace member and `release-please` can track it.

#### Scenario: pnpm install resolves both workspace members

- **GIVEN** a fresh clone of the repo
- **WHEN** the contributor runs `pnpm install --frozen-lockfile`
- **THEN** pnpm SHALL recognize both `apps/server` and `apps/plugin` as workspace members
- **AND** `pnpm -r ls` SHALL list at minimum `@rembric/server` and `@rembric/plugin`
- **AND** the existing supply-chain policy (allowBuilds, blockExoticSubdeps, minimumReleaseAge) SHALL still apply

#### Scenario: `packages/` is empty but tracked

- **WHEN** a contributor inspects the repo
- **THEN** `packages/` SHALL exist as a directory (with at minimum a `.gitkeep` if no real packages live there yet)
- **AND** `pnpm-workspace.yaml` SHALL declare `packages/*` as a glob even though it currently matches no members
