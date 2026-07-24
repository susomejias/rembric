## 1. Remove the stop-the-world similarity telemetry

- [ ] 1.1 Delete `similaritySample` from `apps/server/src/db/repositories/vectors-repository.ts` and its pairwise SQL.
- [ ] 1.2 Delete `logSimilarityDistribution` from `apps/server/src/embeddings/state.ts` and the `onDrained` wiring in `apps/server/src/server/bootstrap.ts`.
- [ ] 1.3 Remove any now-unused test coverage of the deleted method; confirm no other consumer exists (`rg similaritySample`).

## 2. Route `memory.capture_passive` through the curation path

- [ ] 2.1 Extract the save-time block in `apps/server/src/mcp/memory-tools.ts` (embed → detect candidates → record pending relations) into a shared helper.
- [ ] 2.2 Call the helper from `apps/server/src/mcp/observability-tools.ts` in place of the bare `MemoryService.save` loop; aggregate `candidates[]` into the response.
- [ ] 2.3 Loosen the learnings-header match to case-insensitive H2/H3 with optional colon; return an explicit no-match signal naming the expected form instead of `{saved: 0}`.
- [ ] 2.4 Correct the false comment in `apps/server/src/services/embedding-worker.ts` claiming `memory.save` always calls `embedNow` (it is conditional, and skipped entirely when the per-save candidate cap is zero).
- [ ] 2.5 Extend `apps/server/src/mcp/observability-tools.test.ts`: a bulk capture surfaces a candidate; captured rows are embedded before return; a lower-cased heading without a colon is accepted; a missing heading is an explicit signal.

## 3. Bound the `memory.get` predecessor projection

- [ ] 3.1 Cap depth and count in `collectPredecessors` (`apps/server/src/services/memory.ts`); batch the hydration into one `unsafeGetByIds`.
- [ ] 3.2 Project predecessors to `{id, title, status, createdAt}` in `apps/server/src/mcp/memory-tools.ts`; add `predecessorCount` and `truncated` to the output schema.
- [ ] 3.3 Make `findHead` signal explicitly when it exceeds its 64-hop cap instead of returning a non-active row silently.
- [ ] 3.4 Test: a 52-deep `topic_key` chain returns a bounded, content-free projection with `truncated: true`; a 3-deep chain returns all three with `truncated: false`.

## 4. Make consolidation undo honest and durable

- [ ] 4.1 Export one `TERMINAL_OP_TYPES` set from `apps/server/src/consolidation/operations.ts`; consume it in `undoOp` and in the dashboard guard at `apps/server/src/dashboard/consolidation.ts`.
- [ ] 4.2 Add `prompt_purge` to the terminal set.
- [ ] 4.3 Stamp `last_seen_at` via `touchLastSeenBatch` on the reactivate branch of `undoOp`; assert no confirmation row is written and the review baseline is unchanged.
- [ ] 4.4 Invariant test: every member of `CONSOLIDATION_OP_TYPES` falls into exactly one of {reactivating, terminal, orphan-promotion, inert}.
- [ ] 4.5 Regression test: decay → undo → force sweep → row still active and absent from the new run's candidates.

## 5. Make `topic_key` readable

- [ ] 5.1 Return `topicKey` from the read projections in `apps/server/src/mcp/memory-tools.ts` (`memoryRow`, `memoryGetOutput`, `contextOutput.recentMemories`, save candidates).
- [ ] 5.2 Add a `topic_key` filter to `memorySearchSchema` and to the scoped repository read in `apps/server/src/db/repositories/memory-repository.ts`.
- [ ] 5.3 Add a scoped `listTopicKeysInScope` prefix read; make `memory.suggest_topic_key` return `occupied`, `occupantId`, `occupantTitle`, `nearby` (`apps/server/src/mcp/relations-tools.ts`, `topic-key.ts`).
- [ ] 5.4 Test: occupied key reports its occupant; near-miss key surfaces in `nearby`; a key held only in another project reports `occupied: false` and leaks nothing.

## 6. Stop zombie sessions from disabling auto-attach

