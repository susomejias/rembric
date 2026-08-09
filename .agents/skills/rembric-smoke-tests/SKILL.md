---
name: rembric-smoke-tests
description: End-to-end smoke against the local rembric dev stack (`pnpm run dev:docker:up`). Apply when the user says "smoke", "probar contra docker", "dev:up", or after applying an OpenSpec change that touches HTTP (`apps/server/src/server/api-router.ts`), MCP tools (`apps/server/src/mcp/`), or DB migrations (`apps/server/src/db/migrations/`). Encodes bring-up, mount verification, probe pattern and teardown — not the probes themselves.
---

# Rembric smoke pattern

Real-stack verification of a change before opening the PR. Read `docker-compose.dev.yml`, `apps/server/Dockerfile`, and `package.json::dev:docker:up` for the source of truth on ports, mounts, and the dev target — this file gives you only the pattern that survives those changing.

## 0. Preflight: free the RAM the build needs

`/tmp` is a tmpfs on this box, so everything under it is RAM. Every vitest run leaves a `rembric-test-*` directory behind and nothing cleans them: 1624 of them once held 8 GB, leaving 2.4 GB free, and `pnpm run dev:docker:up` died with `exit code: 137` (`Killed`) mid-`pnpm install`. That failure reads like a network or lockfile problem and is neither.

```bash
free -h                                                     # the `shared` column is the tmpfs
find /tmp -maxdepth 1 -name 'rembric-test-*' -mmin +60 -exec rm -rf {} +
```

Keep the `-mmin +60`: other sessions may be mid-run, and a bare glob takes their fixtures with it.

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
- **DB**: the container is intentionally minimal (no `sqlite3`, no `ps`) — and the **host has no `sqlite3` either**. Read the bind-mounted file with node, from the pnpm store, with `cwd` inside `apps/server`:

  ```bash
  cd <worktree>/apps/server
  node -e 'const D=require("better-sqlite3");const db=new D("../../data-dev/data.db",{readonly:true});
    console.log(db.prepare("SELECT id,status,ended_at FROM sessions ORDER BY started_at DESC LIMIT 3").all());'
  ```

  From an ESM script the workspace root resolves nothing; import the real path,
  `<worktree>/node_modules/.pnpm/better-sqlite3@<v>/node_modules/better-sqlite3/lib/index.js`.

Cover the boundaries your change introduces (happy path · the new error path · the next-layer-down guard, e.g. wire-DoS zod cap when you tightened a service cap · the lowest-level constraint, e.g. DB CHECK fires on direct SQL when bypassing the service). Report results as a `| Caso | Esperado | Resultado |` table so the user can scan.

**Every arm needs a control that must pass, in the same run.** A smoke arm has two ways to look green: the behaviour works, or the probe never reached it. They are indistinguishable from the outside, and this repo has been fooled by both — an "absent from the purge set" assertion over an empty set, and a `session-end.sh` timing of **2 ms** that turned out to be the script aborting before it did anything. Pair each assertion with the negative that proves the probe bit: the same call before the change lands, the row that IS in the set beforehand, the write that DID happen.

## 5b. Driving the real client CLIs against your worktree

Unit tests exercise the scripts; only this exercises the host. Every recipe below keeps the operator's own installation untouched — never install your worktree into `~/.claude`, `~/.codex` or `~/.pi`.

Common setup for all of them: a scratch working directory containing

```
PROJECT_SLUG=demo
```

in a file named `.rembric` — **`PROJECT_SLUG=<slug>`, not a bare slug.** A bare slug makes every shell hook `exit 0` in silence with no diagnostic, which is indistinguishable from the hooks never running. That mistake produced a confident, wrong "Codex does not run plugin hooks in `codex exec`" finding that had to be retracted. Plus `REMBRIC_SERVER_URL=http://localhost:<port>`, `REMBRIC_API_TOKEN=<admin>` and `REMBRIC_DEBUG=1` — without the last one a failing hook says nothing at all.

