## Why

`memory.context` is read at session starts (and post-compact), so its payload is a **recurring** token cost. Measured against the current defaults, the weight is dominated by the list sizes, not the snippet cap:

| List               | Default          | Snippet | ~tokens                    |
| ------------------ | ---------------- | ------- | -------------------------- |
| `recentMemories`   | **20**           | ≤350    | ~2000 (≈44%)               |
| `recentPrompts`    | **10**           | ≤350    | ~900 (≈20%)                |
| `recentSessions`   | **5**            | ≤350    | ~500 (≈11%)                |
| `pendingJudgments` | ≤5 (×2 snippets) | ≤350    | ~940 (only when populated) |
| `needsReview`      | ≤3               | ~140    | ~150 (≈3%)                 |

A bootstrap snapshot rarely needs 20 memories + 10 prompts to orient an agent; the long tail is noise that costs ~2× what a tight snapshot would. This change halves the default list sizes so a typical `memory.context` call is materially cheaper, without removing any capability — callers that genuinely want more still pass explicit args (the clamp maxima are unchanged).

## What Changes

- `memory.context` default list sizes drop:
  - `recentSessions`: `sessions ?? 5` → `sessions ?? 3`
  - `recentMemories`: `memories ?? 20` → `memories ?? 10`
  - `recentPrompts`: `prompts ?? 10` → `prompts ?? 5`
- **Unchanged:** the per-list snippet cap (≤350), the clamp maxima (`sessions ≤ 25`, `prompts ≤ 50`, `memories ≤ 100`), the `clamped:true` flag behaviour, `pendingJudgments` (≤5), and `needsReview` (≤3, snippet ~140). Explicitly-passed arguments are honoured exactly as before — only the _absent-arg defaults_ shrink.

## Capabilities

### New Capabilities

_None._ This tightens defaults on an existing `mcp-api` requirement.

### Modified Capabilities

- `mcp-api`: the `memory.context` research-tool contract's default list sizes change to `sessions=3`, `memories=10`, `prompts=5`. Maxima, snippet cap, and the other lists are unchanged.

## Impact

Affected code:

- `apps/server/src/mcp/sessions-tools.ts` — three `?? N` default literals in `handleContext` (`sessionsLimit`, `memoriesLimit`, `promptsLimit`).

Affected APIs:

- MCP `memory.context` — smaller default payload when sizes are omitted. No shape change; no field added or removed.

Load-bearing invariants touched: **none.** Pure default-size tuning on a read tool; no scope, persistence, or lifecycle change.

Compatibility: callers passing explicit `{ sessions, prompts, memories }` are unaffected. Callers relying on the old implicit sizes receive fewer rows — acceptable for a bootstrap snapshot, and they can opt back up via explicit args (still clamped to the same maxima).
