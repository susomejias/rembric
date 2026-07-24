## 0. Prerequisites

- [ ] 0.1 Confirm `add-retrieval-eval-harness` has landed and record the current scorecard as the before-picture.
- [ ] 0.2 Confirm `fix-retrieval-ranking-math` has landed — calibrating an abstention floor on top of a known-broken rank window floors the wrong score distribution.
- [ ] 0.3 Confirm the trigger-set invariant assertion from `fix-audited-defects` exists before writing the table-rebuild migration in section 4.

## 1. Relevance channel on `memory.context`

- [ ] 1.1 Add optional `focus` to `contextSchema` and `relevantMemories[]` to `contextOutput` (`apps/server/src/mcp/memory-tools.ts`), labelled distinctly from `recentMemories`.
- [ ] 1.2 Implement the channel in `apps/server/src/services/memory.ts` over the existing scoped hybrid search; leave the recency path byte-identical.
- [ ] 1.3 Implement seed derivation for when `focus` is absent: active project + session `cwd` + recent curated prompts.
- [ ] 1.4 Return an empty (not absent) relevance channel when no seed is derivable.
- [ ] 1.5 Update the `memory.context` description to explain both channels without inflating the tool-list byte budget.
- [ ] 1.6 Test: explicit `focus` populates relevance and leaves recency unchanged; a derived seed populates relevance; no seed yields empty relevance plus normal recency; a strongly-matching memory in another project never appears.

## 2. Abstention

- [ ] 2.1 Normalise the lexical score to a monotonically-increasing bounded value **before** any comparison — `bm25()` is negative and more negative is better. Do not repeat the inverted-similarity class of bug.
- [ ] 2.2 Add the absolute floor and the gap-ratio tail filter in `apps/server/src/services/hybrid-search.ts`, both **disabled by default**.
- [ ] 2.3 Add the abstention flag and reason to the search response; state in the tool description that abstention means no relevant memory exists and the agent must not substitute assumed context.
- [ ] 2.4 Test: with the gates disabled, behaviour is identical to today; with calibrated values, an unrelated query abstains and a sharp query returns a short unpadded set.
- [ ] 2.5 Calibrate against the harness's abstention queries; enable the gates in a **separate commit** so the mechanism and the numbers are reviewable apart.

## 3. Per-session diversity cap

- [ ] 3.1 Apply the cap after fusion, walking the ordered pool, with backfill from the skipped remainder so the page is never shorter.
- [ ] 3.2 Do not group null-session memories as one session.
- [ ] 3.3 Test: one session cannot monopolise a page; an all-one-session pool still returns a full page; null-session rows are not capped together.
- [ ] 3.4 Sweep the cap value on the harness rather than picking it.

## 4. `procedural` memory type

- [ ] 4.1 Table-rebuild migration on `memory` for the enum `CHECK`: create → insert-select → drop → rename → recreate **every index and every trigger**. Five triggers live across four migration files; verify against the trigger-set assertion.
- [ ] 4.2 Add `procedural` to the schema type union and the tool-boundary enum.
- [ ] 4.3 Add its review TTL in `apps/server/src/services/review.ts` and its decay window in `apps/server/src/consolidation/decay.ts` — distinct from `reference`, which deliberately has no TTL and a ten-year window.
- [ ] 4.4 Do NOT reclassify existing rows.
- [ ] 4.5 Test: a `procedural` memory needs review on its own schedule; the migration leaves every existing row's type unchanged; `post_migration` FTS and vec integrity are intact.

## 5. First-prompt relevance prefetch, four clients in lock-step

- [ ] 5.1 Claude Code + Codex: extend `apps/plugin/scripts/prompt-search.sh` to fire on the first prompt of a session as well as on the keyword match; keep it bounded, once-per-session, and silent on failure.
- [ ] 5.2 Hermes: the equivalent in `.hermes-plugin/__init__.py`.
- [ ] 5.3 opencode: the equivalent in `.opencode-plugin/plugin.ts`.
- [ ] 5.4 Add the injected block to `apps/plugin/test/nudge-fixtures.json` with a character budget; assert lock-step across all four in `nudge-fixtures.test.ts`.
- [ ] 5.5 Test: a first prompt with no recall keyword injects relevance; the second prompt does not re-fire; an unreachable server exits silently.

## 6. Measure

- [ ] 6.1 Re-run `pnpm run eval`; compare aggregate and per-type against the before-picture, and report the **token** axis alongside recall — a relevance gain paid for with 3× the context is not a win.
- [ ] 6.2 Report the abstention false-positive rate separately, before and after enabling the gates.
- [ ] 6.3 Ratchet the baselines; record the measured deltas in the change directory.

## 7. Verify

- [ ] 7.1 `pnpm run typecheck && pnpm run lint && pnpm test`.
- [ ] 7.2 Smoke against `pnpm run dev:docker:up` per `rembric-smoke-tests`: the migration applies with triggers intact, `memory.context` returns both channels, a `procedural` save round-trips.
- [ ] 7.3 Plugin e2e per `rembric-plugin-development`: the first-prompt prefetch fires on each of the four clients.
