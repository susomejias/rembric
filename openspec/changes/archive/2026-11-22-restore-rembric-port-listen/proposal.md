## Why

The standalone image built from `apps/web/Dockerfile` lets the Next-generated `server.js` read only `PORT`, which the image bakes to `8787`. Every other Rembric surface names `REMBRIC_PORT`: `docker-compose.yml` maps `${REMBRIC_PORT}:${REMBRIC_PORT}`, the installer writes it to `.env`, the docs list it, and the baseline (`c64934f`) made the server listen on it. An existing installation that set `REMBRIC_PORT=8799` therefore publishes host port 8799 while the container listens on 8787 — unreachable from the host (`/healthz` returns `000`) and failing its Compose healthcheck, which probes `REMBRIC_PORT`. The regression must be repaired without requiring operators to edit their existing Compose files.

## What Changes

- Add `apps/web/server.js`, a dependency-free launcher that resolves the listen port as `REMBRIC_PORT` → `PORT` → `8787`, rejects a non-empty invalid `REMBRIC_PORT` with a clear error instead of silently falling back, publishes the result as `PORT`, and only then loads the generated server.
- Rename the generated standalone server to `next-server.js` during the image assembly so the launcher can own the documented `apps/web/server.js` entrypoint path; keep `ENTRYPOINT` unchanged so the publish smoke test's `EXPECT_ENTRY` assertion still holds.
- Replace the hard-coded `127.0.0.1:8787` HEALTHCHECK with a probe that runs the launcher in `--healthcheck` mode, so it targets the same env-derived port.
- Keep `/healthz` semantics unchanged; it must answer on the effective port.
- Pin the derivation and the Dockerfile wiring with a focused launcher test and structural image invariants.

## Impact

- Runtime: `apps/web/server.js` becomes the container entrypoint; the generated server is reached as `next-server.js`. `REMBRIC_PORT` remains the single source of truth for the listen port, with `PORT` and `8787` as fallbacks.
- Image: `apps/web/Dockerfile` gets one `mv`, one build-gate path update, one `COPY` of the launcher, and a new HEALTHCHECK. No base-image change and no layer reshuffle.
- Behavior: an installation whose `.env` sets `REMBRIC_PORT=8799` listens on 8799 again without any Compose edit. An invalid `REMBRIC_PORT` refuses startup rather than binding 8787.
- No database migration, no dependency change, no API-surface change.
- Runtime container verification (build the image, bring up the old Compose at `REMBRIC_PORT=8799`, confirm public `/healthz` 200) is scheduled separately and is untested in this change.
