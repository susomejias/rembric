## Context

`memory.context` returns five lists; with the current defaults a full snapshot is ~4–4.5k tokens worst case, and ~64% of that is `recentMemories` (20×350) + `recentPrompts` (10×350). The signal an agent needs to orient at session start is the _top few_ of each, not the long tail. The cheapest lever — chosen here — is to halve the default list sizes; the snippet cap and clamp maxima stay so nothing is actually lost, only the default verbosity.

## Goals / Non-Goals

**Goals:**

- Materially cut the typical `memory.context` payload (recurring per session start) by shrinking the default list sizes.
- Preserve every capability: callers can still request the old sizes explicitly (same clamp maxima).

**Non-Goals:**

- **No snippet-cap change.** The 350-char per-row cap stays; the operator asked to trim list sizes, not truncate content further. (Snippet tuning would be a separate lever with its own readability trade-off.)
- **No change to `needsReview` (≤3) or `pendingJudgments` (≤5).** `needsReview` is already minimal; `pendingJudgments` is sporadic and actionable.
- **No clamp-maxima change.** `sessions ≤ 25`, `prompts ≤ 50`, `memories ≤ 100` and the `clamped:true` flag are untouched — power users keep the ceiling.
- **No shape change.** Same fields, same ordering, same filters.

## Decisions

### D1: Halve the three list defaults, keep everything else

| List             | Old default | New default | Rationale                                                           |
| ---------------- | ----------- | ----------- | ------------------------------------------------------------------- |
| `recentMemories` | 20          | **10**      | biggest payload contributor; 10 recent memories is plenty to orient |
| `recentPrompts`  | 10          | **5**       | last 5 prompts give intent without the tail                         |
| `recentSessions` | 5           | **3**       | 3 most-recent content-bearing sessions is enough for handoff        |

`needsReview` stays 3, `pendingJudgments` stays ≤5, snippet stays 350.

**Why defaults and not the snippet:** halving list sizes removes whole rows (each ~350 chars + metadata), a bigger and cleaner cut than shaving the snippet, and it keeps each surfaced row fully readable. The operator's instinct ("the call gets heavy") is about volume of rows, which this targets directly.

### D2: Maxima unchanged — this is a default, not a cap

Shrinking the default while keeping the clamp ceiling means the change is non-destructive: any caller that needs the old breadth passes `memory.context({ memories: 20, prompts: 10, sessions: 5 })` and gets exactly the prior behaviour. The `clamped:true` flag still trips only above the maxima, so its contract is unchanged.

## Risks / Trade-offs

- **An agent might miss an older memory** that previously fell in rows 11–20. Mitigated by: (a) `memory.search` is the right tool for targeted recall anyway, (b) the agent can pass a larger `memories` arg, (c) review/judgment signals (`needsReview`, `pendingJudgments`) are size-independent.
- **Tests asserting the old default counts** must be updated to the new defaults (or switched to explicit args). Enumerated in tasks.

## Migration / rollout

None. No schema, no data, no migration — a three-literal default change on a read tool. Additive-compatible: explicit-arg callers see no difference.
