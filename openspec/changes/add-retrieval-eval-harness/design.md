## Context

Rembric's retrieval quality rests on a dozen unmeasured compile-time constants, and the existing test suite provably gives false assurance in this area: the save-time candidate test passes only because a 2-row corpus drives FTS5 IDF to ~1e-6, so its "true match" clears the threshold by scoring as noise. Sweeping filler rows against that same fixture pair shows the assertion inverting at corpus 5 and staying inverted thereafter.

This change is a prerequisite, not a feature. Two confirmed ranking defects are blocked on it (`fix-retrieval-ranking-math`), and so is any future decision about abstention, diversity caps, or FTS column weights.

## Goals

- Make every retrieval change a number.
- Give the two deferred ranking fixes a way to demonstrate improvement rather than assert it.
- Make the product's central claim — small relevant set beats a growing context dump — measurable in the currency it is actually made in, which is tokens.

## Non-Goals

- No LLM judge and no answer-generation stage. The harness measures retrieval, not a reader model.
- No change to any serving code path. If this change alters ranking, it has failed.
- No downloaded corpus, no API key, no network. Fixtures are committed.
- Not a general benchmarking framework. One corpus, one query set, three retrievers.

## Decisions

**Decision 1 — Gold units are memory ids, not session ids.**
Published harnesses in this space label gold at session granularity because their retrieval unit is a session. Rembric returns memory rows, so session-level labels would systematically over-credit: returning any memory from the right session would score as a hit. Memory-id labels also make the `knowledge-update` category meaningful — the gold is the *current* head, and returning its superseded predecessor is a miss, which is precisely the behavior `topic_key` exists to guarantee.

**Decision 2 — Ingest through `MemoryService` into a throwaway file, not by direct SQL.**
The single-file design makes this nearly free: point the database path at a temp file, no Docker, no port juggling, no `HOME` override. The payoff is that the evaluated corpus has actually been through `topic_key` supersession, inline embedding, and save-time candidate detection — so the harness measures the shipping system rather than a synthetic index. It also means the harness incidentally exercises the write path, which is where the deferred FTS threshold defect lives.

**Decision 3 — Build distractors in from day one.**
A comparable published harness reports its naive substring baseline at 0.967 recall@5, which is a corpus problem, not a retriever result: with unrelated filler, any retriever looks excellent. Each gold memory therefore gets at least one same-project, vocabulary-sharing near-miss. This is the single highest-leverage corpus decision and it cannot be retrofitted cheaply, because adding distractors later invalidates every committed baseline.

**Decision 4 — Three retrievers, and the `grep` baseline is not decoration.**
If hybrid search cannot beat naive substring matching on this corpus, one of two things is true and both are worth knowing immediately: the corpus does not discriminate, or the fusion is not earning its complexity. The context-dump baseline answers the product question instead of the engineering one — it is the "just put it in CLAUDE.md" alternative, and the honest comparison reports both recall *and* tokens, because a dump can always win recall by spending unbounded context.

**Decision 5 — Deterministic metrics, with tokens as a first-class axis.**
Precision@k, Recall@k and MRR are arithmetic. Tokens returned is `content.length`-based arithmetic. Latency is a timer. None of it needs a model, which keeps the harness runnable in CI, offline, on every PR, with no key and no cost. An end-to-end QA-accuracy number would need an LLM judge and would grade the reader model as much as the retriever; it is explicitly out of scope, and if it is ever wanted it belongs in a separate opt-in target.

**Decision 6 — Abstention is a scored category, not a footnote.**
Queries with no answer in the corpus are what make a future score floor tunable. Without them, any abstention mechanism can only ever look like lost recall, because every query has a gold answer by construction. Including them now means the abstention feature arrives with a way to measure itself.

**Decision 7 — Ratchet on committed baselines, in a separate CI job.**
A floor per metric, lowered only by an explicit committed change. Separate job because the harness ingests a corpus and runs an embedding model, which does not belong in the inner-loop unit suite. The scorecard states its own arithmetic ceiling so a saturated metric is never reported as a triumph.

## Risks

- **The corpus is hand-written, so it encodes its author's assumptions.** Mitigated by the `grep` control (which exposes a too-easy corpus immediately) and the per-type breakdown (which exposes a category with no discriminating power). Accepted: a small honest corpus with a stated ceiling beats a large corpus with an unexamined one.
- **Baselines drift when the embedding model or its input recipe changes.** A model or recipe bump legitimately invalidates the floors. The scorecard records the embedding identity, and a bump is expected to re-baseline in the same change.
- **Metric theatre.** A committed number invites optimising the number. The per-type breakdown, the ceiling statement, and the token axis are the guards; a recall gain paid for with 5× the tokens is visible rather than hidden.
- **Corpus size.** Too small and it cannot discriminate; too large and it is unmaintainable by hand. Starting around 30–50 memories across a handful of projects, sized so that the rank window genuinely binds — the audit showed several existing tests are vacuous precisely because their 2-row corpora never bind any bound.

## Migration

None. Additive, test-only, no serving code touched, no schema change.

## Open Questions

- Whether the corpus should be authored in Spanish as well as English. The memory spec already promises cross-lingual retrieval via the multilingual embedder and has a scenario for it, so a bilingual subset would test a real committed guarantee. Leaning yes for a small subset.
- Whether `k` should be the production default of 8 or something larger. Both, probably: `@5` for comparability with published numbers, `@8` because that is what agents actually receive.
- Where the abstention metric lives once a score floor exists — it is scored here as a false-positive rate, but the floor itself is tuned in a later change.
