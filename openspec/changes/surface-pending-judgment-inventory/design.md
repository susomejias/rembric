## Context

`memory.context`'s output schema (`apps/server/src/mcp/memory-tools.ts`) declares `pendingJudgments` at :416 and `needsReviewTotal` at :443; the handler computes `pendingJudgments` at :1300 from `RelationsRepository.listPendingOlderThanInScope` and `needsReviewTotal` at :1330. So one queue channel is paired with its total and the other is not, inside twenty-seven lines of one schema.

`listPendingOlderThanInScope` takes `cutoffMs` and `limit`, filters `status = 'pending'` and `createdAt < cutoff`, orders by `createdAt` and joins both endpoints' content. `countPendingInScope` sits immediately below it, already implemented and already scoped, and is already consumed by `memory.stats` (`observability-tools.ts:118`) and `memory.doctor` (`:107`).

The input schema takes `focus`, `includeArchived`, `memories`, `prompts` and `sessions`. There is no `judgments`.

Constraints: the tool description is bounded by `DESCRIPTION_MAX_LENGTH = 1900` against the host's truncation ceiling; ALL SQL stays under `db/`; scope is resolved at the service layer and passed down; the 14-day orphan deadline lives in the consolidation sweep and is not touched here.

## Goals / Non-Goals

**Goals:**

- Make the pending-judgment queue's real depth visible to the caller that is holding a slice of it.
- Make the un-aged pairs reachable, so the backlog can be drained rather than only aged into.
- Keep the default response shape and cost unchanged for callers that do not ask.

**Non-Goals:**

- Changing the accumulation rate (candidate fan-out, or the instruction to close at save time). Higher-value, separately measurable, separately shipped.
- Changing the orphan deadline or the sweep.
- Automatic or bulk judging.
- Any plugin or client change.

## Decisions

**D1 — The total is added, not computed anew.**
`countPendingInScope` already exists, is already scoped, and is already the number `memory.stats` and `memory.doctor` report. The handler calls it and returns `pendingJudgmentsTotal`. Rejected: _deriving the total from the returned array_ — it is a page, so its length is exactly the misleading number this change exists to correct.

**D2 — An explicit `judgments` size lifts the age filter; there is no separate flag.**
The default keeps the filter, because the default consumer is an agent starting work and a queue-depth warning should not be noisy with pairs created moments ago. A caller that passes a size is asking for inventory, and inventory that hides most of itself is not inventory.

Alternative considered: _a distinct `includeUnaged` boolean_. Rejected — two knobs whose only sane combinations are (default, filtered) and (sized, unfiltered) is one knob with extra steps, and it invites the fourth combination (`includeUnaged` without a size) that would return an unbounded set.

Alternative considered: _drop the age filter entirely_. Rejected — the filter is what makes the default channel a warning rather than a firehose, and `memory.context` is called at session start on a token budget.

**D3 — The bound is the caller's `judgments` value, clamped like every other channel.**
`memories`, `prompts` and `sessions` are already clamped to documented maxima. `judgments` follows the same pattern rather than inventing an unbounded read; an unbounded pending list on a large corpus is a hot-path read this repo has already been bitten by elsewhere.

**D4 — One repository method, parameterised, not two.**
`listPendingOlderThanInScope` gains the ability to skip the cutoff rather than a sibling `listPendingInScope` being added beside it. Two SQL builders differing in one predicate is how they drift; the `sessionHasContent` predicate in `sessions` is the precedent for parameterising instead of forking.

**D5 — The tool description documents the parameter and the total, and the length is measured.**
A parameter no description mentions is unreachable in practice. The description's measured length and remaining headroom are recorded in `tasks.md`; if the clause does not fit, prose is cut from that description rather than the constant raised — the constant exists because the host truncates above it.

## Risks / Trade-offs

- [Risk] An unbounded-feeling `judgments` value invites a large joined read on the session-start path → Mitigation: clamped like every sibling channel, and the default is unchanged, so a caller pays only for what it asks.
- [Risk] Lifting the age filter surfaces pairs a judge would rather not see yet (created seconds ago, possibly by the very save in flight) → Accepted: the caller asked for inventory. A pair created in this turn is closable from `candidates[]` anyway, so seeing it twice costs nothing.
- [Risk] Adding a field to a documented output shape → Additive and optional to read; no client parses this response positionally.

## Open Questions

- **What is the right clamp for `judgments`?** The sibling maxima are 100 (`memories`), 50 (`prompts`), 25 (`sessions`). The queue observed on the author's instance was 52, which argues against a bound below the low tens. To be chosen against the sibling values rather than invented.
- **Should the default page size stay at its current value once a total is visible?** Once a caller can see "5 of 52" the page size is no longer load-bearing as a signal, so it may be left alone. Not decided here.
