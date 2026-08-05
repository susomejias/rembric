# Upgrade smoke for tasks 4.1–4.5, against pre-existing seeded data

Tasks 4.1–4.5 add a type, a construction site and a grep gate. Exactly one of
them is reachable from a live MCP tool: `project.list`'s authorization filter
moved into the shared `readableProjects`, which the widened set also uses. That
is the change this smoke exercises. **Task 6.3 still owes the full containerised
smoke** — this is narrower, and its scope is stated below.

## Instrument

A real server process (`src/server-entrypoint.ts`, not a harness) on a **copy of
a pre-existing data directory** taken before this branch existed
(`data-dev.backup-20260805-0435`), probed through the MCP SDK's
`StreamableHTTPClientTransport` so every call passes the tool's zod schema.
`dev:docker:up` is not a valid instrument for this: it runs `seed-dev --reset`
on every boot, so it has no pre-existing data.

The volume is genuinely older than the image: the boot log reads
`[migrate] applying 0032_token_projects.sql`, so this is an upgrade path and not
a fresh install.

Corpus, non-zero on both sides so no assertion below is vacuous:

```
[bootstrap] counts: memory=38 projects=2 sessions=5 tokens=3
```

## What was measured

| probe                                           | result                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `project.list` on a `*` token                   | `demo` (18 active) and `default` — both projects                      |
| `project.list` on a `read:project:<demo>` token | `demo` only — the control that the filter is doing work               |
| `memory.search` at `/mcp/demo`, `*` token       | 2 rows, every `projectId` the demo project's                          |
| `memory.search` at `/mcp/demo`, pinned reader   | the same 2 rows — the narrow path is unchanged for a restricted token |
| `memory.search({across_projects: true})`        | refused, verbatim below                                               |

```
MCP error -32602: Input validation error: Invalid arguments for tool memory.search: [
  {
    "code": "unrecognized_keys",
    "keys": [ "across_projects" ],
    …
```

The refusal is the expected state at this point in the change: the argument is
task 5.1's, so the widening has no wire entry yet and the strict schema
fail-closes on the name. It is also the rollback behaviour the migration plan
records, observed here rather than predicted.

## Row census, before against after

Read from the untouched backup and from the upgraded copy:

```
memory             before=38 after=38 EQUAL
projects           before=2  after=2  EQUAL
sessions           before=5  after=5  EQUAL
memory_relations   before=24 after=24 EQUAL
confirmations      before=0  after=0  EQUAL
memory_entities    before=1  after=1  EQUAL
tokens             before=3  after=5  (two minted by the probe itself)
```

## What this does NOT establish

- Not the Docker image path. The server ran from source in this worktree; task
  6.3 owes the containerised upgrade on a real volume.
- Not the widening. No widened search was issued because none can be: the
  argument does not exist and `resolveSearchScope` has no caller until 5.2.
- Not a rollback. `0032` was applied forward on this copy and not reversed.
- The `confirmations` and `memory_entities` counts are 0 and 1, so their
  equality carries almost no information; `memory`, `memory_relations` and
  `sessions` are the load-bearing rows here.
