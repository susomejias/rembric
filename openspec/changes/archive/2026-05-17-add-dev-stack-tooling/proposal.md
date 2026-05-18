## Why

Iterating on Rembric today forces a choice between two non-ideal paths:

1. **`pnpm run dev` on the host.** Fast feedback loop, but the running instance shares filesystem with whatever else uses `~/.rembric/data.db`. No isolation from a parallel npm-installed Rembric or from manually-juggled `REMBRIC_DATA_DIR` values.
2. **`docker compose up` against the canonical compose.** Clean isolation but the SAME `./data/` and the SAME `:8787` port as a parallel prod deployment on the same host. Run both, they collide.

Neither path gives the author (or any future contributor) a sandbox where the dashboard has interesting data to look at without doing manual setup every time. Consequence: most exploration happens against an empty DB, missing the dashboard surfaces that only exist once there are sessions, judgments, supersession chains, etc.

This change introduces a parallel "dev stack" — an override of the canonical compose that:

- Builds the image from a new `dev` Dockerfile target that keeps dev deps (`tsx`) in the image instead of pruning them.
- **Runs the server via `tsx watch src/cli.ts start`** so saved edits to `src/**/*.ts` trigger a sub-second process restart — no rebuild loop, no host-side toolchain.
- Bind-mounts `./src` into the container so file events propagate from the host editor to tsx inside the container.
- Uses an isolated `./data-dev/` bind-mount and a distinct container/network name (`rembric-dev`), leaving prod data and naming alone.
- Binds `127.0.0.1:8788` so prod (8787) and dev (8788) coexist on the same host without LAN exposure for the half-cooked dev build.
- Ships a thematic seed script (`src/scripts/seed-dev.ts`) that populates ~30-50 realistic rows — a demo project, 3 tokens, ~20 memories grouped by `topic_key`, sessions with summaries, one pending judgment — so the dashboard renders meaningfully on first boot. In the dev image the seed runs via `tsx` directly against the bind-mounted source; no compile step needed.
- Wraps the multi-`-f` compose invocations in 4 pnpm scripts so neither the operator nor a future agent has to remember the boilerplate.

This is **tooling-only**: no behavioral changes, no spec deltas. The seed script writes through the existing service layer; the dev compose is an override that doesn't touch the prod compose. The four load-bearing invariants (append-only memory, scope enforcement, convergent `topic_key`, fresh-context judgment) are unchanged.

## What Changes

- **DOCKERFILE DEV TARGET** Add a new `dev` stage to the existing `Dockerfile` (multi-stage). The `dev` stage starts from the same `node:20-bookworm-slim` base, installs the build-essential toolchain, runs `pnpm install --frozen-lockfile` (NO prune — `tsx` and other dev deps stay), copies the source tree, sets `PATH="/app/node_modules/.bin:${PATH}"`, and ships an `ENTRYPOINT ["tsx", "watch"]` with `CMD ["src/cli.ts", "start"]`. The prod (`runtime`) target is unchanged; canonical builds keep pulling from it.
- **DEV COMPOSE** Add `docker-compose.dev.yml` at the repo root. Sets `name: rembric-dev` (distinct compose project), `container_name: rembric-dev`, `build: { context: ., dockerfile: Dockerfile, target: dev }` (uses the new dev stage), `ports: !override - '127.0.0.1:8788:8787'` (loopback-only, distinct host port), `volumes: !override - ./data-dev:/data, - ./src:/app/src` (parallel volume + source bind-mount for hot-reload), `environment: LOG_LEVEL: debug`, and `restart: 'no'` (crash visibility is the point). Inherits `env_file: .env` from the canonical compose so admin token / LLM coords don't duplicate.
- **SEED SCRIPT** Add `src/scripts/seed-dev.ts`. Compiles to `dist/scripts/seed-dev.js` via the existing `tsc -p tsconfig.build.json` (rootDir already covers `src/`, no tsconfig change required). The script:
  1. Opens the DB via the same `createDb` helper used by bootstrap.
  2. Checks if the DB already has a `demo` project — if yes, exits with a skip message (idempotent).
  3. With `--reset` flag, drops everything from the relevant tables first.
  4. Creates: 1 admin token + 1 project (`demo`) + 2 project-scoped tokens, ~20 memories across 5 `topic_key` clusters, 3 ended sessions with summaries, 2 active sessions, 1 pending judgment (created by saving a second memory whose content overlaps an existing one in the same `topic_key`, surfacing a candidate via `MemoryService.save`).