- [ ] 6.1 Additive migration: `ALTER TABLE sessions ADD COLUMN last_activity_at`, backfilled from `started_at`. No table rebuild.
- [ ] 6.2 Add the column to `apps/server/src/db/schema/agent-sessions.ts`; touch it from the session-lifecycle HTTP writes and from MCP writes that resolve to the session.
- [ ] 6.3 Exclude rows staler than the window in `findActiveForTransport` (`apps/server/src/db/repositories/agent-sessions-repository.ts`) — without introducing a recency tiebreak.
- [ ] 6.4 Run stale-active retirement periodically, keyed on `last_activity_at`, alongside the existing timers in `bootstrap.ts`.
- [ ] 6.5 Attach the resolved session id when recording confirmations, so `confirmations.session_id` stops being a permanently-null indexed column.
- [ ] 6.6 Correct the docstrings in `apps/server/src/mcp/memory-tools.ts` and `apps/server/src/mcp/_shared.ts` that claim "most recently-started active row" — they contradict both the implementation and the sessions spec.
- [ ] 6.7 Test: a stale row plus a fresh row resolves to the fresh one; two fresh rows still refuse to guess; the periodic pass retires a stale row without a restart.

## 7. Scope the session status count

- [ ] 7.1 Add a `Scope`-requiring count to `AgentSessionsService` and its repository; rename the unscoped variant to `adminCountByStatus`.
- [ ] 7.2 Switch `apps/server/src/mcp/observability-tools.ts` to the scoped read; switch the dashboard call sites in `bootstrap.ts` to the admin-prefixed one.
- [ ] 7.3 Correct the stale `memory.stats` output contract in `openspec/specs/mcp-api/spec.md` — it documents `memoriesByScope`, `totalProjects`, `totalTokens`, none of which the handler returns.
- [ ] 7.4 Test: a project-scoped connection sees only its own project's session counts.

## 8. Reject NUL bytes and stop splitting surrogate pairs

- [ ] 8.1 Hoist the existing `topic_key` NUL guard into a shared `assertNoNul(field, value)` in `apps/server/src/services/memory.ts`; apply to `title`, `content`, `tags[]`, and the session `title`/`summary`.
- [ ] 8.2 Move `sliceWithoutSplittingSurrogatePair` to a shared string util and call it from `deriveTitle`.
- [ ] 8.3 Test one rejection per guarded field with `invalid_input` naming the field; test that a title derived across an astral boundary contains no unpaired surrogate.

## 9. Fix the post-compaction protocol text

- [ ] 9.1 Rewrite the `apps/plugin/scripts/post-compact.sh` heredoc in English, aligned with the vocabulary in `apps/server/src/mcp/instructions.ts`.
- [ ] 9.2 Add it to `apps/plugin/test/nudge-fixtures.json` as `postCompactCore`; assert lock-step against the opencode equivalent and enforce a character budget in `nudge-fixtures.test.ts`.
- [ ] 9.3 Confirm exactly one copy of the text exists outside the fixtures (`git ls-files apps/plugin/ | xargs rg`).

## 10. Fix backup and restore documentation

- [ ] 10.1 Replace the `docker compose exec … sqlite3` instructions in `README.md` and `docs/docker.md` — no shell and no `sqlite3` exist in the distroless runtime stage.
- [ ] 10.2 Rewrite `docs/backup.md` around the Docker reality: `/data` bind mount, the dashboard snapshot-and-download flow as the online mechanism, litestream as the low-RPO option.
- [ ] 10.3 Add a "Restoring a snapshot" section covering the data-loss guard; document `REMBRIC_ALLOW_DATA_SHRINKAGE` in `.env.example`.
- [ ] 10.4 Let the maintenance view download any snapshot, including `pre-update-` ones, instead of only the latest on-demand file.

## 11. Verify

- [ ] 11.1 `pnpm run typecheck && pnpm run lint && pnpm test`.
- [ ] 11.2 Smoke against `pnpm run dev:docker:up` per the `rembric-smoke-tests` skill: migration applies, `memory.get` on a deep chain is bounded, `capture_passive` surfaces candidates, `memory.stats` is scoped.
- [ ] 11.3 Confirm the drain no longer stalls: force a backlog, let it drain, assert no multi-second event-loop gap.
