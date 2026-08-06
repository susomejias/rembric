# Upgrade smoke for tasks 4.6–4.13, against pre-existing seeded data

Tasks 4.1–4.5 added a type nothing could reach. Tasks 4.6–4.13 change SQL that
**every existing search executes**: `scopeWhere` and `scopeCondition` now emit
`project_id IN (…)` at all 21 call sites, the dense branch reads
`partition_key IN (…)`, and the page order gained two comparator terms. None of
that is reachable as a _widening_ yet — the `across_projects` argument is task
5.1's — so what this smoke has to establish is the other half: **an upgrade does
not change what an installed deployment's ordinary search returns.**

`evidence/upgrade-smoke-4-1-to-4-5.md` covers the `project.list` filter move.
**Task 6.3 still owes the containerised smoke on a real Docker volume**; this one
runs the server from source, and says so below.

## Instrument

Two arms, one probe, one corpus. Each arm copies the **same pre-existing data
directory** — `data-dev.backup-20260805-0435`, taken before this branch existed —
into a fresh directory, boots a real server process
(`src/server-entrypoint.ts`) on it, and probes through the MCP SDK's
`StreamableHTTPClientTransport`, so every call passes the tool's zod schema.
`dev:docker:up` is not a valid instrument here: it runs `seed-dev --reset` on
every boot and therefore has no pre-existing data.

- **before** — the six changed source files checked out at `84ca765`, the commit
  before task 4.6.
- **after** — the same files at this branch's HEAD.

The working tree was restored with `git checkout HEAD -- apps/server/src` and
`git status --porcelain` confirmed empty afterwards.

Both arms are genuine upgrades rather than fresh installs: each boot log reads
`[migrate] applying 0032_token_projects.sql`.

Corpus, non-zero so no assertion below is vacuous:

```
[bootstrap] counts: memory=38 projects=2 sessions=5 tokens=4 prompts=0
memory by project: demo=35 default=3
```

## What was probed

Twelve reads per arm, all narrow, all through `/mcp/<slug>`: five text queries
(`rembric`, `docker`, `search`, `token project`, `memory`) and the no-query
chronological listing, on each of the two projects, plus `project.list` and a
`memory.search({across_projects: true})`. Ids were captured **in page order**, so
a ranking move would show as well as a membership one — the new tiebreak is
exactly the kind of change a set comparison would hide.

## Result — byte-identical

```
diff probe-before.json probe-after.json   →   no output
```

Non-vacuity: `demo` answers every query with between 2 and 8 ordered rows
(`docker` returns 6, the listing returns the full page of 8). The `default`
project holds 3 memories none of which match these queries, so its empty pages
carry no information and the load-bearing arm is `demo`.

`memory.search({across_projects: true})` is refused identically in both arms with
`-32602 unrecognized_keys` — the argument is task 5.1's, so the strict schema
fail-closes on the name. That is also the rollback behaviour the migration plan
predicts, observed rather than argued.

## Row census

| table              | pristine | before | after |
| ------------------ | -------: | -----: | ----: |
| `memory`           |       38 |     38 |    38 |
| `projects`         |        2 |      2 |     2 |
| `sessions`         |        5 |      5 |     5 |
| `memory_relations` |       24 |     24 |    24 |
| `memory_entities`  |        1 |      1 |     1 |
| `tokens`           |        3 |      4 |     4 |

The extra token in each arm is the `*` token the probe mints for itself.
`confirmations` is 0 in all three, so its equality carries no information;
`memory`, `memory_relations` and `sessions` are the load-bearing rows.

## What this does NOT establish

- **Not the Docker image path.** Both arms ran from source in this worktree.
  Task 6.3 owes the containerised upgrade on a real volume.
- **Not the widening.** No widened search was issued, because none can be until
  task 5.2 wires the argument. What is established is that the SQL shape change
  underneath it is invisible to an existing deployment.
- **Not latency.** This is an identity check, not a timing one. Task 0.2 owes the
  phase-4 re-run of `narrow-path-e2e.mjs` against its committed +15% tolerance,
  and it is the instrument for that question — not this one.
- **Not a rollback.** `0032` was applied forward on both copies and not reversed;
  task 6.4 owns that.