- **PNPM SCRIPTS** Add four scripts to `package.json`:
  - `dev:docker:up` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`
  - `dev:docker:down` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml down`
  - `dev:docker:logs` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f rembric`
  - `dev:docker:seed` → `docker compose -f docker-compose.yml -f docker-compose.dev.yml exec rembric tsx src/scripts/seed-dev.ts` (the dev image has tsx + the bind-mounted source; no compile step needed)
- **GITIGNORE** Add `data-dev/` to `.gitignore` (parallel to the existing `data/` rule).
- **CI** Add a `docker-build-check` job (in `.github/workflows/ci.yml` or a dedicated workflow) that runs on every PR + push-to-main and builds BOTH Dockerfile targets (`runtime` and `dev`) on `linux/amd64`. No push, just verify the builds don't break. Catches Dockerfile / dependency / native-module regressions before they hit a release.
- **DOCS** Add a "Local dev stack" section to `docs/docker.md` covering the four scripts, the seed shape, the `--reset` flag, the hot-reload behavior, and the binding/port differences from prod.
- **CLAUDE.md** Add a brief subsection under "Commands" pointing future agents at `pnpm run dev:docker:*` so the dev stack is discoverable.

## Out of scope

- **A `docker-compose.test.yml`.** Vitest + `createTestDb()` covers integration tests in <10s. Docker for tests would add 30-60s of overhead with no new coverage.
- **A `rembric seed` CLI subcommand.** The seed is dev-only; the CLI is product surface area. Keeping the script as an internal tool (under `src/scripts/`) avoids leaking dev concerns into the operator-facing CLI.
- **Bundled Ollama or any LLM in the dev compose.** Out of scope — operator's choice how to wire their LLM endpoint. The dev stack inherits `OPENAI_BASE_URL` from `.env` just like prod.
- **A Makefile wrapper.** The project's convention is pnpm scripts (see `package.json::scripts`). A Makefile would be a parallel idiom.
- **A `--count <n>` flag on the seed for variable volume.** ~30-50 rows is the target; if you want hundreds of rows for perf testing, that's a different change (`add-load-fixture-generator` or similar).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This change is purely tooling/packaging — no spec deltas, no behavioral changes, no invariant touches. The seed script writes through the existing public service APIs (`ProjectsService`, `TokensService`, `MemoryService`, `AgentSessionsService`), exercising the same code paths the dashboard and MCP tools use.

## Impact

- **New files**:
  - `docker-compose.dev.yml`
  - `src/scripts/seed-dev.ts`
  - `openspec/changes/add-dev-stack-tooling/` — this proposal + design + tasks + spec delta
- **Modified files**:
  - `Dockerfile` — append a new `dev` stage after the existing `runtime` stage; prod targets unchanged
  - `.gitignore` — add `data-dev/`
  - `package.json` — add 4 `dev:docker:*` scripts
  - `docs/docker.md` — new "Local dev stack" section
  - `CLAUDE.md` — pointer to the dev-docker pnpm scripts under "Commands"
  - `src/test/invariants.test.ts` — extend `DELETE FROM` allow-list for the seed's `--reset` path
  - `.github/workflows/ci.yml` (or new `.github/workflows/docker-build-check.yml`) — Docker build-check job
- **No changes**:
  - `docker-compose.yml`, `docker-compose.build.yml`, `.env.example` — canonical prod artifacts stay untouched
  - `tsconfig.build.json` — already covers `src/**/*.ts`, picks up `src/scripts/seed-dev.ts` automatically
  - `src/services/*`, `src/db/*`, `src/mcp/*`, `src/dashboard/*`, `src/consolidation/*` — no behavior change
  - `tsconfig.build.json` — already includes `src/**/*`, picks up `src/scripts/seed-dev.ts` automatically
  - `.github/workflows/*` — CI doesn't touch the dev stack
  - Plugin tree — unaffected
  - The four load-bearing invariants — untouched
