## 1. Dockerfile dev target

- [x] 1.1 Append a new `FROM node:20-bookworm-slim AS dev` stage to the existing `Dockerfile`, after the `runtime` stage. The dev stage SHALL:
  - Install `build-essential python3 ca-certificates` (same as builder, needed for native module compile if pnpm needs to re-resolve).
  - `corepack enable && corepack prepare pnpm@9.12.0 --activate`.
  - `useradd -r -u 10001 -m rembric`.
  - `WORKDIR /app`.
  - Copy `package.json pnpm-lock.yaml`; `pnpm install --frozen-lockfile` (NO `--prod`, NO `--ignore-scripts`, NO subsequent prune — `tsx` and `vitest` and friends remain in node_modules).
  - Copy the rest of the source with `chown rembric:rembric`.
  - `USER rembric`.
  - `ENV PATH="/app/node_modules/.bin:${PATH}" REMBRIC_DATA_DIR=/data REMBRIC_HOST=0.0.0.0 REMBRIC_PORT=8787`.
  - `VOLUME ["/data"]`, `EXPOSE 8787`.
  - `HEALTHCHECK` identical to prod's but with `--start-period=20s` and `--retries=5` to absorb tsx-restart flapping.
  - `ENTRYPOINT ["tsx", "watch"]`, `CMD ["src/cli.ts", "start"]`.
- [x] 1.2 Verify the prod (`runtime`) stage is unchanged: `docker buildx build -t rembric:prod-check .` should produce a binary-identical-or-very-similar layered image vs the current main. Implicit target stays as the last stage; explicit `--target runtime` SHALL work; explicit `--target dev` SHALL produce the new dev image.

## 2. Dev compose override

