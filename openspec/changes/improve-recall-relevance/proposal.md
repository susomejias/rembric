## Why

Rembric has good hybrid retrieval and **does not use it at the moment it matters most**. `memory.context` — the tool the protocol tells agents to call when starting or resuming work — accepts only counts (`sessions`, `prompts`, `memories`, `includeArchived`) and returns `recentMemories` ordered purely by `last_seen_at`. Nothing about the work at hand influences what comes back. The session-start hook does not inject anything either; it prints a nudge. The one path that *does* run a relevance query is gated behind a keyword matcher (`remember|recall|acuérdate|qué hicimos|what did we do`), so relevant recall only happens if the user says a magic word.

The result: at session start the agent gets the N most recently *touched* memories, not the ones bearing on what it is about to do — and because `last_seen_at` advances on every read, "recent" increasingly means "recently retrieved" rather than "recently learned".

Three smaller gaps compound it, and all four live on the same code path, so they are worth landing together and measuring together:

- **The system cannot abstain.** Search always returns the top-k least-bad rows. A confidently-wrong memory is worse for an agent than no memory, because the agent has no signal to distrust it.
- **One verbose session can monopolise the page.** Nothing caps how many results come from the same session, so a chatty afternoon can crowd out the single memory from three months ago that answers the question.
- **`procedural` knowledge has no home.** The runbook — "how deploys work here", "the dev stack needs this permission fix" — is the highest-value memory class for a coding agent, and it currently shares the `reference` bucket, which has *no* review TTL and a ten-year decay window. Its shelf life is nothing like a bookmark's.

## What Changes

- **`memory.context` gains relevance.** An optional `focus` string runs the existing hybrid search and returns a `relevantMemories[]` channel alongside the recency channel. When `focus` is absent, the server derives a seed from signals it already holds — the session's `cwd`, the active project, and `recentPrompts` — so the improvement does not depend on the agent knowing to ask. The recency channel is unchanged; this is additive, and the two channels are separately labelled so the model knows which is which.
- **The plugin prefetches relevance once per session, not on a keyword.** The keyword matcher stays for explicit recall requests, but the first `UserPromptSubmit` of a session also seeds relevance from the prompt. Bounded, once per session, across all four clients.
- **Recall can abstain.** A score floor plus a gap-ratio tail filter, so result-set size adapts to the score distribution instead of always being `k`. A query with nothing relevant returns nothing and says so (`abstained: true` with a reason), and the tool description instructs the agent not to invent context when it sees that. **Ships off by default** and is calibrated against the eval harness — an untuned floor silently destroys recall, which is exactly the failure this change must not introduce.
- **Results are diversified by session.** At most a small fixed number of results per originating session, walking the fused list in order and backfilling from the skipped remainder if the cap starves the page. Deterministic, ~15 lines, and it directly targets multi-session recall.
- **`procedural` becomes a first-class memory type** with its own review TTL and its own ranking weight, separate from `reference`. Existing rows are untouched; nothing is reclassified automatically, because reclassifying agent-authored memories would be a content judgement the server has no business making.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory`: a `procedural` member of the memory-type enum with its own review TTL and decay window; the recall-abstention rule on the text-query branch; the per-session diversity cap.
- `mcp-api`: `memory.context` accepts `focus` and returns `relevantMemories[]`; the text-query search response can report abstention.
- `claude-code-plugin`, `codex-distribution`, `hermes-agent-plugin`, `opencode-plugin`: a once-per-session relevance prefetch on first prompt, in lock-step across all four clients.

## Impact

- `apps/server/src/mcp/memory-tools.ts` — `contextSchema` gains `focus`; `contextOutput` gains `relevantMemories[]`; abstention on the search output
- `apps/server/src/services/memory.ts` — the relevance channel; seed derivation from cwd/project/recentPrompts
- `apps/server/src/services/hybrid-search.ts` — score floor, gap-ratio filter, per-session diversity cap
- `apps/server/src/services/review.ts` — `procedural` TTL
- `apps/server/src/consolidation/decay.ts` — `procedural` decay window
- `apps/server/src/db/schema/memory.ts` + a migration — the enum member (SQLite enum lives in a `CHECK`, so this is a **table-rebuild** migration; see design)
- `apps/plugin/scripts/prompt-search.sh`, `hooks/hooks.json`, `hooks/hooks.codex.json`, `.hermes-plugin/__init__.py`, `.opencode-plugin/plugin.ts` — the first-prompt prefetch, plus a shared fixture so the four copies cannot drift
- `apps/server/src/test/retrieval/baselines/` — ratcheted scorecards

Depends on: `add-retrieval-eval-harness` (the abstention floor and the diversity cap are unshippable without it) and ideally `fix-retrieval-ranking-math` (tuning a floor on top of a known-broken window floors the wrong distribution).

Invariants: append-only untouched; scope-at-service-layer untouched — the relevance channel runs the same scoped search. The `procedural` enum addition is the only schema change and requires the documented table-rebuild dance.
