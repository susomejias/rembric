## Why

Retrieval quality is governed by roughly a dozen compile-time constants — the RRF rank constant, the rank-window margin and ceiling, the post-fusion boost's type/recency/confirmation weights and its clamp, the save-time FTS and vector thresholds, the per-save candidate cap, the per-type decay windows, the per-type review TTLs — and **not one of them has ever been measured**. There is no `apps/server/src/test/retrieval/`, no labelled query set, no recall or MRR number anywhere in the repo.

That is not merely a missing nice-to-have: it is what makes two confirmed ranking defects unfixable. The audit reproduced an inverted save-time FTS threshold and a rank-window/rank-constant inconsistency, and neither can be corrected with confidence because nobody can demonstrate that a fix improves recall rather than regressing it. Worse, the existing suite gives false assurance: the save-time candidate test passes **only** because its 2-row corpus drives FTS5 IDF to ~1e-6, so the "true match" clears the threshold _by scoring as noise_. A fix validated against that fixture proves nothing.

This change builds the measurement first, so the two ranking fixes that follow can be evidence-based, and so every future tuning change is a number instead of an argument.

## What Changes

- **A labelled evaluation corpus, committed as fixtures.** Hand-written coding sessions for a fictional project, each memory carrying a stable id, plus a query set where each query names the memory ids that genuinely answer it. Gold units are **memory ids**, not session ids, because a memory row is Rembric's retrieval unit.
- **Question types chosen for what Rembric actually claims.** Beyond plain extraction: `knowledge-update` (the same `topic_key` saved twice — does search return the current answer?), `temporal`, `preference`, `multi-session-causal`, `cross-scope` (global vs project — a category no comparable project has, because no comparable project has scope isolation), and `abstention` (queries whose answer is deliberately absent).
- **Distractors built in from the start.** Same-project, same-vocabulary near-misses, not generic filler. A corpus without them does not discriminate: a comparable published harness reports its naive substring baseline reaching 0.967 recall@5, which means the corpus, not the retriever, was being measured.
- **Deterministic scoring only.** Precision@k, recall@k, MRR, plus **tokens returned** and p50/p95 latency. No LLM judge, no answer-generation stage — the harness measures retrieval, not a reader model, and Rembric keeps no LLM on any path.
- **A `grep` baseline and a `MEMORY.md`-dump baseline.** The first is the honest control: if hybrid search cannot beat naive substring matching on this corpus, the corpus or the retriever is wrong. The second is the product argument made measurable — dumping the N most recent memories up to a token budget is exactly the "just put it in CLAUDE.md" alternative Rembric exists to beat, and beating it is a claim about **tokens**, which is currently unmeasured.
- **Ingestion through the real write path** into a throwaway database file, so the eval exercises `topic_key` supersession, save-time candidate detection, and inline embedding rather than bypassing them.
- **A CI ratchet.** Committed baseline scorecards; the run fails when a metric drops below its recorded floor. Run as a separate target, not inside `pnpm test`, because it is slow.
- **An honest-ceiling rule.** Each scorecard states the arithmetic maximum of its own metrics given the gold-set shape, so a headline number is never reported as impressive when the metric is saturated by construction.

## Capabilities

### New Capabilities

- `retrieval-evaluation`: a deterministic, offline harness that scores retrieval quality over a committed labelled corpus, with pluggable retrievers, baseline controls, and a CI ratchet.

### Modified Capabilities

(none — this change adds measurement and changes no serving behavior)

## Impact

New:

- `apps/server/src/test/retrieval/` — runner, scoring, adapters (`hybrid`, `grep`, `memory-md-dump`)
- `apps/server/src/test/retrieval/fixtures/` — corpus and query set as committed JSON
- `apps/server/src/test/retrieval/baselines/` — committed scorecards for the ratchet
- a `pnpm run eval` script in `apps/server/package.json`
- a CI job invoking it (separate from the unit-test job)

Touched:

- `.github/workflows/ci.yml` (new job)
- no `apps/server/src` serving code changes — the harness drives the existing services

Invariants: none touched. Ingestion goes through `MemoryService`, so append-only, scope-at-service-layer, and `topic_key` convergence all apply to the eval corpus exactly as they do in production. The harness is read-path measurement over a throwaway database.
