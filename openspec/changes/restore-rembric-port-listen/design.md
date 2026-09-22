## Context

`apps/web/Dockerfile` assembles the standalone Next server from `.next/standalone` and, until this change, set both `REMBRIC_PORT` and `PORT` to `8787` and depended on the generated `server.js` reading `PORT`. The generated file is Next-owned and reads `PORT` only, so `REMBRIC_PORT` — the variable the Compose mapping, the installer and `.env` already agree on — stopped controlling the listen port.

## Goals

- Restore `REMBRIC_PORT` as the effective listen port with no operator Compose edit.
- Probe the effective port in the image HEALTHCHECK.
- Keep `/healthz`, the entrypoint path (`apps/web/server.js`) and the publish smoke contract unchanged.
- Fail loudly on an unusable `REMBRIC_PORT`.

## Non-Goals

- No change to `docker-compose.yml` or `docker-compose.dev.yml`.
- No change to `REMBRIC_HOST` / `HOSTNAME` handling.
- No base-image, layer-order or dependency change.

## Decisions

### D1 — A dependency-free launcher, not a shell or `--import` preload

Distroless has no shell, so the port cannot be derived with `$REMBRIC_PORT` expansion. The launcher is a plain ESM file with Node builtin imports only; it runs before any build output and sets `process.env.PORT` before importing the generated server. A `--import` preload was rejected because the entrypoint path the publish smoke asserts must still hold and a directly-executed launcher gives a simple, testable direct-run guard (`process.argv[1]`), whereas a preload would need an `execArgv` heuristic to stay side-effect-free under test.

### D2 — Rename the generated server so the launcher owns the entrypoint path

The publish smoke asserts `apps/web/server.js` in `ENTRYPOINT`. The generated file is renamed to `next-server.js` in the builder assembly and the launcher is copied to `apps/web/server.js`, keeping `ENTRYPOINT` byte-identical and the generated server in its own directory (its `chdir`/`require` roots are unchanged).

### D3 — Precedence is `REMBRIC_PORT` > `PORT` > `8787`, and invalid values throw

`REMBRIC_PORT` is the documented contract and wins. `PORT` remains a fallback for callers that set only it. An empty or whitespace-only value counts as unset; a non-empty value that is not an integer in `1..65535` throws, and the launcher exits non-zero with the variable name and received value. A silent fallback is the precise bug being repaired.

### D4 — One derivation site, shared by the server and the healthcheck

The HEALTHCHECK runs the same launcher with `--healthcheck`; it resolves the port and fetches `/healthz` on it. This removes the duplicated port literal from the Dockerfile and guarantees the probe and the listener cannot drift.

## Migration and rollback

No migration. Rollback restores the previous `ENTRYPOINT`/`HEALTHCHECK` and assembly copy, deletes `apps/web/server.js`, and drops the tests and this change directory. With `REMBRIC_PORT` unset the effective port is still `8787`, so nothing depends on the new file until the image is rebuilt.
