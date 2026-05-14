## 1. Persistence — `memory_relations` table and `topic_key` column

- [ ] 1.1 Add Drizzle schema for `memory_relations` (`id`, `judgmentId` UNIQUE, `sourceId` FK, `targetId` FK, `relation` enum nullable, `status` enum, `reason`, `evidence` JSON, `confidence`, `markedByKind` enum, `markedByActor`, `judgedAt`, `createdAt`)
- [ ] 1.2 Add nullable `topicKey` column to the `memory` schema
- [ ] 1.3 Create migration `0005_relations_and_topic_key.sql`: `CREATE TABLE memory_relations`, `ALTER TABLE memory ADD COLUMN topic_key TEXT`, plus indices `memory_topic_key_active_idx` (partial, where `status='active' AND topic_key IS NOT NULL`), `memory_relations_source_status_idx`, `memory_relations_target_status_idx`, `memory_relations_status_created_at_idx`
- [ ] 1.4 Update `EXPECTED_TABLES` and `EXPECTED_COLUMNS` in `schema-drift.test.ts`
- [ ] 1.5 Extend the append-only invariant grep test to forbid `DELETE FROM memory_relations` and `UPDATE memory_relations SET (source_id|target_id|judgment_id) =`
- [ ] 1.6 Add a runtime assertion in `memory_relations` insert path: `source.scope === target.scope && source.projectId === target.projectId`, otherwise throw `cross_scope_relation`

## 2. Service layer — `RelationsService`

- [ ] 2.1 Implement `createPending({sourceId, targetId, markedByKind?})` returning the new row with `judgmentId`
- [ ] 2.2 Implement `judge(judgmentId, {relation, reason?, confidence?, evidence?, actor, kind})` — transactional, transitions `status='pending' → 'judged'`, mutates `memory` rows only when `relation='supersedes'` (target → superseded, source.replaces += target.id)
- [ ] 2.3 Implement `compare({sourceId, targetId, relation, reason?, confidence, evidence?, actor})` — idempotent upsert by `(sourceId, targetId)`; rejects `not_conflict` relation
- [ ] 2.4 Implement `listForMemory(memoryId, limit=10)` for `memory.search` and `memory.get` annotation queries — single JOIN, returns both source-side and target-side rows
- [ ] 2.5 Implement `findPendingOlderThan(thresholdMs, limit)` for the consolidator's orphan-promotion pass
- [ ] 2.6 Unit tests for each method, including cross-scope rejection, double-judge rejection, idempotency of `compare`

## 3. Service layer — `MemoryService.save` extension

- [ ] 3.1 Add `topic_key?` parameter to `MemoryService.save` input
- [ ] 3.2 Implement the topic-key upsert path: if `topic_key` provided, in a single transaction find the active row in `(scope, project_id, topic_key)`, set `replaces = [previous, ...]` on the new row, mark the previous row `superseded`, and call `RelationsService.judge` internally with `markedByKind='agent_topic_key'`
- [ ] 3.3 Implement candidate detection: FTS5 query (top-K=20, normalized rank threshold `CANDIDATE_FTS_THRESHOLD` default 0.4) + vec kNN (when embeddings enabled, K=20, cosine ≥ `CANDIDATE_VEC_THRESHOLD` default 0.85)
- [ ] 3.4 Cap returned candidates at `CANDIDATES_PER_SAVE_MAX` (default 5, range 0..25); only the surfaced subset gets `memory_relations` rows inserted
- [ ] 3.5 Atomic compound transaction: row insert + topic-key upsert (if any) + candidate-relation inserts all roll back together on any failure
- [ ] 3.6 Extend the return shape of `MemoryService.save` to include `candidates: Candidate[]` and `judgmentRequired: boolean`
- [ ] 3.7 Add config knobs to `src/config.ts` + tests: `CANDIDATES_PER_SAVE_MAX`, `CANDIDATE_VEC_THRESHOLD`, `CANDIDATE_FTS_THRESHOLD`

