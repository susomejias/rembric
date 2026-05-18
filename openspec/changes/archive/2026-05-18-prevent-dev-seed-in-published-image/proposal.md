## Why

The published image `ghcr.io/susomejias/rembric:latest` was built from the **`dev` stage** of the multi-stage Dockerfile instead of the `runtime` stage, because `.github/workflows/docker-publish.yml` invokes `docker/build-push-action@v5` without a `target:` field and Docker defaults to the _last_ stage of the Dockerfile (which is `dev`). The dev stage's `CMD` invokes `tsx src/scripts/seed-dev.ts --reset` unconditionally on every container boot — a script whose documented contract is "ALWAYS wipes ./data-dev/ + reseeds ~30 thematic rows + 3 fresh tokens" (`src/db/migrations` left intact, all data rows destroyed).

Result: every `docker compose up`, `--force-recreate`, or container restart against the canonical compose silently destroys the operator's data. The bug was observed in prod on 2026-05-17: an instance with 82 memories + 6 projects (verified from a PBS backup of the pre-Docker `~/.rembric/data.db`) was wiped down to 23 memories + 1 "Demo Project" + 5 sessions + 3 tokens — exactly the seed contents. The operator initially suspected `--force-recreate`, but auditing `src/db/client.ts`, `src/db/migrate.ts`, all SQL migration files, and the bootstrap path confirmed that none of these can destroy memory rows; the wipe originates in the dev seed shipped inside the prod image.

The fix is a one-line change in the publish workflow, but the failure mode reveals that we have **zero structural guards** against republishing the dev stage by accident, and that the seed script will gleefully wipe whatever data directory it points at without any operator confirmation. This change adds the missing guards so this category of incident cannot recur.

## What Changes

- **CI/PUBLISH** Add `target: runtime` to the `docker/build-push-action@v5` step in `.github/workflows/docker-publish.yml` so the published image is the prod-grade `runtime` stage (no tsx, no seed, no watch). This alone repairs all future publishes.
- **DOCKERFILE** Reorder the Dockerfile stages so `runtime` is the last stage in the file (current order: `builder → runtime → dev` becomes `builder → dev → runtime`). Fail-safe: a future contributor who edits the publish workflow and drops `target: runtime` by mistake still produces the correct image because `docker build .` without `--target` builds the last stage.
- **CI** Add a post-publish smoke-test step in `docker-publish.yml` that pulls the freshly-pushed `:sha-<short>` tag and asserts via `docker inspect` that the image's `Config.Cmd`/`Config.Entrypoint` does NOT contain the strings `seed-dev` or `tsx watch`, and DOES contain `dist/server-entrypoint.js`. The publish workflow SHALL fail (and `:latest` SHALL NOT be retagged) if the smoke test fails.
- **SEED HARDENING** `src/scripts/seed-dev.ts --reset` SHALL refuse to execute its destructive path unless the env var `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` is set in the process environment. Without the env, the script SHALL emit a stderr message and exit with a non-zero code. The dev compose's boot chain SHALL set this env var inline so the dev stack continues to work without operator intervention; the prod compose SHALL NOT set it.
- **INVARIANT TESTS** Extend `src/test/invariants.test.ts` to assert that:
  1. The Dockerfile's last stage is `runtime` (regex search for `^FROM .* AS runtime\b` after any `AS dev` line, with `runtime` being the final `AS <name>` declaration).
  2. The publish workflow contains `target: runtime` in the `Build and push` step.
  3. `seed-dev.ts` contains the `REMBRIC_ALLOW_DESTRUCTIVE_SEED` env-var gate around its `DELETE FROM` block.
  4. The `runtime` stage of the Dockerfile declares `LABEL rembric.stage=runtime` and the `dev` stage declares `LABEL rembric.stage=dev`.
  5. The server's bootstrap code calls a `assertDataLossGuard()` helper before serving traffic.
