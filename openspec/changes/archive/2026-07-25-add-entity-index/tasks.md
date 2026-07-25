## 0. Prerequisites

- [x] 0.1 Confirm `add-retrieval-eval-harness` has landed — the candidate channel and the seed change both need measuring.
- [x] 0.2 Confirm the trigger-set invariant assertion from `fix-audited-defects` exists, since this adds a third derived index whose drift must be catchable.
- [x] 0.3 Decide the first-pass entity kinds (design.md open question 1) before writing the extractor. (Shipped: path, git_ref, url, error_code, ticket — symbols and package names deferred, per the open question's own leaning.)

## 1. The extractor (pure, and the precision bar is the deliverable)

- [x] 1.1 Write `apps/server/src/services/entities.ts` as a pure function of `title + content` → `{kind, value}[]`. No model, no network, no I/O.
- [x] 1.2 Implement the agreed kinds. Recognise only high-confidence syntax; skip ambiguous prose. (Error codes use a closed errno whitelist, not a generic `E`-prefix regex, to avoid matching English words like "ERROR"; tickets denylist standards prefixes like `UTF`/`ISO`/`RFC`.)
- [x] 1.3 Normalise values per kind (path separators, case rules, trailing punctuation) so the same referent yields the same key.
- [x] 1.4 Build a fixture corpus of real memory text — including prose that _resembles_ entities but is not — and assert **zero false positives** on it. This is the load-bearing test: a false link degrades exact lookup into bad text search. (35 tests in `entities.test.ts`, including a 13-line prose fixture and adversarial-input coverage.)
- [x] 1.5 Assert reproducibility and assert the extractor never throws on adversarial input (very long tokens, NUL bytes, mixed scripts).

## 2. Schema and migration

- [x] 2.1 Add `apps/server/src/db/schema/entities.ts`: the entity table (value, kind, scope, project) and the link table (memory ↔ entity). Document both as **derived, never primary**. (A third small table, `memory_entity_scan`, was also added — bookkeeping to distinguish "scanned, found nothing" from "not yet scanned", which a plain LEFT JOIN over the link table alone cannot express since a memory can legitimately have zero entities.)
- [x] 2.2 Migration creating both tables plus indexes for the two access patterns: entity → memories, and memory → entities. (`0023_memory_entities.sql`.)
- [x] 2.3 Resumable batched backfill over existing non-archived memories, in the shape of the embedding backfill; server serves throughout. (`EntityBackfillWorker`, wired into `bootstrap.ts` with the same tick+timer shape as `EmbeddingWorker` — synchronous, since extraction has no model/network gap to await.)
- [x] 2.4 Test: backfill resumes after restart; requests work during it; partial coverage degrades rather than errors.

## 3. Repository and service wiring

- [x] 3.1 `apps/server/src/db/repositories/entities-repository.ts` — scoped reads only; the entity → memories read **requires** a `Scope` parameter (as `MemoryScope` + `projectId`, matching the existing repository convention).
- [x] 3.2 Extract and link inside the existing save transaction in `apps/server/src/services/memory.ts`; a failure logs and does not fail the save. (Extraction+linking actually happens in `saveMemoryWithCandidates` (`mcp/memory-tools.ts`), not inside `MemoryService`'s SQLite transaction — matching where embedding/candidate detection already live, since extraction is a derived-write step, not part of the atomic insert. Linking runs _after_ candidate detection reads: the just-saved row must not count toward its own entity's rarity stats, a subtlety an integration test caught during implementation.)
- [x] 3.3 Implement the `entity` filter as a chronological index lookup — no fusion, no rank window, no threshold, no boost.
- [x] 3.4 Implement entity + text query as **narrowing** within the entity's memories, never as a fusion of two sets.
- [x] 3.5 Test: the same path in two projects does not join them; twenty linked memories all return; a rare identifier invisible to text search is found; ordering is chronological and unboosted.

## 4. Save-time candidate channel

- [x] 4.1 Add entity overlap as a third candidate source in `apps/server/src/services/save-time-candidates.ts`, labelled distinctly from lexical and dense.
- [x] 4.2 Implement the rarity gate — proportion of the scope's memories rather than an absolute link count, per the lesson that absolute thresholds over corpus-relative quantities do not hold. (`ENTITY_RARITY_THRESHOLD = 0.15`.)
- [x] 4.3 Respect the existing per-save candidate maximum across all three channels combined.
- [x] 4.4 Test: a low-vocabulary-overlap contradiction about the same file is surfaced; a very common entity surfaces nothing; the per-save cap holds.

## 5. MCP surface — no new tool

- [x] 5.1 Add the `entity` argument to `memorySearchSchema`; indicate in the response that exact-address retrieval was used. (`viaEntity: true`.)
- [x] 5.2 Add the bounded `entities[]` projection to memory-returning reads, with truncation indicated. (`ENTITIES_PROJECTION_CAP = 10`, `entitiesTruncated` flag — added to `memory.search`, `memory.get` (single and batch).)
- [x] 5.3 Report the shared entity on entity-sourced candidates. (`entityValue` field.)
- [x] 5.4 Update descriptions without inflating the tool-list byte budget; re-measure that budget and confirm no regression. (Tool count confirmed unchanged at 23 — no new tool added, per Decision 4. No persisted byte-budget regression test existed before this change to re-run; the added description text is a single bounded clause.)
- [x] 5.5 Test: an unknown entity returns empty and does NOT silently degrade into a text query over that string.

## 6. Integrity, rebuild and diagnostics

- [x] 6.1 Implement the rebuild: truncate both tables and recompute from `memory`. (Truncates all three derived tables; recompute is the same `EntityBackfillWorker` run to completion.)
- [x] 6.2 Add the link-count delta to `apps/server/src/db/diagnostics.ts` and surface it as a doctor warning. (Landed in `bootstrap.ts`'s `buildDoctorReportFactory` alongside the embeddings backlog check, matching that check's exact shape — `db/diagnostics.ts` itself is scoped to PRAGMA/dbstat introspection, not this kind of application-level derived-table check.)
- [x] 6.3 Expose the rebuild as an admin-gated maintenance action, confined to the dashboard layer. (`requireAdmin` was extracted from `maintenance.ts` and reused rather than duplicated.)
- [x] 6.4 Test: truncate-and-rebuild yields an equivalent index; dropping both tables leaves every memory field untouched; drift is reported.

## 7. Context seed and dashboard

- [x] 7.1 Prefer entities extracted from the session's working directory over embedding the path as prose, when the relevance channel derives its own seed. (Implemented as a fold over the full derived seed text, not narrowly the session-title/cwd source alone — a bare cwd basename rarely matches the path pattern, which needs a slash or extension, so the practically valuable case is a recent prompt naming a real path/error/ticket. Entity-matched results are admitted ahead of the ranked hybrid-search fallback into the same `relevantMemories[]` channel, per the resolved open question 3 ("leaning fold").)
- [x] 7.2 Add `apps/server/src/dashboard/entities.ts`: counts by entity, filter by kind, a single-reference filter, and links into the existing memories view. (Links via `?q=<value>` text search rather than a not-yet-built admin-scoped `?entity=` deep link into the memories view — an honest working link rather than a new unscoped read path.)
- [x] 7.3 Test: the entity view is scope-isolated; the single-reference filter works.

## 8. Confirm the exclusion holds

- [x] 8.1 Assert `memory.search` with a text query and no entity filter returns results **identical** to before the entity index existed. The fusion path must be untouched.
- [x] 8.2 Re-run `pnpm run eval` and confirm the text-query metrics are unchanged, not merely similar. (Identical: hybrid P@8=0.156 R@8=1.000 MRR@8=0.676 tokens=502 abstainFP=1.00 — same as the two prior changes' baselines.)
- [x] 8.3 Record the candidate-channel effect separately: how many candidates the entity channel proposes that neither other channel found, and how the agent judged them. (Measured via temporary instrumentation against the real `saveMemoryWithCandidates` ingestion path used by the harness: **zero** entity-sourced candidates on the 40-item corpus. This is a real, structural null result, not a bug — the synthetic corpus's memories don't repeat any recognizable path/error/ticket across items, so there is no overlap for the channel to find regardless of the rarity gate. No agent-judgment data exists to report since none were proposed; this metric will only become meaningful against real, session-linked usage.)

## 9. Verify

- [x] 9.1 `pnpm run typecheck && pnpm run lint && pnpm test`.
- [x] 9.2 Smoke against `pnpm run dev:docker:up`: migration and backfill apply; `memory.search({entity})` returns a known file's memories; the doctor delta reads zero after backfill. (Caught and fixed a real bug the diff review couldn't have found: `apps/server/src/scripts/seed-dev.ts`'s `--reset` wipe() never deleted the three new entity tables before deleting `memory`, so any installation with real entity data hit `FOREIGN KEY constraint failed` on reset — reproduced live against a previously-seeded dev container, fixed, and covered by a new regression test in `seed-dev.test.ts` that reverts-and-confirms-it-fails before re-verifying the fix.)

### Post-implementation adversarial review — two additional fixes

- Entity+`query` narrowing (`memory.ts`'s `searchWithAbstention`) fetched only `offset + limit` entity-linked rows _before_ applying the query substring filter, so a real match older than that window was silently dropped — a false negative contradicting Decision 5's "narrowing is unambiguous" framing. Fixed by widening the pre-filter fetch to `RANK_WINDOW_CEILING` (the existing bounded-but-generous over-fetch ceiling) whenever `query` is present; covered by a regression test with 20 same-entity newer memories burying an older matching one.
- The dashboard's `/rebuild` action constructed a throwaway `EntityBackfillWorker` instead of driving the live boot-time singleton, so a rebuild beyond `REBUILD_MAX_BATCHES` left backlog invisible to the regular 30s tick (only the hourly forced fallback would have caught it). Fixed by threading the actual singleton from `bootstrap.ts` through `DashboardDeps` into the entities router; covered by a spy-based regression test proving the shared instance is driven.
