---
name: rembric-smoke-tests
description: End-to-end smoke against the local rembric dev stack (`pnpm run dev:docker:up`). Apply when the user says "smoke", "probar contra docker", "dev:up", or after applying an OpenSpec change that touches HTTP (`apps/server/src/server/api-router.ts`), MCP tools (`apps/server/src/mcp/`), or DB migrations (`apps/server/src/db/migrations/`). Encodes bring-up, mount verification, probe pattern and teardown — not the probes themselves.
---

# Rembric smoke pattern

Real-stack verification of a change before opening the PR. Read `docker-compose.dev.yml`, `apps/server/Dockerfile`, and `package.json::dev:docker:up` for the source of truth on ports, mounts, and the dev target — this file gives you only the pattern that survives those changing.

## 1. Bring up from the change's worktree

```bash
cd <your-worktree>
[ -f .env ] || cp <main-worktree>/.env .env
pnpm run dev:docker:up         # background OK
```

## 2. Verify YOUR source is mounted

The compose project name is global across worktrees, so `docker compose up` will silently attach to a stack another worktree already owns. Always confirm:

```bash
docker inspect rembric-dev --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

Sources must point to the current worktree. If they don't, `docker compose -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans` from the owning worktree path, then up again from yours.

## 3. Wait healthy

```bash
until docker ps --filter name=rembric-dev --filter health=healthy --format '{{.Names}}' | grep -q rembric-dev; do sleep 3; done
```

## 4. Read port + bearer from sources of truth

- Container port: from `docker-compose.dev.yml::ports`.
- Admin bearer: `grep '^REMBRIC_ADMIN_TOKEN=' .env | cut -d= -f2-`. **Never `cat .env`** — the harness blocks it to keep secrets out of the transcript.
- Default seeded project slug: from `apps/server/src/scripts/seed-dev.ts`.

## 5. Probe the change's surface

- **HTTP**: `curl … | jq` against `http://localhost:<port>/api/<slug>/…` with `Authorization: Bearer …` and `Content-Type: application/json`. Parse responses with `jq`, not regex.
- **MCP**: POST JSON-RPC to `/mcp/<slug>` (path-scoped) or `/mcp` (unscoped). Send `Accept: application/json, text/event-stream` — the response is SSE-framed, so strip a leading `data: ` before `JSON.parse`. Handshake first (`initialize` → store the `mcp-session-id` header → `notifications/initialized`), then `tools/call`.
- **DB**: the container is intentionally minimal (no `sqlite3`, no `ps`). Use host-side `sqlite3 ./data-dev/data.db` against the bind-mounted file.

Cover the boundaries your change introduces (happy path · the new error path · the next-layer-down guard, e.g. wire-DoS zod cap when you tightened a service cap · the lowest-level constraint, e.g. DB CHECK fires on direct SQL when bypassing the service). Report results as a `| Caso | Esperado | Resultado |` table so the user can scan.

## 6. Teardown

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans
```

Run from the same worktree path you brought up.

## Pitfalls that bit in practice

- **Compose project name is global.** Two worktrees cannot run dev:up simultaneously — the second silently attaches to the first.
- **`cat .env` is blocked.** Targeted `grep` only.
- **Container lacks `sqlite3` / `ps` / `vi`.** Inspect from the host, log via `docker logs`.
- **MCP responses are SSE-framed** even when you sent `Accept: application/json` too.
- **`docker compose up` does not warn on mount divergence.** §2 is the only way to catch it.

When in doubt, read the compose files first; this skill is the procedure, the files are the contract.
