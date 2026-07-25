## Context

Four changes on one code path, grouped because they are each cheap, they interact, and they are all measurable by the same harness. The unifying observation: Rembric's retrieval is good and is not wired to the moment of highest value. `memory.context` takes counts and returns recency; relevance only happens on a keyword.

## Goals

- Make session start deliver knowledge bearing on the work, without requiring the agent or the user to ask for it.
- Let the system say "nothing relevant" instead of returning the least-bad rows.
- Stop one verbose session from owning the page.
- Give runbooks a lifecycle that matches how they actually go stale.

## Non-Goals

- No new MCP tool. `focus` is an argument, abstention is a response field, diversity is invisible. The audit measured ~31 KB of `tools/list` resident every turn across 23 tools with four confusable clusters; this change must not add to that.
- Not touching the recency channel of `memory.context`. It is additive, and the two channels stay separable.
- Not auto-reclassifying existing `reference` memories as `procedural`.

## Decisions

**Decision 1 — Two labelled channels, not one merged list.**
Merging relevance into `recentMemories` would silently change the meaning of an existing field and make the response unexplainable to the model. Two channels let the description say what each is for, and let the agent spend attention accordingly. It also means the change is safely revertible: if relevance underperforms on the harness, the channel can be emptied without touching the recency path.

**Decision 2 — Derive the seed server-side when `focus` is absent.**
Requiring `focus` would make the improvement conditional on the agent knowing to pass it, which is exactly the failure mode of the current keyword gate. The server already holds the active project, the session's `cwd`, and recent curated prompts — enough for a usable seed. Deriving beats requiring, because the population that most needs relevance is the population least likely to ask for it.

**Decision 3 — Abstention ships off, and its constants come from the harness.**
This is the risky item in the change and the reason the whole thing is sequenced behind measurement. An absolute floor tuned by intuition removes recall silently and looks like nothing happened. Shipping the mechanism disabled, then enabling it with harness-derived values in a follow-up commit, separates "does the mechanism work" from "are the numbers right". The eval corpus includes abstention queries with no gold answer for exactly this purpose — without them, any floor can only look like lost recall.

**Decision 4 — Normalise before flooring, and mind the sign.**
SQLite's `bm25()` returns negative scores where more negative is better. Any floor must be applied to a normalised, monotonically-increasing value. This is the same class of error the audit found and reproduced in save-time candidate detection, where `1/(1+|rank|)` inverted the ordering and the gate admitted precisely the least informative matches. The floor here must not repeat it, and the guard is a test with a real corpus rather than a two-row fixture.

**Decision 5 — Diversify after fusion, backfill on starvation.**
Applying the cap before fusion would distort scores. Applying it after, as a walk over the ordered pool with backfill from the skipped remainder, guarantees the cap never reduces result count — which matters because a user with one long session must not get a shorter page as a side effect. Memories with a null session id are explicitly not grouped: treating "no session" as one session would cap all pre-sessions and HTTP-written memories together, which is the opposite of the intent.

**Decision 6 — `procedural` turned out to be a pure TypeScript/Zod change, not a table-rebuild migration.**
This decision assumed the type enum lives in a SQLite `CHECK`, which would require the full rebuild dance (create, insert-select, drop, rename, recreate every index **and trigger**). Verified against the actual schema during implementation: **no `CHECK` on `memory.type` exists anywhere** — not in the original `CREATE TABLE`, not in the `0016` title-rebuild's carried-forward DDL, not anywhere else. `type` has only ever been a bare `TEXT NOT NULL` column at the SQL level; the `{enum: [...]}` in `schema/memory.ts` is a Drizzle/TypeScript narrowing, not a database constraint. Adding `procedural` is therefore additive at the type-union + Zod-enum layer only (`schema/memory.ts`, both `MEMORY_TYPES` consts in `mcp/memory-tools.ts` and `mcp/relations-tools.ts`, the dashboard's literal type-filter array, `TYPE_WEIGHT` in `hybrid-search.ts`, `SAVE_DESCRIPTION`) — **no migration, no table rebuild, no trigger risk**. The trigger-set assertion this decision called for (see `fix-audited-defects` prerequisite) was still added, since it's valuable independent of this specific change: it now guards every future `memory`-table migration, not just one that turned out not to be needed here.

