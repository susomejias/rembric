# Docker smoke evidence (task 7)

Stack: `pnpm run dev:docker:up` on 2026-08-03, `docker-compose.yml` +
`docker-compose.dev.yml`, host port 8788. Every probe went over a **real MCP
connection** (JSON-RPC `initialize` → store `mcp-session-id` → `notifications/initialized`
→ `tools/list` / `tools/call`, SSE-framed), never by calling a handler directly.

## 7.1 The running container carries this change's code

Mounts confirmed to point at this worktree:

```
/root/rembric/data-dev            -> /data
/root/rembric/apps/server/src     -> /app/apps/server/src
```

The `dev` Dockerfile target runs `tsx watch src/server-entrypoint.ts`, i.e. from the
bind-mounted source, not `dist/`. `grep -c countActiveInScope` inside the container
returns 1 for both `/app/apps/server/src/db/repositories/memory-repository.ts` and
`/app/apps/server/src/mcp/project-tools.ts`. The behavioural probes below are the
decisive proof: a cached layer could not have produced them.

## 7.2 `tools/list` over a real MCP connection

```
description: List existing projects. Each entry carries activeMemoryCount — how many
memories in that project are still active; archived and superseded rows are not counted.
Use when the user references a project that may not be active in this session.
length: 239   (DESCRIPTION_MAX_LENGTH = 1900; headroom 1661)
outputSchema entry keys: ["slug","displayName","archived","activeMemoryCount"]
```

## 7.3 `project.list` payload

```
isError: false
entries: [{"slug":"demo","displayName":"Demo Project","archived":false,"activeMemoryCount":18},
          {"slug":"smoke-second-proj","displayName":null,"archived":false,"activeMemoryCount":1}]
all have activeMemoryCount: true
none has memoryCount: true
```

## 7.4 The number is TRUE against the seeded corpus, not merely present

From a connection resolving to `demo`:

```
demo memoriesByStatus:               {"active":18,"superseded":17}
demo activeMemoryCount:              18
equals memoriesByStatus.active:      true
demo total rows in scope:            35
activeMemoryCount < total:           true
```

## 7.5 Controls, so 7.4 is not vacuous

- **More than one project**: 2 (`demo` from the seed, plus `smoke-second-proj` created
  over MCP with `project.use({autocreate:true})` — the seed mints only one).
- **At least one non-`active` row**: the seed's `topic_key` convergence chains leave 17
  `superseded` rows in `demo`, so `activeMemoryCount` (18) is strictly below the total
  row count (35). Both numbers recorded above.
- **A live archive moves the number**: archived `01KZ40YCKHY1BSB7TQKQDDB0HS` over MCP.

```
archive ok:                            true
demo activeMemoryCount before → after: 18 → 17
memoriesByStatus after archive:        {"active":17,"archived":1,"superseded":17}
still agrees with memory.stats:        true
```

- **The old shape would have disagreed.** Same DB, both predicates, run in-container:

```
old predicate (project_id IS NOT NULL, ALL statuses): [{demo: 35}, {smoke-second-proj: 1}]
new predicate (scope + project + active):             [{demo: 17}, {smoke-second-proj: 1}]
```

35 vs 17 on a real seeded corpus, from the same rows — the divergence issue #310
reported, reproduced at deployment scale and closed.

## 7.6 No migration ran, no derived data rebuilt

```
container started:  2026-08-03T14:37:45Z
migration files on disk:   31
_migrations rows applied:  31
most recent applied_at:    0030_memory_fts_vocab.sql  2026-08-02T22:35:29Z
any migration applied at/after this boot?  false
```

`git diff --name-only -- apps/server/src/db/migrations/` is empty — this change adds no
migration. The pre-existing `data-dev` database booted with all 31 migrations already
applied yesterday and zero applied today, which is the upgrade-over-an-installed-
deployment case. No `index reset` / `rebuild` / `backfill` / `re-scan` line in this
boot's log. Entity and memory tables intact: `memory=36`, `memory_fts=36`, `sessions=5`,
`projects=2`. (`memory_vec` is a `vec0` virtual table and is not readable from a bare
`better-sqlite3` connection without the extension — expected, not a finding.)

## Teardown

`docker compose -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans`
— container and network removed, no rembric container left running.
