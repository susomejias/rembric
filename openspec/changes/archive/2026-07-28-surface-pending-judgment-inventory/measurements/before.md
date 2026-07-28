# Before-picture (tasks 0.1–0.3)

Measured 2026-07-28 against the author's live instance through the MCP surface
(`/mcp/rembric`, path-scoped). The instance is remote; its SQLite file is not
reachable from the development host, so every number below is what an agent can
actually observe — which is the point of the measurement.

## 0.1 — the four numbers

| Reading                                      | Value |
| -------------------------------------------- | ----- |
| `memory.doctor` → `review.pendingJudgments`  | 52    |
| `memory.stats` → `pendingJudgmentsTotal`     | 0     |
| `memory.context` → `pendingJudgments.length` | 0     |
| Pairs judgeable from the response            | 0     |

The earlier run recorded in memory `01KYMP1X83872XZRMFYRE9RJXH` is the fuller
sequence: doctor 52 → context returned 5, 5, 5, then 0 → doctor still 37. That
run is the observation this change exists for and it is not re-run here, because
re-running it means judging real pairs on a live corpus for a measurement that
was already taken.

## 0.2 — `countPendingInScope` does NOT equal what the doctor reports

**It does not, and the reason is by design rather than a defect.**
`memory.doctor` reports `repos.relations.adminCountByStatus('pending')` —
**server-wide** (`apps/server/src/server/bootstrap.ts:563`), a deliberate spec
exception carried in the comment at `bootstrap.ts:555-557`. `memory.stats`
reports `countPendingInScope` — **scoped** (`observability-tools.ts:270`). Two
different populations, printed with the same word.

So on this instance the 52 pending pairs live outside the `rembric` project
scope (global scope and/or other projects), and the scoped queue for `rembric`
is genuinely empty. The `52 vs 5` framing in `proposal.md` therefore conflates a
server-wide number with a scoped list: part of that gap is the scope boundary,
not the age filter.

**This does not make the change premature**, and the reason is that the gap it
fixes is structural rather than numeric. Independent of any count:

- `listPendingOlderThanInScope` (`relations-repository.ts:376`) filters
  `createdAt < cutoff` unconditionally, and `handleContext` passes
  `now - JUDGMENT_ORPHAN_AFTER_MS` with `limit: 5` hard-coded
  (`memory-tools.ts:1299-1306`).
- `memory.judge` requires a `judgmentId`, which only `memory.save.candidates[]`
  or that aged list ever emits; `memory.compare` requires both memory ids up
  front, so it cannot discover a pair.

A pending pair younger than the cutoff is therefore unreachable from every MCP
surface, in every scope, whatever the doctor prints. That is provable from the
code and is what the change closes.

The scoped/server-wide collision is recorded as a deferred follow-up in
`tasks.md` §6.3 — it is a documented exception that nevertheless misled the
author's own diagnosis, which is evidence about the naming, not about the queue.

Consequence for acceptance (task 5.2): the live `rembric` scope has an empty
queue, so the drain-to-zero test cannot be run there. It is run against the dev
stack with a seeded queue instead.

## 0.3 — the asymmetry, in line numbers

| Channel                 | Declared (`contextOutput`) | Computed (`handleContext`) |
| ----------------------- | -------------------------- | -------------------------- |
| `pendingJudgments`      | `memory-tools.ts:416`      | `memory-tools.ts:1300`     |
| `needsReview`           | `memory-tools.ts:428`      | `memory-tools.ts:1322`     |
| `needsReviewTotal`      | `memory-tools.ts:443`      | `memory-tools.ts:1330`     |
| `pendingJudgmentsTotal` | — (absent)                 | — (absent)                 |

Twenty-seven declaration lines apart, one queue channel carries its total and
the other does not.