**Decision 7 — Do not reclassify existing rows.**
Deciding that a given `reference` memory is really `procedural` is a content judgement. The server has no basis for it, an LLM is not available by design, and a heuristic would mislabel silently. New saves get the new type; the corpus converges as topics are re-saved.

## Risks

- **Relevance at session start costs tokens on every session.** The channel must be small and the seed cheap. Bounded by the same clamping the context tool already applies, and the token axis in the harness makes the cost visible rather than assumed.
- **A derived seed can be wrong in a way an explicit `focus` is not.** A `cwd`-derived seed on a monorepo is weak. Mitigated by combining it with recent prompts, and by the channel being additive — a poor relevance channel wastes some tokens, it does not remove the recency channel.
- **The abstention floor is corpus-dependent.** Normalised BM25 is more stable than raw, but not scale-free. This is the strongest argument for shipping it disabled.
- ~~The migration is the real risk in this change.~~ **Resolved (Decision 6): no migration exists in the shipped change** — the trigger-set assertion was still added as a standing invariant, since the risk it guards against (a dropped trigger on any future `memory` rebuild) is real independent of this specific change needing one.
- **Four clients must move in lock-step for the prefetch.** The plugin tree's shared-fixture discipline exists for this; the prefetch text goes in the fixtures with a budget, like every other nudge.

## Migration

None. `procedural` is additive at the TypeScript/Zod layer only (Decision 6) — existing rows are untouched, no schema change, no table rebuild.

The abstention constants are compile-time and land disabled, so no data or config migration.

## Open Questions

- The per-session diversity cap value. **Resolved: 3**, per the comparable-systems figure — the eval harness's current 40-memory corpus ingests every row with `session_id = NULL` (no session simulated during ingestion), so the cap is a structural no-op against it either way; sweeping on the harness would need a session-aware corpus fixture, out of scope here. Shipped enabled at 3, re-tunable once such a fixture exists.
- Whether the derived seed should include the current git branch. **Resolved: no, deferred** — it is not currently sent to the server by any client, so it would need a plugin change; the shipped seed (project + session title + latest prompt) is not shown by the harness to be insufficient (see Measured Delta), so there's no signal yet that branch is needed.
- Where the relevance channel's limit comes from. **Resolved: a separate, fixed constant** (`RELEVANCE_LIMIT = 5` in `memory-tools.ts`), not exposed as a request parameter — matches the Non-Goal of not growing the tool schema, and can't silently halve the recency channel.
- Whether `procedural` should get a distinct ranking weight immediately. **Resolved: inherit** — `TYPE_WEIGHT.procedural = 0`, same as `project`/`reference`, until the harness has procedural-labelled memories to tune against.

## Measured delta (task 6)

`pnpm run eval` numbers are **unchanged** from the `fix-retrieval-ranking-math` baseline (hybrid P@8=0.156, R@8=1.000, MRR@8=0.676, tokens@8=502). As with the previous change, this is expected rather than a failure to improve, for two structural reasons specific to what the harness currently measures:

- **The relevance channel lives on `memory.context`, not `memory.search`.** The harness's `hybrid` retriever drives `MemoryService.search` directly; `memory.context`'s new `relevantMemories[]` (and its seed derivation) is a different MCP tool entirely, not on the harness's scored path.
- **The diversity cap needs session-labelled competitors to have any effect.** The eval corpus is ingested via `saveMemoryWithCandidates` with no active session context, so every corpus row has `session_id = NULL` — and null-session rows are explicitly never grouped for capping (Decision 5). The cap is enabled and unit-tested directly (`applyDiversityCap`), but this corpus cannot exercise it end-to-end.
- **Abstention ships disabled** (`ABSTENTION_FLOOR = null`, `GAP_RATIO_THRESHOLD = null`), so `abstentionFalsePositiveRate` is unchanged at 1.00 for every retriever, as expected — this remains the "before" number for whichever future change calibrates and enables the floor.

All four features are proven directly at the unit level instead: `applyGapRatioFilter`/`applyDiversityCap` (pure functions, exhaustively tested), `hybridSearch`'s abstention path (tested via explicit `abstentionFloor` overrides — disabled by default, confirmed abstaining once enabled against an unrelated query and not abstaining against a sharp exact-phrase query), the relevance channel (`memory.context` — explicit focus, derived seed, empty-seed, cross-scope isolation), and `procedural`'s review/decay schedule (shorter than `project`'s, confirmed via `deriveReviewState`).
