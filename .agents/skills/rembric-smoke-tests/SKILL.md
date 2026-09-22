---
name: rembric-smoke-tests
description: End-to-end smoke against the local rembric dev server (`pnpm run dev`, host Next.js dev on :3000). Apply when the user says "smoke", "probar contra docker", "dev:up", or after applying an OpenSpec change that touches HTTP (`apps/web/src/app/api/`), MCP tools (`packages/mcp/src/`), or DB migrations (`packages/db/src/migrations/`). Encodes bring-up, readiness verification, probe pattern and teardown — not the probes themselves.
---

# Rembric smoke pattern

Real-stack verification of a change before opening the PR. Read `apps/web/package.json::dev` (`next dev`) and `docs/docker.md` → "Local dev (host)" for the source of truth on how the server boots and where it listens — this file gives you only the pattern that survives those changing.

> The Docker dev stack is **retired**. `pnpm run dev:docker:up` is not a root script, `docker-compose.dev.yml` does not exist, and the compose files describe only the published image. Local dev is the Next.js server on the host.

## 0. Preflight: free the RAM the build needs

`/tmp` is a tmpfs on this box, so everything under it is RAM. Every vitest run leaves a `rembric-test-*` directory behind and nothing cleans them: 1624 of them once held 8 GB, leaving 2.4 GB free, and `pnpm run dev` died with `exit code: 137` (`Killed`) mid-`pnpm install`. That failure reads like a network or lockfile problem and is neither.

```bash
free -h                                                     # the `shared` column is the tmpfs
find /tmp -maxdepth 1 -name 'rembric-test-*' -mmin +60 -exec rm -rf {} +
```

Keep the `-mmin +60`: other sessions may be mid-run, and a bare glob takes their fixtures with it.

## 1. Bring up from the change's worktree

```bash
cd <your-worktree>
REMBRIC_DATA_DIR=./data-dev REMBRIC_ADMIN_TOKEN=<16+-char-token> pnpm run dev
# → http://127.0.0.1:3000/dashboard
```

Point `REMBRIC_DATA_DIR` at a scratch directory (gitignored `./data-dev` is the convention) — never at a real deployment's database. `next dev` binds loopback only and hot-reloads, so there is no build step and no container to rebuild.

Optionally seed a demo corpus so every dashboard surface renders meaningfully:

```bash
REMBRIC_DATA_DIR=./data-dev REMBRIC_ALLOW_DESTRUCTIVE_SEED=1 \
  pnpm --filter @rembric/core exec tsx ../../apps/web/src/scripts/seed-dev.ts --reset
```

The seed prints the generated `demo-reader` / `demo-writer` plaintext tokens once.

## 2. Confirm this server is yours

With the host dev server there is no container and no bind-mount to verify, but you still have to confirm you are talking to **your worktree's** server and **your** data file — a stale `pnpm run dev` from another checkout on :3000 will silently serve the wrong code.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN        # which process/cwd owns :3000
```

The cwd must be your worktree. `next dev` on :3000 exits if the port is taken, so the second checkout usually fails loudly — but confirm anyway if a run looks wrong.

## 3. Wait until ready

```bash
until curl -sf -H "Authorization: Bearer $REMBRIC_ADMIN_TOKEN" \
    http://127.0.0.1:3000/healthz >/dev/null; do sleep 1; done
```

`next dev` compiles routes lazily; the first request to a route can take a few seconds. `/healthz` requires auth.

## 4. Read bearer + slug from sources of truth

- Port: `3000` for host dev (`next dev`); the published image uses `8787` — don't confuse the two.
- Admin bearer: the `REMBRIC_ADMIN_TOKEN` you exported. If you sourced a `.env`, read it with `grep '^REMBRIC_ADMIN_TOKEN=' .env | cut -d= -f2-`; **never `cat .env`** — the harness blocks it to keep secrets out of the transcript.
- Default seeded project slug: from `apps/web/src/scripts/seed-dev.ts` (currently `demo`).

## 5. Probe the change's surface

- **HTTP**: `curl … | jq` against `http://127.0.0.1:3000/api/<slug>/…` with `Authorization: Bearer …` and `Content-Type: application/json`. Parse responses with `jq`, not regex.
- **MCP**: POST JSON-RPC to `/mcp/<slug>` (path-scoped) or `/mcp` (unscoped). Send `Accept: application/json, text/event-stream` — the response is SSE-framed, so strip a leading `data: ` before `JSON.parse`. Handshake first (`initialize` → store the `mcp-session-id` header → `notifications/initialized`), then `tools/call`.
- **DB**: read the host SQLite file directly with node, from the pnpm store, with `cwd` inside `apps/web`. The file is `$REMBRIC_DATA_DIR/data.db` (default `~/.rembric/data.db`):

  ```bash
  cd <worktree>/apps/web
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

in a file named `.rembric` — **`PROJECT_SLUG=<slug>`, not a bare slug.** A bare slug makes every shell hook `exit 0` in silence with no diagnostic, which is indistinguishable from the hooks never running. That mistake produced a confident, wrong "Codex does not run plugin hooks in `codex exec`" finding that had to be retracted. Plus `REMBRIC_SERVER_URL=http://127.0.0.1:3000`, `REMBRIC_API_TOKEN=<admin>` and `REMBRIC_DEBUG=1` — without the last one a failing hook says nothing at all.

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
  claude plugin install rembric@rembric --config server_url=http://127.0.0.1:3000 --config api_token=<token>
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
# stop the `pnpm run dev` process (Ctrl-C in its terminal, or kill the PID from §2)
rm -rf ./data-dev          # optional: drop the scratch DB
```

There is no compose stack to bring down.

## Pitfalls that bit in practice

- **Stale dev server from another checkout.** :3000 is single-occupancy; confirm the listening process' cwd (§2) before trusting a result.
- **`cat .env` is blocked.** Targeted `grep` only.
- **`next dev` compiles lazily.** The first hit on a route can be slow — warm the route once before timing anything.
- **MCP responses are SSE-framed** even when you sent `Accept: application/json` too.
- **`./data-dev` is scratch, not durable.** It is gitignored and can be wiped freely; anything that needs state to survive must be reproduced in the same run.
- **Don't point a dev server and a real deployment at the same `REMBRIC_DATA_DIR`.** Two processes on one SQLite file is a data-safety violation; use a scratch dir.
- **`/tmp` is tmpfs and vitest never cleans up.** See §0; the symptom is `exit code: 137`.

When in doubt, read `docs/docker.md` → "Local dev (host)" first; this skill is the procedure, the docs are the contract.
