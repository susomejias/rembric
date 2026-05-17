## Context

After landing `make-docker-primary-distribution`, Rembric ships as a Docker image at `ghcr.io/susomejias/rembric` and the operator's canonical flow is `cp .env.example .env && docker compose up -d`. That flow targets **production deployments**: a single stack on the host (e.g. the author's LXC), tied to one `./data/` volume and one published port.

What's missing — and what this change fills — is the **local development sandbox**. Three concrete pain points motivated this:

1. **Empty dashboard problem.** First-time visitors to `/dashboard` see a wall of empty tables. The most interesting surfaces (judgments page, consolidation runs, session list with summaries, supersession chains) only matter once there's data. Nobody wants to seed by hand every time they spin up a fresh DB.
2. **Port and volume collisions.** Two stacks on the same host (prod compose + a "let me try this branch" compose) both bind `:8787` and both write to `./data/`. They fight. There's no clean way to run them side by side.
3. **No reproducible "look at it populated" setup.** When the author returns to a feature in 6 months, the dashboard's empty state forces them to rebuild context about what populated data looks like. A frozen seed shape is institutional memory.

The dev stack is **not** trying to:

- Replace `pnpm run dev` for fast iteration. That path is faster and stays as the primary code-iteration loop (see Decision 6).
- Provide a test environment for vitest. Vitest's `createTestDb()` already covers integration tests in <10s with full DB isolation.
- Be operator-facing. The audience is the author and contributors hacking on the codebase.

Because this is tooling-only, no behavior or invariant changes, **no spec deltas are required**. The seed script writes through the public service APIs that already exist; the dev compose is an override that doesn't touch the canonical compose.

## Goals / Non-Goals

**Goals:**

- A single command (`pnpm run dev:docker:up`) to spin up a dev stack alongside any running prod stack on the same host, without collision.
- A single command (`pnpm run dev:docker:seed`) to populate the dev DB with ~30-50 thematic rows that exercise every dashboard surface.
- Isolated state: `./data-dev/`, port 8788, container `rembric-dev`. Prod data and prod naming untouched.
- Loopback-only binding on the dev port (`127.0.0.1:8788`). Dev builds may have bugs; LAN exposure is opt-in by the operator.
- Discoverable for future agents (Claude, contributors) via CLAUDE.md.

**Non-Goals:**