- **IMAGE LABEL** The Dockerfile SHALL set a `LABEL rembric.stage=<runtime|dev>` on each named stage. The publish workflow's smoke test SHALL additionally assert `Config.Labels."rembric.stage" == "runtime"` on the pushed image. This adds a second, independent signal beyond `Cmd`/`Entrypoint` inspection.
- **IMAGE SIZE** The publish workflow's smoke test SHALL assert the pushed image's compressed size is below an upper bound (initial: 600 MB). The dev stage is ~1.45 GB (full dev deps + source tree + tsx + vitest); the runtime stage is ~300 MB. A wrong-stage publish blows past 500 MB even without any other signal.
- **BOOT-TIME DATA-LOSS GUARD** Server bootstrap SHALL maintain a state marker `${REMBRIC_DATA_DIR}/.rembric-state.json` recording the last-known counts of operator-visible tables (`memory`, `projects`, `sessions`, `tokens`, `prompts`). On subsequent startups, the server SHALL compare current counts vs the marker and SHALL refuse to start (exit non-zero with a clear error) if any of those tables shrunk by ≥ 50% since the last clean shutdown, unless the env var `REMBRIC_ALLOW_DATA_SHRINKAGE=1` is set. The dev compose SHALL set this env (the seed legitimately wipes); the prod compose SHALL NOT.
- **STARTUP BANNER** Server bootstrap SHALL emit a structured stderr banner immediately after migrations apply: `[bootstrap] rembric v<version> ready — memory:N projects:M sessions:S tokens:T prompts:P (data_dir=<path>)`. This makes "started with empty DB unexpectedly" visible in the operator's `docker compose logs` without requiring any external monitoring.
- **RELEASE** Bump version `0.14.0 → 0.14.1` to trigger `release-please` → `docker-publish` and propagate the corrected image to `:latest`. CHANGELOG entry documents the incident and the fix.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `development-environment`: harden the dev seed script with an explicit destructive-action env var gate; extend the dev-stack contract to document that the env var is set inline by `docker-compose.dev.yml` and MUST NOT appear in the prod compose. Add a requirement that the Dockerfile stage order makes `runtime` the implicit default target. Add a requirement that the `docker-publish.yml` workflow explicitly targets the `runtime` stage AND verifies the published image's `Cmd` post-publish.
- `persistence`: extend the existing "data is never destroyed without an explicit operator-triggered code path" invariant to cover the build/publish pipeline. State that the **distributed image** (the artifact pulled from `ghcr.io/susomejias/rembric:*`) MUST NOT contain any startup logic that issues `DELETE FROM` against operator-visible tables. Tie this to the smoke-test guard in CI. Add the boot-time data-loss guard requirement (state marker + delta check + refuse-to-start path) and the startup banner that exposes current row counts to operator logs.

## Impact

- **Modified files**:
  - `.github/workflows/docker-publish.yml` — add `target: runtime`, the post-publish smoke-test step, the image-label assertion, the image-size assertion
  - `Dockerfile` — reorder stages so `runtime` is last; add `LABEL rembric.stage=runtime` on the runtime stage and `LABEL rembric.stage=dev` on the dev stage; update the inline comment that asserts "the implicit final stage above (runtime)" to match new layout (or remove it)
  - `src/scripts/seed-dev.ts` — wrap the destructive path in a `REMBRIC_ALLOW_DESTRUCTIVE_SEED` check; emit stderr + exit non-zero when absent
  - `docker-compose.dev.yml` — inject `environment: REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` AND `REMBRIC_ALLOW_DATA_SHRINKAGE=1` so the dev stack continues to seed-and-wipe on `up`
  - `src/server/bootstrap.ts` — wire `assertDataLossGuard()` (new helper) before `startHttpServer`; emit the structured startup banner with row counts
  - **NEW** `src/server/data-loss-guard.ts` — implements the state marker read/write + delta check + refuse-to-start path; honors `REMBRIC_ALLOW_DATA_SHRINKAGE=1`
  - `src/server/index.ts` — on clean shutdown (`SIGINT`/`SIGTERM` handler), trigger a final state-marker write so the next boot has fresh counts to compare against
  - `src/test/invariants.test.ts` — five new assertions (Dockerfile last stage, publish workflow target, seed env gate, image LABELs on both stages, bootstrap calls assertDataLossGuard)
  - `package.json` — bump version `0.14.0 → 0.14.1`
  - `CHANGELOG.md` (release-please managed) — entry documenting the data-loss incident and the corrective publish
  - `openspec/specs/development-environment/spec.md` — updated by archiving with the deltas
  - `openspec/specs/persistence/spec.md` — updated by archiving with the deltas
- **No changes**:
  - The dev stack's behavior from the operator's perspective (the seed still runs on `dev:docker:up` because the dev compose sets the env var inline)
  - Anything under `src/services/`, `src/db/`, `src/mcp/`, `src/dashboard/`, `src/consolidation/` — packaging and seed-gating only
  - The prod compose (`docker-compose.yml`) — it never set the env, will continue not to set it
- **Operational follow-up (not part of this spec change)**:
  - The operator (single user) restores their data from PBS backup `ct/121/2026-05-17T16:10:55Z` ("rembric - before docker") via `proxmox-file-restore` or `scp + pct push`, AFTER bumping to `0.14.1` so the new container does NOT re-wipe on first `up`.
