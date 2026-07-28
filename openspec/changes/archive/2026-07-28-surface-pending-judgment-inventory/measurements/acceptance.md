# Acceptance (task 5.2)

Run against `pnpm run dev:docker:up` (image `rembric-dev:local`, mounts verified
to point at this worktree), over the real MCP transport at `/mcp/demo`. Not run
against the author's instance: that instance's `rembric` scope holds 0 pending
pairs (`before.md` §0.2), so it cannot exercise a drain.

The backlog was manufactured the way real backlogs form — six near-duplicate
`memory.save` calls, letting save-time candidate detection open the relations —
rather than by inserting rows directly.

## The drain

```
default call        -> list=0  total=31
judgments:31        -> list=31 total=31
first row carries   -> judgmentId=true
                       sourceTitle="Dump journal_mode + busy_timeout pragmas for flaky tests"
                       targetTitle="Read the SQLite WAL first when debugging flaky tests"
                       snippets=true  ageMs=40524
youngest row ageMs  -> 169            (orphanAfterMs = 86_400_000)
judged              -> 31
after drain         -> list=0  total=0
memory.stats        -> pendingJudgmentsTotal=0
```

Line 1 is the defect, reproduced on the new code with the new field beside it:
the default channel returns an **empty list** — which on the old code was the
only reading available, and reads as "the queue is empty" — while
`pendingJudgmentsTotal` says **31**. Every one of those 31 was younger than
`JUDGMENT_ORPHAN_AFTER_MS` (the youngest by 169 ms), so on the old code none was
reachable from any MCP surface: `memory.judge` needs a `judgmentId` the aged
list never emitted for them, and `memory.compare` needs both memory ids up
front.

Line 2 is the fix. Asking for the total returns all 31, each carrying both
endpoints' ids, titles and snippets — enough to judge from the response with no
second read (task 2.7 over the wire). Lines 5–7 are the acceptance criterion:
judged in one pass, after which the list AND the total both reach 0, and the
independent scoped counter `memory.stats.pendingJudgmentsTotal` agrees.

## Bounds and scope, over the wire

| Case                                 | Expected                           | Result                                                                                                                                     |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/list` schema for `judgments`  | integer, 0–50, described           | `{"type":"integer","minimum":0,"maximum":50,"description":"How many pendingJudgments[] to return. Passing it also LIFTS the age filter…"}` |
| `memory.context` description length  | ≤ `DESCRIPTION_MAX_LENGTH`         | 1231 / 1900                                                                                                                                |
| `{judgments: 999}`                   | rejected at the transport          | `-32602 Input validation error … "code":"too_big","maximum":50`                                                                            |
| `{judgments: -1}`                    | rejected at the transport          | `-32602 Input validation error`                                                                                                            |
| `{judgments: 50}` on `/mcp` (global) | the demo project's pendings hidden | `list=0 total=0`                                                                                                                           |

The out-of-range rejection is the SDK validating the declared input schema
before the handler runs, so the handler's `clamped: true` never surfaces over
MCP. That is **pre-existing and identical for the three sibling arguments** —
`{sessions: 999}` and `{memories: 9999}` were probed in the same session and
returned the same `-32602 too_big` with maxima 25 and 100. `judgments` inherits
the layering rather than inventing one; the delta records it explicitly instead
of restating the published clamp scenario as if the wire behaved that way.