- Hot-reload inside the dev container (Decision 6).
- A `docker-compose.test.yml` (vitest covers it).
- A `rembric seed` CLI subcommand (no dev concerns in the operator CLI).
- Bundled Ollama or any LLM (operator's choice).
- A Makefile wrapper (pnpm scripts is the project's convention).
- Configurable seed volume / Faker-driven simulation (defer to a future change if needed).

## Decisions

### Decision 1: Dev binds `127.0.0.1:8788:8787`, NOT `0.0.0.0:8788:8787`

The canonical prod compose binds `0.0.0.0:8787:8787` after the `fix(docker)` revisit — production wants reachability from the LAN/Tailscale. **Dev is the opposite case**: the operator is on the same machine as the dev stack, the container is running an actively-changing build, and the worst plausible outcome is exposing a half-cooked debug build to the LAN by accident. Loopback is the right default.

Operators who want to share their dev stack (e.g. for screen-share debugging) override via a `docker-compose.override.yml` they manage themselves:

```yaml
services:
  rembric:
    ports: !override
      - '0.0.0.0:8788:8787'
```

### Decision 2: Seed shape is "thematic", aiming for ~30-50 rows

Three options were on the table. Selected **B (thematic)** over A (minimal smoke) and C (Faker simulation):

| Option                 | Row count  | Use case                                         | Decision                                         |
| ---------------------- | ---------- | ------------------------------------------------ | ------------------------------------------------ |
| A — minimal            | ~5         | Smoke test: stack starts cleanly                 | Insufficient — dashboard tables still look empty |
| **B — thematic**       | **~30-50** | **Every dashboard surface renders meaningfully** | **Selected**                                     |
| C — simulation (Faker) | 500+       | Perf testing, consolidation stress               | Out of scope; future change                      |

The thematic seed includes:

- 1 project (`demo`).
- 3 tokens: 1 admin (`*` scope) + 2 project-scoped (read/write split).
- ~20 memories across 5 `topic_key` clusters (so the user sees both flat memories and a `topic_key`-grouped view).
- 3 ended sessions with summaries + titles (so `/dashboard/sessions` has terminal rows to inspect).
- 2 active sessions (so the "ACTIVE SESSIONS" counter is non-zero).
- 1 pending judgment (created by saving a second memory whose content+topic_key overlaps an existing one — this surfaces a candidate via `MemoryService.save.candidates[]`).

The exact row count target is "enough to exercise every list view and at least one detail view per page" — not a precise number. If the seed grows to 60 rows during implementation, fine.

### Decision 3: Idempotent by default, `--reset` flag for full wipe

The seed:

1. Opens the DB via `createDb` (the same path bootstrap uses).
2. Checks for a `demo` project. If found, prints `[seed-dev] data already present; pass --reset to wipe and reseed` and exits 0.
3. With `--reset`: `DELETE FROM` the relevant tables (memories, sessions, tokens, projects, etc.) in dependency order, then proceed with the seed.

Rationale: re-running `pnpm run dev:docker:seed` is harmless by default (the user might press it twice; we don't want to corrupt or duplicate). The `--reset` escape hatch is for "I want a fresh canvas now".

Important caveat: `--reset` opens the append-only invariant on the seed's own data. The seed script is the **only** path that calls `DELETE FROM` outside the documented allow-list in `src/test/invariants.test.ts`. We extend that allow-list to include `src/scripts/seed-dev.ts`. The seed runs against `./data-dev/`, never `./data/`, so prod can never be touched by the seed — by construction (the dev compose override is the only place `./data-dev` is mounted, and the seed runs inside that container).

### Decision 4: Seed implemented in TypeScript with direct service imports

The script imports services directly:

```ts
import { createDb } from '../db/index.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService } from '../services/tokens.js';
import { MemoryService } from '../services/memory.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
```

No HTTP round-trips, no auth dance. The script opens the SQLite file via `createDb`, instantiates services, calls their public methods to insert rows. Fast, type-safe, exercises the same code paths the dashboard uses.

Alternatives rejected:

- **Bash + curl against `/api`**: portable but stringly-typed, slow (HTTP overhead), requires the server to be running.
- **`rembric seed` CLI subcommand**: contaminates the operator-facing CLI with dev concerns.

The script lives at `src/scripts/seed-dev.ts`. `tsconfig.build.json` already compiles everything under `src/`, so it ends up at `dist/scripts/seed-dev.js` with no tsconfig change. The Dockerfile already copies `dist/` to the runtime image, so the seed is available inside the container without any Dockerfile change.

### Decision 5: Four pnpm scripts, no Makefile, no dispatch-style wrapper

The verbose form is:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build     # foreground
```

Wrapped as a single `pnpm run dev:docker:up`. The dev container's `CMD` chains `build:css + copy-assets + seed-dev + tsx watch` so one command brings up a populated dev stack with hot-reload. Foreground `up` means logs stream to the operator's terminal, Ctrl-C tears down the container, and there's no detached state to remember.

`down` / `logs` / `seed` are intentionally NOT pnpm scripts:

- `down` — Ctrl-C already stops the container. For full cleanup of container + network, the verbose `docker compose -f ... -f ... down` is fine for the rare cases that need it.
- `logs` — foreground `up` puts logs in front of you already.
- `seed` — runs inside the container's boot chain. Force-reset is the verbose `docker compose -f ... -f ... exec rembric tsx src/scripts/seed-dev.ts --reset`.

Wrapped as `pnpm run dev:docker:{up,down,logs,seed}`. The naming mirrors the existing project conventions (`pnpm run db:generate`, `pnpm run test:watch`, etc.). A dispatch-style `pnpm run dev:docker <sub>` was considered and rejected — it requires inline argument parsing and doesn't read as cleanly in tab-completion.

Reset flow stays explicit and verbose:

```bash
pnpm run dev:docker:down && rm -rf ./data-dev && pnpm run dev:docker:up && pnpm run dev:docker:seed
```

Wrapping that in a fifth script (`dev:docker:reset`) was considered. Rejected on the grounds that the reset is uncommon enough that the chain reads fine, and a hidden `rm -rf` inside a pnpm script earns a closer look than a literal command in the doc.

### Decision 6: Hot-reload IS enabled in the dev container via `tsx watch`

**Revised 2026-05-17 from the original "no hot-reload" stance** after the author confirmed they want live reload as long as the implementation cost stays bounded.

The dev compose runs `tsx watch src/cli.ts start` (instead of the prod `node /app/dist/cli.js start`) against the bind-mounted `./src` directory. When the operator saves a `src/**/*.ts` file:

1. Host editor writes the file.
2. Docker propagates the fs event through the bind-mount.
3. `tsx watch` detects the change, kills the current Node child, spawns a new one. ~1-2 seconds end-to-end.

Net new complexity:

- **A new `dev` stage in the Dockerfile (~20 lines).** It mirrors the existing `builder` stage but stops short of compiling — instead, it sets `PATH` to include `./node_modules/.bin`, declares the same env/volume/expose/healthcheck contract, and uses `ENTRYPOINT ["tsx", "watch"]` + `CMD ["src/cli.ts", "start"]`. The prod `runtime` stage is unchanged.
- **A `./src:/app/src` bind-mount in the dev compose.** One line.
- **A `target: dev` in the dev compose `build:` block.** One line.

That's ~22 lines net. Within the author's "if sencillo, déjalo" bar.

**Tradeoffs accepted:**

- The dev image is larger (~350-400MB vs prod's ~260MB) because dev deps stay. Fine — never published, never pulled.
- Type errors won't fail the running process (tsx is a runner, not a typechecker). The operator runs `pnpm run typecheck` separately or relies on their editor's TS server.
- During tsx-driven restarts (sub-second), the healthcheck may flap. `start-period` is extended to 20s and `retries` to 5 to absorb this.
- The seed script invocation changes: `tsx src/scripts/seed-dev.ts` instead of `node /app/dist/scripts/seed-dev.js`. Documented in `tasks.md::4.1` and `docs/docker.md::Local dev stack`.

`pnpm run dev` on the host stays available as the OPTIONAL "even faster, no Docker" path. Operators choose: Docker hot-reload for full-stack validation in a prod-like environment, or pnpm dev for raw speed. Both feedback loops are sub-second; pick what you need.

### Decision 10: Alpine base attempted, reverted to bookworm-slim

**Attempted 2026-05-17, reverted same day.** The author asked to try Alpine for the size win. Switching `FROM node:20-bookworm-slim` to `FROM node:20-alpine` in both `runtime` and `dev` stages built cleanly and produced smaller images (alpine-prod 173MB vs bookworm-slim 259MB — 33% smaller; alpine-dev 637MB vs 781MB — 18%). **The container failed to start.**

Root cause: `sqlite-vec` does NOT publish musl prebuilts. The package's `npm` artefacts cover `darwin-{arm64,x64}`, `linux-{arm64,x64}` (glibc), and `windows-x64` — no `*-musl` variants. On Alpine, the loader tries `vec0.so` + `.so` → `vec0.so.so: No such file or directory`.

Workaround would be: clone sqlite-vec source in the builder stage, install sqlite headers via apk, compile the extension manually, copy it into runtime. ~30-50 lines of Dockerfile + risk that the next sqlite-vec version breaks the build. Cost-benefit: the 80MB savings on the prod image don't compensate for that fragility.

`better-sqlite3` would have worked on Alpine (they publish musl prebuilts). The blocker is sqlite-vec specifically. If sqlite-vec ever publishes musl prebuilts, Alpine becomes viable.

**Decision: stay on bookworm-slim.** This consolidates `make-docker-primary-distribution::Decision 3` (which had originally rejected Alpine on the same grounds, before retesting confirmed it). The reasoning is now empirically validated, not just predicted.

### Decision 9: Dockerfile multi-stage with a new `dev` target

Instead of bolting tsx into the prod image (which would either bloat the prod package or contaminate npm consumers via prod-dep escalation), the Dockerfile gains a new third stage:

```
builder  → compiles dist/                (existing, unchanged)
runtime  → prod: copies dist/ + prunes   (existing, unchanged)
dev      → keeps full install, tsx in PATH, tsx watch entrypoint  (NEW)
```

The canonical `docker compose up` (and the CI publish workflow) still target the implicit final stage (`runtime`) and produce the same image as before — zero behavior change for prod consumers. The dev compose explicitly opts into the new stage via `target: dev`. The two stages don't share layers beyond the base image, but Docker's layer cache deduplicates the common APT install + `corepack enable` between them.

**Why not a separate `Dockerfile.dev`?** Splitting Dockerfiles is the alternative pattern. Rejected because:

- Two files drift (you change the apt install in one, forget the other).
- One file with named targets is the canonical Docker pattern for multi-environment images.
- The dev stage shares the base image declaration, the build-essential install, the user creation — keeping them in one file keeps the duplication visible and reviewable.

### Decision 7: Distinct compose project name (`rembric-dev`) for coexistence

Compose v2 generates container/network names from the project name. The canonical compose's container is hardcoded to `container_name: rembric`. To run both stacks on one host:

- Dev compose sets `name: rembric-dev` at the top level → project name is `rembric-dev`.
- Dev compose overrides `container_name: rembric-dev` so the service container has a distinct name.
- The default network becomes `rembric-dev_default` (no collision with `rembric_default`).

The two stacks never see each other and never collide on:

- Container names (`rembric` vs `rembric-dev`)
- Networks (`rembric_default` vs `rembric-dev_default`)
- Volumes (`./data/` vs `./data-dev/`)
- Published ports (`<all>:8787` vs `127.0.0.1:8788`)
- Compose project state (`rembric` vs `rembric-dev` in `docker compose ls`)

### Decision 8: Seed allow-list addition in `invariants.test.ts`

`src/test/invariants.test.ts` maintains an allow-list of files permitted to emit `DELETE FROM <table>` statements. Today that's `src/services/agent-sessions.ts` (for `purgeEmpty`) and `src/services/memory.ts` (for `purgeDisconnectedArchived`). The seed's `--reset` mode adds a third entry: `src/scripts/seed-dev.ts`.

This is a deliberate, narrowly-scoped relaxation. The invariant test continues to enforce that NO other source file can `DELETE FROM` the protected tables. Adding `src/scripts/seed-dev.ts` to the allow-list is captured in `tasks.md` so the test update is unmistakable.

## Risks / Trade-offs

- **Image bloat.** `dist/scripts/seed-dev.js` ships in the prod image even though it's dev-only. Estimated overhead: <50KB compiled. Acceptable. The alternative (shipping `scripts/` separately + running with `tsx` from npx cache) was more complexity for less than a megabyte of savings.
- **Seed coupling to internal APIs.** The seed imports `MemoryService`, `ProjectsService`, etc. directly. If those internal APIs change shape, the seed breaks. That's a feature, not a bug — the seed acts as a smoke test for those signatures. CI doesn't run the seed today; we could add a `pnpm test` integration that runs it against an in-memory DB, but that's a follow-up.
- **`--reset` is destructive.** Pressing `pnpm run dev:docker:seed --reset` wipes `./data-dev`. The `data-dev` naming + the operator typing `--reset` deliberately is the safety. The seed prints a clear warning before deleting.
- **Container name `rembric-dev` could collide with someone's existing container.** If you have a pre-existing container called `rembric-dev` for unrelated reasons, the dev stack fails at startup with a clear "container name in use" error. Document the rename path in `docs/docker.md`.

## Migration Plan

No migration. The change is purely additive — no existing files have their behavior changed. Operators who don't use the dev stack see no difference.

For the author (and any future contributor):

1. After pulling this change: `pnpm install` (no new deps, but lockfile-safe to re-run).
2. Optional: `pnpm run dev:docker:up` to spin up the dev stack.
3. Optional: `pnpm run dev:docker:seed` to populate the dev DB.
4. Visit `http://127.0.0.1:8788/dashboard` and log in with the admin token printed by the seed.

## Open Questions

- **Should `pnpm test` exercise the seed?** Today: no, it would couple unit tests to a Docker-only flow. The seed gets implicit smoke coverage via the operator's first-time use. If the seed quietly rots, the operator notices on next iteration. Could revisit if rot becomes a pattern.
- **Should the seed log the admin token plaintext at the end of its run?** Yes — see `tasks.md`. The seed mints a new admin token (because the demo project's admin needs to be discoverable) and prints it to stderr. Same pattern as `rembric token create`.
- **Should the dev stack ALSO write a `migrate-to-docker-dev.local.txt` analog?** No. The migration recipe was a one-off for the author's `~/.rembric/` data. A dev stack starts empty by design.