- [x] 2.1 Create `docker-compose.dev.yml` at the repo root:
  - `name: rembric-dev` (top-level — distinct compose project from the canonical `rembric`).
  - `services.rembric.container_name: rembric-dev`.
  - `services.rembric.build: { context: ., dockerfile: Dockerfile, target: dev }` (uses the new dev stage).
  - `services.rembric.ports: !override - '127.0.0.1:8788:8787'` (loopback-only host bind, distinct host port).
  - `services.rembric.volumes: !override`:
    - `- ./data-dev:/data` (parallel volume, isolated from prod).
    - `- ./src:/app/src` (source bind-mount for hot-reload; tsx watch inside the container reacts to host edits).
  - `services.rembric.environment: { LOG_LEVEL: debug, REMBRIC_PORT: '8787' }` (debug logs + reaffirm internal port).
  - `services.rembric.restart: 'no'` (crash visibility — opposite of prod's `unless-stopped`).
  - Inherits `env_file: .env` from canonical compose (admin token / LLM coords reused, not duplicated).
  - Inline comment at the top of the file pointing operators at `docs/docker.md::Local dev stack`.
- [x] 2.2 Add `data-dev/` line to `.gitignore` (parallel to existing `data/` rule). Confirm `git status` does not show `data-dev/` after a `pnpm run dev:docker:up`.

## 3. Seed script

- [x] 3.1 Create `src/scripts/seed-dev.ts`:
  - CLI: accepts `--reset` (boolean). `process.argv` parsing, no extra dependency.
  - Imports: `createDb` from `../db/index.js`, `ProjectsService`, `TokensService`, `MemoryService`, `AgentSessionsService` from `../services/`.
  - Opens DB via `createDb({ dataDir: process.env.REMBRIC_DATA_DIR ?? '/data' })`. Inside the container, that's `/data` (bind-mounted to `./data-dev`).
  - Idempotent check: `projects.findBySlug('demo')` — if present and `--reset` not passed, log skip message and exit 0.
  - With `--reset`: emit a banner warning, then `DELETE FROM` the relevant tables in dependency order (memory_relations → confirmations → consolidation_ops → memory_vec → memory_fts → memory → prompts → sessions → tokens → projects). Wrap in a single transaction. Use the raw `dbHandle.raw` better-sqlite3 instance — services don't expose `DELETE`.
  - Seed contents (~30-50 rows total):
    - 1 project: `{ slug: 'demo', name: 'Demo Project' }`.
    - 3 tokens: 1 admin (`scope='*'`, name `admin-dev`), 2 project-scoped (`scope=project:<demo.id>`, names `demo-reader` and `demo-writer`). **Print all three plaintext tokens to stderr** — same pattern as `rembric token create`.
    - ~20 memories: 5 `topic_key` clusters (`design-system`, `auth-rotation`, `bug-fix-2026-Q1`, `meeting-decisions`, `runbook-onboarding`), 4 memories per cluster. Vary `type` across `project` / `feedback` / `reference`. Vary `created_at` so a `last_seen_at` sort produces a meaningful order. All scoped to the demo project.
    - 3 ended sessions: each with a `summary` (multi-paragraph realistic content), `title_final = true`, `ended_at` populated. Span 3 different days.
    - 2 active sessions: `started_at` recent (within the last 6h), no `summary`, `status='active'`.
    - 1 pending judgment: save a NEW memory whose content + topic_key overlaps an existing one — `MemoryService.save` returns `candidates[]` with a `judgmentId`. Leave that judgment in `pending` (do NOT call `memory.judge`). The dashboard's `/dashboard/judgments` then shows 1 row to resolve.
  - Print a closing summary: counts of each entity inserted + URLs to log in (`http://127.0.0.1:8788/dashboard`) and to use as `REMBRIC_SERVER_URL` from a test agent.
- [x] 3.2 Co-located test `src/scripts/seed-dev.test.ts`: build a `createTestDb()` fixture, invoke the seed's exported `runSeed({ db, reset: false })` function, assert the expected row counts and that re-running with `reset: false` is a no-op (skip path). Also test `runSeed({ db, reset: true })` against a pre-populated DB.
- [x] 3.3 Refactor: extract the seed body into an exported `runSeed(deps)` function so the test can drive it without `process.exit`. The script's `main()` reads argv, opens the DB, calls `runSeed`, exits.

## 4. Invariants test update

- [x] 4.1 Update `src/test/invariants.test.ts`: extend the `DELETE FROM <table>` allow-list to include `src/scripts/seed-dev.ts` for the tables that the `--reset` flow touches (memory, sessions, tokens, projects, plus the relations/confirmations/consolidation tables). Add a positive-assertion test that confirms `src/scripts/seed-dev.ts` actually contains the `DELETE FROM` strings — so the allow-list doesn't expire silently.
- [x] 4.2 Run `pnpm test -- invariants` to confirm green.

## 5. pnpm scripts

- [x] 5.1 Add a single script to `package.json` under `scripts`:
  - `dev:docker:up` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build` (foreground — logs in your terminal, Ctrl-C to stop).
  - The Dockerfile dev stage's `CMD` already chains `build:css + copy-assets + seed-dev.ts + tsx watch`, so `up` brings up a populated dev stack in one command.
  - Explicit `down` / `logs` / `seed` scripts intentionally omitted — foreground `up` makes `down`/`logs` mostly redundant, and the seed runs inside `up`'s boot chain. The `--reset` escape hatch is `docker compose -f ... -f ... exec rembric tsx src/scripts/seed-dev.ts --reset` (verbose, infrequent).
- [ ] 5.2 Smoke test the script wiring: run each in order (`up` → wait healthy → `seed` → `logs` Ctrl-C → `down`) and confirm no errors.

## 6. CI: Docker build check

- [x] 6.1 Add a `docker-build-check` job to `.github/workflows/ci.yml` (or create a new `.github/workflows/docker-build-check.yml`). The job SHALL:
  - Trigger on `pull_request` and `push` to `main`.
  - Set up `docker/setup-buildx-action@v3` (no QEMU — single-arch native is enough for a build check; the multi-arch validation happens at release publish time).
  - Run `docker/build-push-action@v5` with `push: false`, `target: runtime`, `platforms: linux/amd64`, and `cache-from: type=gha`, `cache-to: type=gha,mode=max`. This catches breakages in the prod stage.
  - Run a second `docker/build-push-action@v5` step with `push: false`, `target: dev`, same caching. This catches breakages in the new dev stage.
  - Job timeout: 15 minutes (single-arch native builds with cache are typically <5 min after warm-up).
- [ ] 6.2 Verify the workflow runs green on the PR for this change (the merge-base of the PR is on main, so the PR build itself is the first run that exercises both stages).

## 7. Documentation

- [x] 7.1 Add a "Local dev stack" section to `docs/docker.md` after the existing operator content. Cover:
  - When to use it vs `pnpm run dev` on host.
  - The four pnpm scripts.
  - What the seed creates and how to log in with the printed admin token.
  - The `--reset` flag (and how to invoke it via `docker compose ... exec rembric node /app/dist/scripts/seed-dev.js --reset` since pnpm scripts can't pass args cleanly through compose exec).
  - Side-by-side with prod: how the dev stack avoids collision (distinct compose project, container name, network, volume, port).
  - Loopback default + how to opt into LAN exposure via an `docker-compose.override.yml` if you really need it.
- [x] 7.2 Add a brief "Local dev stack" pointer to `CLAUDE.md` under the "Commands" table so future agent sessions discover it. Single row: `Dev stack | pnpm run dev:docker:{up,down,logs,seed} (see docs/docker.md::Local dev stack)`.

## 8. Validation

- [x] 8.1 `pnpm run typecheck` green.
- [x] 8.2 `pnpm run lint` green.
- [x] 8.3 `pnpm run format:check` green (or `pnpm run format` to normalize, then re-run check).
- [x] 8.4 `pnpm test` green — 433/433 tests across 39 files (4 new in seed-dev.test.ts + 1 new positive-assertion in invariants.test.ts).
- [x] 8.5 `openspec validate add-dev-stack-tooling --strict` green.
- [x] 8.6 Local Dockerfile sanity: both targets build cleanly. prod=259MB / dev=781MB. Alpine attempted same day and reverted (sqlite-vec has no musl prebuilts — registered in design.md::Decision 10).
- [ ] 8.7 Manual smoke test sequence (operator):
  - `pnpm run dev:docker:up`
  - Wait for `docker compose ps` to show `rembric-dev` as `healthy` (~25-35s — boot chain runs build:css + copy-assets + seed + tsx watch in sequence).
  - The boot output should include the seed summary + 3 plaintext tokens; capture the `admin-dev` token from the log scrollback.
  - Open `http://127.0.0.1:8788/dashboard` in a browser, log in with the admin token.
  - Confirm every dashboard surface renders with data: `/dashboard/projects`, `/dashboard/sessions` (with 3 ended + 2 active), `/dashboard/memories` (with 20), `/dashboard/judgments` (with 1 pending), `/dashboard/tokens` (with 3).
  - Ctrl-C the `up`, re-run `pnpm run dev:docker:up` → confirm boot chain emits `[seed-dev] data already present` (idempotent skip; no fresh tokens).
  - Reset path: `docker compose -f docker-compose.yml -f docker-compose.dev.yml exec rembric tsx src/scripts/seed-dev.ts --reset` against the running stack → confirm wipe + reseed + 3 fresh tokens printed.
  - Confirm prod stack (if running) is unaffected: `docker compose ps` should show both `rembric` (prod) and `rembric-dev` (dev) running, with distinct names and networks.
  - `pnpm run dev:docker:down` → confirm `./data-dev/` persists on disk (down stops, doesn't remove volumes).
- [ ] 8.8 Manual verification: side-by-side run with prod. `docker compose up -d` (prod) AND `pnpm run dev:docker:up` simultaneously. Both healthy. No port/volume/container/network collision. `curl http://127.0.0.1:8787/healthz -H 'Authorization: Bearer <prod-admin>'` → prod responds. `curl http://127.0.0.1:8788/healthz -H 'Authorization: Bearer <dev-admin>'` → dev responds. No cross-talk.
- [ ] 8.9 Manual hot-reload verification: with the dev stack up, `touch src/server/bootstrap.ts`, observe in `pnpm run dev:docker:logs` that tsx detects the change, kills the child, and restarts the server within ~2s. Healthcheck recovers without container restart.

## 9. Post-merge follow-up (not part of this change)

- [ ] 9.1 If perf testing against larger datasets becomes a need, open `add-load-fixture-generator` for a Faker-driven simulation seed.