## 4. MCP tools — `memory.suggest_topic_key`, `memory.judge`, `memory.compare`

- [ ] 4.1 Implement `suggestTopicKey(type, {title?, content?})` — deterministic, family-aware, no LLM. Output: `<family>/<slug-of-most-salient-keywords>`. Stopwords list + length cap (slug ≤ 48 chars after the family prefix)
- [ ] 4.2 Register `memory.suggest_topic_key` MCP tool with zod schema `{ type, title?, content? }` and response `{ topic_key }`
- [ ] 4.3 Register `memory.judge` MCP tool with zod schema `{ judgmentId, relation, reason?, confidence?, evidence? }`; wire through `RelationsService.judge` with `actor=token.name`, `kind='agent'`
- [ ] 4.4 Register `memory.compare` MCP tool with zod schema `{ memoryIdA, memoryIdB, relation, reason?, confidence, evidence? }`; reject `relation='not_conflict'` with `invalid_input`; reject cross-scope pairs with `cross_scope_relation`
- [ ] 4.5 Extend the existing `memory.save` tool registration to accept `topic_key?` and include `candidates` / `judgmentRequired` in the response payload
- [ ] 4.6 Extend the existing `memory.search` tool's response: each result row gains `relations: Annotation[]` populated via a single JOIN against `memory_relations` (no N+1)
- [ ] 4.7 Extend `memory.get` response to include the full set of annotations on the requested memory (cap 50)
- [ ] 4.8 Update tool descriptions for `memory.save`, `memory.judge`, `memory.compare`, `memory.suggest_topic_key` in protocol-teaching style (Engram-equivalent wording for `topic_key` workflow + judgment cadence)

## 5. Consolidator simplification

- [ ] 5.1 Delete `findRedundancyCandidates`, `findDriftCandidates`, `findContradictionCandidates` from `src/consolidation/candidates.ts` and their unit tests
- [ ] 5.2 Keep `applyDecay`, `applyMerge`, `applySupersede`, `undoOp`, `undoRun` (the orphan-promotion path uses merge/supersede via the existing transactional helpers)
- [ ] 5.3 Add `promoteOrphans({ olderThanMs, llmJudge })` in `src/consolidation/runner.ts`: fetches `memory_relations WHERE status='pending' AND created_at < cutoff`, batches by `(scope, project_id)`, invokes the LLM judge per pair, translates the verdict, calls `RelationsService.judge` with `actor='consolidator'`, `kind='consolidator'`; failed/low-confidence rows transition to `status='orphaned'`
- [ ] 5.4 Update `ConsolidationRunner.runScope` so each scope runs decay + orphan-promotion only (no more candidate detection loops)
- [ ] 5.5 Add config `JUDGMENT_ORPHAN_AFTER_MS` (default 86_400_000) with zod parsing + tests
- [ ] 5.6 Add a new `consolidation_ops.op_type` value `'orphan_promote'` and write one journal entry per processed relation
- [ ] 5.7 Update `consolidation/runner.test.ts` to assert: decay still works; orphan-promotion fires on aged pending rows; no LLM call for fresh pending rows; cross-scope orphans are rejected at insertion time, not at consolidation
- [ ] 5.8 Verify `undoRun` still rolls back correctly across the new op type (`orphan_promote` undoes by flipping the relation status back to `pending` — record this in the design)

## 6. Tool description rewrites

