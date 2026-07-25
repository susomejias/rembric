## Why

`last_seen_at` currently means "was returned by a query", and three independent mechanisms read it as if it meant "is useful":

1. `memory.search` touches **every** returned row (default eight per search), unconditionally — only the HTTP passive-recall path opts out.
2. The post-fusion ranking boost adds `+0.1` when that timestamp is under seven days old.
3. Decay eligibility requires it to predate a per-type window of 180 / 365 / 730 / 3650 days.
4. `memory.context.recentMemories` orders by it.

So ranking high extends a memory's lifetime, raises its future rank, and pins it to the top of every subsequent context pull — regardless of whether the agent read past its title. At roughly ten searches per session a 500-memory corpus is fully touched within weeks, after which the decay sweep is a permanent no-op and `memory.context` degenerates from "recently learned" to "recently retrieved". The top of the ranking ossifies: incumbents accrue confirmations while a newly-saved, genuinely better memory starts from zero.

The mirror image is worse. There is **no negative signal at all**. `memory.confirm` only ever affirms; `memory.archive`'s description explicitly forbids autonomous use, and that constraint is load-bearing in the spec. So when recall surfaces a memory, the agent acts on it, and it turns out stale or wrong, the agent's only legal moves are to save a corrective row or do nothing — and the act of retrieving the bad memory has just reset its decay clock. **Bad memories are systematically made more durable than untouched good ones by the very interaction that proved them wrong.**

Together these leave a permanent, monotonically growing limbo: a frequently-recalled memory that nobody re-affirms crosses its review TTL, sits `needs_review` forever (reads deliberately do not clear it), cannot be archived by the sweep (reads keep it immune), and nothing else acts. The two staleness axes do not cover the middle case, and that population only grows.

This change decides what "access" means and gives the agent a way to say "this was not useful" — which is the missing input that makes the derived-review axis two-sided without adding a mutation verb or a stored state.

## What Changes

- **Split _returned_ from _used_.** `memory.search` returning a row in a page of eight is not evidence that the row was useful. Dereferencing it via `memory.get` is much closer. The search-path touch is narrowed, so broad triage scans stop inflating the recency signal — the same reasoning already applied deliberately to the HTTP passive-recall path.
- **Fix the touch-set bug found alongside it.** `search` touches the ids it _retrieved_, not the ids it _returned_: rows dropped by the live-status re-check get their `last_seen_at` bumped despite never reaching the caller.
- **Add a negative affirmation event.** An append-only refutation — "I surfaced this and it was wrong or stale" — recorded as an event, most likely on the existing confirmations channel with a sign so no migration is needed. It SHALL NOT extend `last_seen_at`, and it feeds `deriveReviewState` so a refuted memory becomes `needs_review` immediately instead of waiting out its TTL. Review state stays **derived, never stored** — a refutation is an input to the derivation, so the invariant holds.
- **Give the review queue a terminal state.** Decide what happens to a memory that has been `needs_review` for some multiple of its TTL while being read regularly. Today: nothing, forever. This is the genuine semantic gap and the reason the change needs discussion before code.
- **Surface the queue's depth.** `memory.context` returns the three oldest needing review and no total; `memory.stats` and the doctor report carry no review or pending-judgment counts at all — even though the count is already computed for the dashboard sidebar. An agent that knows the queue is 800 deep can batch-confirm with the `ids` form it already has; an agent that sees three items cannot tell the difference between a healthy corpus and a collapsing one.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory`: the meaning of the `last_seen_at` touch on the search path; refutation as a second input to the derived review axis; a terminal state for the review queue.
- `consolidation`: decay eligibility stops being effectively unreachable for any memory that is ever retrieved.
- `mcp-api`: a refutation verb (or a verdict argument on the existing confirm tool); review and pending-judgment totals on `memory.context` and `memory.stats`.

## Impact

- `apps/server/src/services/memory.ts` — the `touch` default on the search path; the retrieved-vs-returned touch set; refutation recording
- `apps/server/src/services/review.ts` — refutation as a derivation input; terminal state
- `apps/server/src/consolidation/decay.ts` — eligibility once the access signal is sparser
- `apps/server/src/services/hybrid-search.ts` — the recency term now reads a sparser signal
- `apps/server/src/db/schema/confirmations.ts` — a sign or kind column, if the existing table carries the negative event
- `apps/server/src/mcp/memory-tools.ts`, `observability-tools.ts` — the verb and the totals
- `apps/server/src/db/repositories/memory-repository.ts` — reuse `adminCountNeedsReview` for the agent-facing total

Depends on: `add-retrieval-eval-harness`. Narrowing the touch changes what the recency boost sees and therefore what search returns, so the effect must be measured, not reasoned about.

Invariants: append-only is preserved — a refutation is an inserted event, not an update, and no memory row is deleted or rewritten. "Review state is derived, never stored" is preserved: refutation is an input to the read-time derivation, not a persisted state. The **deliberate** design that reading does not clear `needs_review` is preserved.

## Open decision (resolve before implementing)

This change carries a genuine product question and SHOULD be explored before tasks are executed:

1. Does the search path stop touching entirely, touch only the top result, or keep touching while decay and the recency boost move to a sparser signal such as confirmations?
2. Should a memory that has been `needs_review` for `k` × its TTL escalate — surface unconditionally in context, or become decay-eligible despite recent reads — or is permanent limbo acceptable?
3. Is refutation a new tool or a `verdict` argument on `memory.confirm`? The tool budget argues for the argument; clarity of the model-facing contract argues for the tool.

The spec deltas below state the requirements that hold under **any** resolution; the choices above determine the implementation and are recorded in `design.md` as unresolved.
