## Context

`last_seen_at` is written by five semantically different events — insert, get, search, confirm, archive — and read by three mechanisms that treat it as a usefulness signal: the recency term in the ranking boost, decay eligibility, and `memory.context` ordering. The result is a closed loop with no dampening: ranking high extends lifetime and future rank.

Two measurements bound the problem. Decay windows are 180 / 365 / 730 / 3650 days by type, with a confirmation floor of 1 — so anything retrieved even occasionally is effectively permanently decay-immune. And a default search touches eight rows, so at ordinary usage a few-hundred-memory corpus is fully touched within weeks.

The mirror gap is the absence of any negative verb, which means the one interaction that *proves* a memory wrong is also the one that extends its life.

## Goals

- Decide what "access" means and make one signal serve one purpose.
- Give the agent a legal, append-only way to say "this was not useful", without granting it autonomous archival — a constraint the spec deliberately makes load-bearing.
- Close the permanent-limbo case: read regularly, never re-affirmed, un-archivable.
- Make queue depth visible so batch affirmation is possible.

## Non-Goals

- Autonomous archival by the agent. Refutation feeds the derived review axis; it does not retire anything.
- Storing review state. It stays derived at read time; refutation is an input.
- Changing the deliberate rule that *reading* does not clear `needs_review`.
- Changing fusion constants — that is `fix-retrieval-ranking-math`.

## Decisions

**Decision 1 — One signal, one purpose.**
The cheapest defensible split: stop advancing the access signal on the search path (or advance it only for the top result), keep advancing it on `memory.get`, which is the closest available proxy for dereferencing. The precedent already exists in the codebase — the HTTP passive-recall path deliberately passes `touch: false`, on exactly this reasoning. This change generalises an argument the repo has already accepted in one place.

**Decision 2 — Fix the retrieved-vs-returned touch set regardless of the outcome.**
Independent of the product question: search currently touches the ids it retrieved, not the ids it returned, so rows dropped by the live-status re-check are touched despite never reaching the caller. That is a plain bug and lands whatever is decided about the touch policy.

**Decision 3 — Refutation rides the existing confirmations channel.**
A signed or kinded event on `confirmations` avoids a new table, and the derivation already reads that table for the affirmation baseline. It is also honest about the symmetry: affirmation and refutation are the same kind of fact with opposite sign. The alternative — a separate table — buys nothing and doubles the read.

**Decision 4 — Refutation must not advance the access signal.**
This is the whole point. If refuting a memory touched `last_seen_at`, the change would recreate the loop it exists to break: proving a memory wrong would extend its life. Spelled out as its own scenario because it is the easy thing to get wrong in implementation.

**Decision 5 — Escalation must stay derived.**
Any terminal state for the review queue has to be computable at read time from `(created_at, confirmation events, refutation events, type)`. A stored escalation flag would need a sweep to maintain and would contradict the standing guarantee. This constrains the design space usefully: escalation can only be a function of data already present.

**Decision 6 — Sequence behind the eval harness.**
Narrowing the touch changes what the recency term in the ranking boost sees, which changes what search returns. The audit's own conclusion applies here: this must not be a silent code tweak, because it also changes the observable behavior of the deterministic consolidation sweep, which is a load-bearing invariant.

**Decision 7 — Explore before implementing.**
Unlike the other three changes, the central question here is not "what is broken" but "what should the semantics be". The three open questions below materially change the implementation, and answering them by fiat in a proposal would be the wrong call.

## Risks

- **The sweep starts archiving things.** Today decay is nearly inert; a sparser access signal makes it actually fire. That is the intent, and it is also the largest behavioral change in this change set. Everything the sweep does is journaled and reversible — and `fix-audited-defects` makes that undo durable, which is a prerequisite in practice even if not a formal dependency.
- **Refutation gets used as a cleanup verb.** The tool description must steer as firmly as `memory.archive`'s does, or agents will refute in bulk while tidying. Mitigated by refutation being non-destructive: the worst outcome is an over-full review queue, not lost memories.
- **Consolidation tests will need rework.** They encode the current decay behavior, so they must move deliberately rather than being adjusted until green.
- **Queue depth may be discouraging.** Exposing a total of 800 to an agent could trigger unhelpful bulk-confirm behavior — affirming without actually re-verifying, which is worse than silence because it advances the baseline on false evidence. The tool description matters as much as the number.

## Migration

Possibly none: if refutation is a signed event on the existing table, the column may already accommodate it. Otherwise one additive column. No table rebuild, no memory row touched.

## Open Questions

These are the change's substance and should be resolved in exploration before tasks are written:

1. **Touch policy.** Stop touching on search entirely, touch only rank 1, or keep touching but move decay eligibility and the recency boost onto a sparser signal (confirmations)? The third preserves `memory.context` ordering as-is, which may be desirable independently.
2. **Terminal state.** Does a memory `needs_review` for `k` × TTL surface unconditionally in context, become decay-eligible despite recent reads, or something else? "Nothing, forever" is the status quo and is probably an unintended gap rather than a deliberate choice — worth confirming before building.
3. **Verb shape.** A new `memory.flag_stale` tool, or a `verdict: 'affirm' | 'refute'` argument on `memory.confirm`? The tool budget and the four confusable-tool clusters the audit identified argue for the argument. The clarity of a distinct model-facing contract argues for the tool.
4. **Does `memory.context` ordering keep using the access signal?** If it does, and the signal becomes sparse, "recent" starts meaning "recently dereferenced", which is arguably the correct meaning all along.