- [ ] 6.1 `memory.save` description: lead with the WHEN-triggers (already in change #1), add a "If this is an evolution of an existing topic, pass `topic_key`" paragraph
- [ ] 6.2 `memory.judge` description: explain the closing-loop pattern, the supersedes side effect, the `not_conflict` no-op
- [ ] 6.3 `memory.compare` description: distinguish from `memory.judge` (proactive vs reactive)
- [ ] 6.4 `memory.suggest_topic_key` description: encourage agents to call it before save when handling evolving topics; document the family conventions
- [ ] 6.5 Update the `instructions` block from change #1 to add a one-line "if topic is evolving, pass `topic_key`" hint (keep total ≤ 800 chars)

## 7. Dashboard surfacing

- [ ] 7.1 Add a "Relations" tab to `/dashboard/memories/:id` showing all rows from `memory_relations` for that memory, with status badges (`pending` | `judged` | `orphaned`)
- [ ] 7.2 Add a "Pending judgments" widget to `/dashboard` overview: count of `memory_relations WHERE status='pending'` per scope
- [ ] 7.3 Add `/dashboard/relations` list view with filters (status, kind, scope) — read-only view of the relations graph
- [ ] 7.4 CSRF-protected actions: "Mark as orphaned" button on a pending relation row in the dashboard
- [ ] 7.5 E2E test (in `dashboard-e2e.test.ts`) covering: save → relations tab shows pending → judge via API → tab updates to judged

## 8. CLI

- [ ] 8.1 Extend `rembric status` JSON output: `relations: { pending, judged, orphaned }`
- [ ] 8.2 Add `rembric consolidation run-now --orphans-only` flag for the maintenance use case (only run orphan-promotion, skip decay)

## 9. Tests — correctness + idempotency

- [ ] 9.1 Integration test: save → save with same topic_key in same scope → first row is `superseded`, second has `replaces=[first]`, one `memory_relations` row with `marked_by_kind='agent_topic_key'`
- [ ] 9.2 Integration test: save without topic_key + an existing similar row (FTS match) → response includes 1 candidate with `source='fts'`, pending relation row inserted
- [ ] 9.3 Integration test: save with embeddings enabled + existing semantically similar row → candidate has `source='vec'`
- [ ] 9.4 Integration test: agent calls `memory.judge` with `relation='supersedes'` → target row transitions to superseded, source.replaces is updated, relation row is judged
- [ ] 9.5 Integration test: agent calls `memory.compare` proactively across two unrelated memories → relation row inserted with `status='judged'` and no save preceded
- [ ] 9.6 Integration test: cross-scope save (project A) → only project A rows considered for candidates, project B + global excluded regardless of similarity
- [ ] 9.7 Property test (fast-check): random sequence of saves with random topic_keys → at any point, at most one `active` row per `(scope, project_id, topic_key)`
- [ ] 9.8 Property test: random save-then-judge sequences → relation rows always end in `'judged'` or `'pending'`, never both
- [ ] 9.9 Concurrency test: 50 concurrent saves with the same topic_key → exactly one row ends `active`, others are `superseded`, replaces chain is consistent
- [ ] 9.10 Idempotency test: `memory.compare` called twice with same (A,B,relation) → single row, second call updates `judged_at` only
- [ ] 9.11 Annotation N+1 test: `memory.search` returning 50 rows triggers exactly one extra query for relations (single JOIN)
- [ ] 9.12 Consolidator orphan-promotion test: insert pending row, advance clock past threshold, run consolidator, assert relation is `judged` with `marked_by_kind='consolidator'`
- [ ] 9.13 Consolidator simplicity test: assert `findRedundancyCandidates` / `findDriftCandidates` / `findContradictionCandidates` exports no longer exist (compile-time + grep)

## 10. Documentation

- [ ] 10.1 Update `docs/agents.md`: add the topic-key workflow, the save → judge cadence, the conditions where `memory.compare` is appropriate
- [ ] 10.2 Update README env-var table with `CANDIDATES_PER_SAVE_MAX`, `CANDIDATE_VEC_THRESHOLD`, `CANDIDATE_FTS_THRESHOLD`, `JUDGMENT_ORPHAN_AFTER_MS`
- [ ] 10.3 Add a short `docs/relations.md` explaining the relation taxonomy and how annotations propagate to search results
- [ ] 10.4 Note in `docs/troubleshooting.md`: "too many pending judgments" symptom — likely an agent that ignores `candidates[]`; check the dashboard or wait for orphan promotion
- [ ] 10.5 Update CHANGELOG and release notes calling out: `memory.save` response shape changes (additive); new tools `memory.suggest_topic_key`, `memory.judge`, `memory.compare`; old consolidator detection paths removed
