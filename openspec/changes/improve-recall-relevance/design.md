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

**Decision 6 — `procedural` is a table-rebuild migration, and that is the main cost of this change.**
The type enum lives in a SQLite `CHECK`, and SQLite has no `ALTER TABLE … ADD CONSTRAINT`, so adding a member means the full rebuild dance: create, insert-select, drop, rename, recreate indexes **and triggers**. The `memory` table is a parent of populated child tables, so the migration runner's `foreign_keys = OFF` / `foreign_key_check` wrapper is load-bearing here — the author does not add pragmas, but must recreate every trigger. There are five triggers across four migration files (FTS insert/update/delete, the vec status trigger, the replaces triggers); missing one is silent and every existing test still passes. The trigger-set assertion from `fix-audited-defects` should exist before this migration is written.

**Decision 7 — Do not reclassify existing rows.**
Deciding that a given `reference` memory is really `procedural` is a content judgement. The server has no basis for it, an LLM is not available by design, and a heuristic would mislabel silently. New saves get the new type; the corpus converges as topics are re-saved.

## Risks

- **Relevance at session start costs tokens on every session.** The channel must be small and the seed cheap. Bounded by the same clamping the context tool already applies, and the token axis in the harness makes the cost visible rather than assumed.
- **A derived seed can be wrong in a way an explicit `focus` is not.** A `cwd`-derived seed on a monorepo is weak. Mitigated by combining it with recent prompts, and by the channel being additive — a poor relevance channel wastes some tokens, it does not remove the recency channel.
- **The abstention floor is corpus-dependent.** Normalised BM25 is more stable than raw, but not scale-free. This is the strongest argument for shipping it disabled.
- **The migration is the real risk in this change.** A dropped trigger means new memories silently stop being indexed — the failure mode of a memory system is quiet incompleteness, and nothing currently verifies FTS integrity at runtime. Sequencing behind the derived-index integrity check would be prudent.
- **Four clients must move in lock-step for the prefetch.** The plugin tree's shared-fixture discipline exists for this; the prefetch text goes in the fixtures with a budget, like every other nudge.

## Migration

One table-rebuild migration on `memory` for the enum member, recreating all indexes and all triggers. `procedural` gains a review TTL and a decay window; existing rows are untouched.

The abstention constants are compile-time and land disabled, so no data or config migration.

## Open Questions

- The per-session diversity cap value. Three is the figure comparable systems use; with a default limit of eight that permits nearly three sessions' worth. Worth sweeping on the harness rather than picking.
- Whether the derived seed should include the current git branch. It is often the most task-specific signal available (`fix/deploy-permissions`), but it is not currently sent to the server by any client, so it would need a plugin change. Deferred unless the harness shows the seed is too weak without it.
- Where the relevance channel's limit comes from — a separate parameter, or a split of the existing `memories` count. Leaning separate and small, so enabling relevance cannot silently halve the recency channel.
- Whether `procedural` should also get a distinct ranking weight immediately, or inherit `project`'s until the harness says otherwise. Leaning inherit, then tune.
