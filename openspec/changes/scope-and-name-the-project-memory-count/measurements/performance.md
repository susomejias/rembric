# Performance of the per-scope loop (task 5 — the number design D1 deferred)

Design D1 chose the N-query loop on clarity and deferred the measurement. This is it.

**Instrument (one per table, named).** A throwaway harness inside `apps/server`, run
with `tsx`, that boots the real server via `createServer` (FakeEmbedder, temp data dir,
admin token) and drives `project.list` over the official MCP SDK `Client` on
`StreamableHTTPClientTransport` against loopback — the same boundary
`mcp-integration.test.ts` uses, and the boundary a real client waits on. The corpus is
seeded with raw prepared `INSERT`s: `PROJECTS` projects × 400 `memory` rows each, of
which a third are non-`active` (alternating `archived`/`superseded`), so the status
filter always has work to do. 20 warm-up calls, then 200 timed calls; `performance.now()`
around `client.callTool`. Host: this dev machine, single run per cell. The harness was
deleted after the run (`git status` clean).

**"before" = the pre-change shape** (`countByProject()`, one grouped query, all
statuses), re-applied to the working tree for the duration of the measurement and then
restored byte-identically. **"after" = the landed per-scope loop.**

## 5.1 `EXPLAIN QUERY PLAN`

Captured on both corpora (5 projects/2 000 rows and 50 projects/20 000 rows); identical
plans at both sizes.

New statement — `SELECT count(*) FROM memory WHERE (scope = 'project' AND project_id = ?) AND status = 'active'`:

```
SEARCH memory USING COVERING INDEX memory_scope_project_status_created_idx (scope=? AND project_id=? AND status=?)
```

Old statement — `SELECT project_id, count(*) FROM memory WHERE project_id IS NOT NULL GROUP BY project_id`:

```
SCAN memory USING COVERING INDEX memory_scope_seen_idx
USE TEMP B-TREE FOR GROUP BY
```

Design D1's prediction holds: the new predicate is a left-prefix range on
`memory_scope_project_status_created_idx`, an index **range**, not a table scan. No
`SCAN memory`. The shape it replaces was the one doing a full index scan plus a temp
B-tree sort.

## 5.2 End-to-end `project.list` wall-clock

The figure a caller waits on. ms, over 200 calls after 20 warm-ups, per-call.

| corpus                           | shape  | p50   | p90   | p99   | min   | max   |
| -------------------------------- | ------ | ----- | ----- | ----- | ----- | ----- |
| 5 projects / 2 000 memory rows   | before | 2.534 | 2.920 | 3.957 | 1.314 | 4.435 |
| 5 projects / 2 000 memory rows   | after  | 2.641 | 3.445 | 4.590 | 1.291 | 4.976 |
| 50 projects / 20 000 memory rows | before | 4.400 | 4.903 | 6.276 | 3.105 | 6.649 |
| 50 projects / 20 000 memory rows | after  | 4.222 | 5.685 | 8.705 | 2.773 | 9.349 |

Deltas at p50: **+0.107 ms (+4.2 %)** at 5 projects, **−0.178 ms (−4.0 %)** at 50
projects — i.e. the loop is nominally slower at the realistic size and nominally faster
at the unrealistic one, in both cases by less than the spread between the two "before"
rows. On a single run per cell that is noise, not signal: the JSON-RPC/SSE round trip
dominates both shapes.

## Isolated statement cost — a DIFFERENT instrument, stated separately

Mean over 2 000 iterations after 50 warm-ups, `better-sqlite3` prepared statements
called directly, no transport. **Do not read this row against the table above.**

| corpus                           | N-query loop over all projects | one grouped query (old shape) |
| -------------------------------- | ------------------------------ | ----------------------------- |
| 5 projects / 2 000 memory rows   | 0.0313 ms                      | 0.1582 ms                     |
| 50 projects / 20 000 memory rows | 0.3222 ms                      | 1.6409 ms                     |

At the statement level the loop is ~5× **cheaper** than the grouped query it replaces,
at both sizes — the index range beats the scan-plus-temp-B-tree by more than the
per-statement overhead of doing it N times. That is where the real signal is, and it
points the same way at 10× the project count.

## 5.3 Conclusion

**The N-query loop is not materially worse than the grouped query it replaced at the
realistic project count — at the statement level it is roughly 5× cheaper, and
end-to-end the difference is inside run-to-run noise.** Design D1's fallback
(`countActiveByProjectIds(projectIds)`) is therefore not reached for, and no
`data-access` spec amendment is required.

## 5.4 No index added

None. The predicate already matches an existing index as a left prefix (5.1). Nothing
in the measurement suggests one.
