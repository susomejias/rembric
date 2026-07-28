## Why

`memory.context` returns two queue channels. `needsReview[]` carries `needsReviewTotal` beside it. `pendingJudgments[]` carries nothing — and it is an AGED channel, listing only pairs past a surfacing threshold, five at a time. So a reader of the response cannot tell whether it is seeing the queue or a slice of it, and there is no parameter to ask for more: `memories`, `prompts` and `sessions` all take a size; `pendingJudgments` is the only channel that does not.

Reproduced on the author's own instance on 2026-07-28. `memory.doctor` reported **52** pending judgments. `memory.context` returned 5. Three rounds of judging returned 5, 5, 5, then **0** — at which point the honest reading is "the queue is empty", and the doctor still reported 37. The remaining pairs exist, are inside the 14-day window before the sweep orphans them, and **no MCP surface can enumerate them**: `memory.judge` needs a `judgmentId` that only `memory.save.candidates[]` or the aged channel hands out, and `memory.compare` needs both memory ids up front so it cannot discover a pair.

An agent can therefore close a judgment at save time, or once it has aged — never in between. The backlog drains at the rate it ages, five at a time, while every `memory.save` can add five more.

## What Changes

- **`memory.context` reports `pendingJudgmentsTotal`, beside the slice it returns.** The number already exists: `RelationsRepository.countPendingInScope` is already implemented and already scoped, and `memory.stats` and `memory.doctor` already return it. What is new is carrying it where the LIST is, so a reader of the list knows what it is a fraction of. This is not a new idea in this response shape — it is the symmetry `needsReviewTotal` already has seven lines away in the same schema.
- **`memory.context` accepts a `judgments` size, and an explicit size lifts the age filter.** The aged filter is right for the default: a queue-depth warning should not be noisy with pairs created seconds ago. It is wrong as the ONLY reachable view, because it makes the younger pairs unenumerable. Asking for a size is the caller stating it wants inventory rather than a warning, so that is the signal that suppresses the filter — rather than a second `includeUnaged` flag that would have to be kept in step with it.
- **The tool description documents both**, within `DESCRIPTION_MAX_LENGTH`. A parameter nobody knows about is not a surface. Rejected: **a new MCP tool.** Every tool costs a full description against a budget this repo deliberately cut 17.1 KB from; a parameter costs a clause.

Deliberately **not** in scope:

- **The instructions block.** It already says `resolve candidates[] with memory.judge`, so the save-time discipline that prevents accumulation is already written; what is missing is a way to drain what accumulated. The block also sits at 965/1000 characters, and spending its remaining 35 on a behavioural lever this change does not measure would be two changes wearing one coat.
- **Lowering the candidate fan-out, or hardening the save-time instruction.** These attack the accumulation RATE rather than the drainability, and they are the higher-value lever — the 15 judgments drained on 2026-07-28 all existed because earlier saves left `candidates[]` unresolved. But changing either alters model behaviour, and that needs its own before/after evidence rather than being asserted here.
- **Bulk or automatic judging.** A judgment's value is that someone compared the two memories; a wrong `supersedes` archives a real memory. Making the queue drainable is the goal, not making it self-emptying.
- **Any plugin change.** `memory.context` is server surface and the parameter lives in its zod schema. None of the four clients is touched.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-api` — `memory.context`'s `pendingJudgments` channel gains a total and a size, and the size lifts the age filter.
