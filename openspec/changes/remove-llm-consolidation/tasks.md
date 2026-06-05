# Tasks — remove-llm-consolidation

## 1. Deletions and dependency removal

- [ ] 1.1 Delete `apps/server/src/consolidation/judge.ts` and `apps/server/src/consolidation/judge.test.ts`; `pnpm run typecheck` reports only expected downstream errors (fixed in §2-§3)
- [ ] 1.2 Delete `apps/server/src/consolidation/scheduler.ts` and its export from `apps/server/src/consolidation/index.ts`
- [ ] 1.3 Delete `apps/server/src/llm/generate.ts` and prune its exports from `apps/server/src/llm/index.ts` (keep `client.ts`/`embed.ts`/`errors.ts` — embeddings are out of scope)
- [ ] 1.4 Remove `croner` from `apps/server/package.json` per `.agents/skills/npm-security-best-practices/` (lockfile updated via `pnpm install`, no new deps)

## 2. Sweep service

- [ ] 2.1 Rework `apps/server/src/consolidation/runner.ts` into the deterministic sweep: decay pass unchanged; replace orphan-promotion with deadline orphaning (`findPendingOlderThan(JUDGMENT_ORPHAN_DEADLINE_MS)` → `relations.orphan(...)`, journaled per current op mechanics); runs write `llm_provider`/`llm_model` NULL
- [ ] 2.2 Add per-scope throttle: skip sweep when newest `consolidation_runs` row for the scope is younger than `SWEEP_MIN_INTERVAL_MS` (internal constant 6h); expose `force` flag for the manual trigger
- [ ] 2.3 Add `JUDGMENT_ORPHAN_DEADLINE_MS` (default 14d) to `apps/server/src/config.ts` under `judgments`
- [ ] 2.4 Rewrite `apps/server/src/consolidation/orphan-promotion.test.ts` as deadline-orphaning tests: aged-past-deadline → orphaned + journaled; between thresholds → untouched; idempotent on second run
- [ ] 2.5 Update `apps/server/src/consolidation/runner.test.ts` for throttle behavior (runs/skips/force) and failure isolation

## 3. Trigger wiring

- [ ] 3.1 Hook sweep into session creation: `apps/server/src/server/api-router.ts` (session ensure) and `apps/server/src/mcp/sessions-tools.ts::handleSessionStart`, both calling one service entry point; sweep runs after the response path, errors logged and swallowed
- [ ] 3.2 Rework `apps/server/src/server/bootstrap.ts`: remove chat `LlmClient`, scheduler wiring and `triggerConsolidation` cron comments; manual trigger calls sweep with `force: true`
- [ ] 3.3 Update `apps/server/src/dashboard/consolidation.ts`: manual run button posts the sweep; runs table renders legacy `llm_model` rows as `—` (verify, already the case)

## 4. Config and doctor

- [ ] 4.1 Remove `LLM_PROVIDER`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `CONSOLIDATION_ENABLED`, `CONSOLIDATION_CRON`, `CONSOLIDATION_BATCH_SIZE` from `apps/server/src/config.ts` env schema and cross-field validation; keep embedding keys untouched
- [ ] 4.2 Add boot-time stale-env warning: one log line naming any removed var still present; covered by a config test asserting boot succeeds with all seven set
- [ ] 4.3 Drop the `llm` block from `DoctorReport` (`apps/server/src/mcp/sessions-tools.ts`) and `buildDoctorReportFactory` (`apps/server/src/server/bootstrap.ts`); update doctor tests

## 5. memory.context pendingJudgments

- [ ] 5.1 Add `pendingJudgments[]` (cap 5, oldest-first, aged > `JUDGMENT_ORPHAN_AFTER_MS`, scope-filtered) to `handleContext` in `apps/server/src/mcp/sessions-tools.ts` with `{ judgmentId, sourceId, targetId, sourceSnippet, targetSnippet, ageMs }`; coordinate with `filter-empty-sessions-from-context` if still unmerged
- [ ] 5.2 Tests: aged pending appears; fresh pending excluded; cross-scope excluded; closed via `memory.judge` disappears
- [ ] 5.3 Update MCP instructions text (`apps/server/src/mcp/instructions.ts`) if it references nightly consolidation; keep under the 800-char cap per existing instructions tests

## 6. Guards and invariants

- [ ] 6.1 Extend `apps/server/src/consolidation/removed-exports.test.ts`: importing `judge`, `ConsolidationScheduler`, or referencing `croner` under `src/` fails
- [ ] 6.2 Run `apps/server/src/test/invariants.test.ts`; adjust allow-lists only if the sweep moved a file path, never to widen scope
- [ ] 6.3 Full gate: `pnpm run typecheck && pnpm run lint && pnpm test` green

## 7. Docs and upgrade contract

- [ ] 7.1 Update `README.md` config table and `.env.example`: remove LLM/consolidation sections; note in CHANGELOG-visible commit body the **BREAKING** markers and the zero-step upgrade contract (stale vars warn, no migration)
- [ ] 7.2 Update `CLAUDE.md` invariants blurb ("Nightly consolidator only does decay + orphan promotion" → lazy deterministic sweep) and `openspec/specs` references stay consistent at archive time

## 8. E2E smoke (operator-assisted)

- [ ] 8.1 OPERATOR/local: `pnpm run dev:docker:up`, then per `.agents/skills/rembric-smoke-tests/`: boot with stale `OPENAI_API_KEY` env → warning logged, server healthy; session start triggers sweep (consolidation_runs row, NULL llm columns); second session start within 6h skips; manual dashboard trigger forces; aged pending appears in `memory.context` and closes via `memory.judge`