- **Codex** — works headless, hooks included:

  ```bash
  export CODEX_HOME=<scratch>/codexhome          # isolated; ~/.codex untouched
  codex plugin marketplace add <worktree>        # local path is a valid marketplace
  codex plugin add rembric@rembric               # the qualifier is required
  codex exec --json --skip-git-repo-check --dangerously-bypass-hook-trust "..."
  codex exec resume <thread_id> --json --skip-git-repo-check --dangerously-bypass-hook-trust "..."
  ```

  Hooks do not run until the operator trusts each type; `--dangerously-bypass-hook-trust` is the documented automation escape. Confirm the cached copy under `$CODEX_HOME/plugins/cache/…` is _yours_ before trusting the result.

- **Pi** — works headless, extension loaded by path:

  ```bash
  pi -p -ne -e <worktree>/apps/plugin/.pi-plugin/index.ts "..."
  pi -p -ne -e <same> --session <session-id> "..."      # cold-start resume
  ```

  `-ne` disables discovery so the operator's installed extension cannot interfere; `-e` still honours the explicit path.

- **Claude Code** — works headless, through a marketplace and never through `--plugin-dir`:

  ```bash
  export CLAUDE_CONFIG_DIR=<scratch>/claudehome     # isolated; ~/.claude untouched
  claude plugin marketplace add <worktree>
  claude plugin install rembric@rembric --config server_url=http://localhost:<port> --config api_token=<token>
  claude -p --output-format json "..."              # session_id is in the JSON
  claude -p --resume <session-id> --output-format json "..."
  ```

  `--plugin-dir <worktree>/apps/plugin` loads **nothing** — no row, no `REMBRIC_DEBUG` diagnostic, nothing under `--debug`. That silence reads exactly like "print mode does not run hooks", and a first attempt here concluded precisely that and was wrong: `-p` runs hooks fine once the plugin is installed. The `--config` keys are the plugin's own (`server_url`, `api_token`), not the environment variable names.

  The general lesson, since it cost two wrong conclusions on two clients: **install through the client's own marketplace into an isolated config dir.** Reach for that before any load-by-path flag.

- **opencode** — it has what an arm needs (`opencode run -s <session-id>` / `-c`), but its plugin directory comes from `$HOME` (`${HOME}/.config/opencode`), so isolating the install means running with a scratch `HOME`. Agent harnesses commonly refuse that, since `HOME` also redirects git configuration. Either get that permission explicitly or leave the arm to an operator — do not install into the real `~/.config/opencode` just to verify.

- **Running a hook script directly** (to time it, or to drive one event): invoke it with **`bash`, not `sh`**. The scripts read `${BASH_SOURCE[0]}` under `set -u`, so a POSIX shell aborts into their own `trap … ERR` and exits 0 in about 2 ms having done nothing.

**Proving a lifecycle transition landed when no field reports it.** A `/end` against an already-terminal row is a documented no-op, so `ended_at` moving is proof the row was `active` when the end arrived — which is how a resume between two runs is demonstrated without any endpoint exposing "was resumed". Look for that shape: an idempotent verb whose side effect only occurs from the state you are trying to prove.

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
- **A container restart WIPES the database.** The dev container runs `seed-dev --reset` on every boot, so `docker restart rembric-dev` returns a freshly seeded corpus: new session ids, your smoke's rows gone, and migrations applied from `0000` in the log. Anything that needs state to survive a restart — "the boot sweep does not re-retire this row", "no migration ran" — is **not measurable in this stack**, and neither is it a defect in the change. Capture fixture ids after the boot you are going to use, never before.
- **`/tmp` is tmpfs and vitest never cleans up.** See §0; the symptom is `exit code: 137` in a `RUN` layer.

When in doubt, read the compose files first; this skill is the procedure, the files are the contract.
