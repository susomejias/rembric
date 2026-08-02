# Docker smoke evidence (task 6)

Stack: `pnpm run dev:docker:up` on 2026-08-02, `docker-compose.yml` +
`docker-compose.dev.yml`, host port 8788. Probed over a real MCP connection
(JSON-RPC `initialize` → `notifications/initialized` → `tools/list` /
`tools/call`, SSE-framed), never by calling a handler directly.

## 6.1 — the running process serves the edited source

`docker inspect rembric-dev` mounts:

```
/root/rembric/data-dev        -> /data
/root/rembric/apps/server/src -> /app/apps/server/src
```

The dev target bind-mounts the source, so there is no layer to go stale, and the
new text is not in `HEAD` at all (`git show HEAD:apps/server/src/mcp/server.ts |
grep -c 'SERVER-WIDE'` → `0`) while the container's copy has it
(`docker exec rembric-dev … includes('SERVER-WIDE (all projects + global)')` →
`true`, `includes('DB/LLM/embeddings')` → `false`). A cached layer could not
produce that text.

## 6.2 — descriptions as `tools/list` returns them, verbatim

`memory.doctor` (`String.length` = 403):

```
Read-only operational diagnostics, SERVER-WIDE (all projects + global): DB/embeddings/entities/consolidation health, `sessions.active`, and review queue depths (`needsReview`, `pendingJudgments`), plus warnings. These counters are NOT scoped — `memory.stats` carries the scoped equivalents (`needsReviewTotal`, `pendingJudgmentsTotal`) and they will differ. Use at session start when behavior seems off.
```

`memory.stats` (`String.length` = 254):

```
Read-only counters: `memoriesByStatus`, `memoriesByType`, `sessionsByStatus`, `needsReviewTotal`, `pendingJudgmentsTotal` — all scoped to the active project (or global). `memory.doctor` reports same-named counters server-wide, so its numbers will differ.
```

## 6.3 / 6.4 — the advertised divergence, observed

Counters read from `/mcp/demo` (path-scoped) after the control below was
established. Full payloads are in the probe output; the counters that matter:

| Reading                                     | Value                                |
| ------------------------------------------- | ------------------------------------ |
| `memory.doctor` → `review.pendingJudgments` | 3                                    |
| `memory.stats` → `pendingJudgmentsTotal`    | 1                                    |
| `memory.doctor` → `review.needsReview`      | 3                                    |
| `memory.stats` → `needsReviewTotal`         | 3                                    |
| `memory.doctor` → `sessions.active`         | 2                                    |
| `memory.stats` → `sessionsByStatus.active`  | 2                                    |
| `memory.stats` → `scope`                    | `project:01KZ1TT3B9GXG4KX1N2KNX65VJ` |

**Control (6.4).** The seed produces one project and one pending pair, both in
`demo` — two zeroes would have satisfied `>=` while proving nothing. Before
asserting, the probe created pendings in two further scopes over MCP: a
near-duplicate pair saved with `scope: 'global'` (1 candidate returned) and a
second project `smoke-second` via `project.use {autocreate: true}` with its own
near-duplicate pair (1 candidate). `project.list` then returned two projects
(`demo`, `smoke-second`), and pendings existed in three distinct scopes.

That makes `pendingJudgments` a **strict** inequality: `3 > 1` — the demo pending
plus the global one plus the `smoke-second` one, against a demo-scoped total of
one. Recorded on both sides: before seeding, doctor
`{needsReview: 3, pendingJudgments: 1}` and stats `pendingJudgmentsTotal: 1`;
after seeding, doctor `pendingJudgments: 3` and stats `pendingJudgmentsTotal: 1`.
`sessions.active` is 2 on both sides (equal, not strict) — every active session in
this corpus belongs to `demo`.

17 of 17 probe cases passed, including the vacuity controls (both tools present
in `tools/list` with non-empty descriptions; `> 1` project; strict inequality).

## 6.5 — no migration, no derived-index rebuild

The first boot created `data-dev/data.db`, so it necessarily applied all 29
migrations. The meaningful check is the second boot, which is the upgrade shape:
`down --remove-orphans` then `up` against the existing file.

| Reading                                                     | Boot 1 (fresh DB) | Boot 2 (existing DB) |
| ----------------------------------------------------------- | ----------------- | -------------------- |
| `_migrations` rows                                          | 29                | 29                   |
| `max(_migrations.applied_at)`                               | 1785694195590     | 1785694195590        |
| `[warn] entity extractor recipe changed → index reset`      | present           | absent               |
| `[bootstrap] no prior state marker; treating as first boot` | present           | absent               |

No new migration row and no re-index on boot 2 — an installed deployment taking
this change does no schema or derived-index work. (`memory_fts` and the three
entity tables are rewritten by `seed-dev --reset`, which the dev stack runs on
every boot; that is the seeder, not this change, which contains no migration
file.)

## 6.6 — teardown

`docker compose -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans`.
</content>
