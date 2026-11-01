## 1. Lock the conversational policy with focused regressions

- [x] 1.1 Replace the three-hour no-tool silence expectation in `packages/core/src/services/agent-sessions.test.ts` with chat eligibility after the floor, retaining an assertion that `lastWorkAt` remains NULL; observe the intended pre-implementation failure.
- [x] 1.2 Add pure-gate cases in `packages/core/src/services/session-nudge.test.ts` for strict activity/summary comparison, equality suppression, exact 25-minute boundary, repeated notices bounded by the floor, and no independent emission without a report.
- [x] 1.3 Update service timelines for mid-turn curation followed by RAW sync, later chat re-arming, lost reports and backwards clocks. Keep positive controls that would emit without curation and account for earlier chat reports now legitimately advancing `lastNudgeAt`.

## 2. Implement the shared server policy without schema changes

- [x] 2.1 Capture the previous-report-or-start activity anchor in `packages/core/src/services/agent-sessions.ts` before stamping the report; pass it explicitly to the pure evaluator in `session-nudge.ts`. Preserve tool-only monotone `lastWorkAt`, curated timestamp writers, existing status/access guards, one exported floor and renderer bytes.
- [x] 2.2 Extend `apps/web/src/test/api-router.test.ts` at the actual HTTP route boundary: `usedTools:false` earns lines after the floor, below-floor reports return `[]`, missing boolean remains invalid, and terminal/foreign/deleted/archived controls retain their existing outcomes. Do not change the wire schema.
- [x] 2.3 Parent executed all seven independent mutations via the HTTP suite using `scripts/mutate.mjs`: conversational eligibility, arrival/RAW anchors, equality, summary suppression and both floor boundaries were caught. SHA256 restoration of both source files and absence of backups verified after every case. Focused core (176 tests) and HTTP (34 tests) passed before mutation; broader validation follows.

## 3. Pin Hermes adapter behavior without speculative lifecycle edits

- [x] 3.1 Verify existing coverage for relevant external probe cases in `apps/plugin/.hermes-plugin/tests/` using existing host doubles: truthful last-turn tool observation, one-shot opening, same-ID recreation/resumed read, preserved explicit identity, and primary/non-primary request controls. Keep synthetic content and credentials only.
- [x] 3.2 Add deterministic asynchronous report controls in `test_prefetch_and_sync_turn.py`: early prefetch returns without a pending response, later delivery is verbatim and consumed once, empty report cannot erase cached lines, and no prefetch network request occurs.
- [x] 3.3 Verify RAW per-turn/pre-compress/end writes remain `final:false`, and service/HTTP tests preserve curated summary/title against later RAW writes. No provider runtime defect was demonstrated and no lifecycle change was made.
- [x] 3.4 Run the existing shared turn-report and cross-language nudge tests to protect all five clients' verbatim delivery, remaining local instruction fixtures, canonical headings and notice byte bound. Document that server-only policy affects every turn reporter, not just Hermes.

## 4. Gateway acceptance and evidence-gated empty-session investigation

- [ ] 4.1 OPERATOR-ASSISTED / PENDING: identify actual gateway/Hermes and deployed plugin revisions; capture synthetic completed-chat and suppressed-context controls with hook sequence, scoped session IDs, HTTP results and stored row state. Do not infer the deployed version from upstream main or report eager registration as the proven empty-row cause.
- [ ] 4.2 OPERATOR-ASSISTED / PENDING: run a real bot conversation without non-memory tools, continue across the real server floor, observe notice delivery, a successful model-authored `memory.session_summary` against the explicit ID, curated stored state and survival of a subsequent RAW write. Test a short one-turn opening separately; do not force extra model turns or promise cooperation.
- [ ] 4.3 OPERATOR-ASSISTED / PENDING: exercise idle/cache eviction and same-ID recreation versus a real new-session boundary. Verify no artificial `/end` or ID rotation on soft release, first MCP write remains correctly attached, and genuine boundary hooks carry the expected messages.
- [ ] 4.4 CONDITIONAL / DEFERRED: only after 4.1–4.3 reproduce a registration or flush defect and identify a supported host hook, propose the smallest exact runtime edit surface and regression. Preserve ensure-before-MCP, scoped binding, suppression and non-final fallback; otherwise record the unsupported host limitation without editing lifecycle code or deleting historical rows.
- [x] 4.5 Report deterministic server/provider validation separately from gateway/model acceptance. Keep unavailable gateway checks explicitly pending; do not close this as a verified empty-session fix while reproduction or acceptance remains missing.

## 5. Validation and handoff

- [x] 5.1 Run focused validation after runtime edits: `pnpm --filter @rembric/core exec vitest run src/services/session-nudge.test.ts src/services/agent-sessions.test.ts`; `pnpm --filter @rembric/web exec vitest run src/test/api-router.test.ts`; `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests`; `pnpm --filter @rembric/web exec vitest run ../plugin/test/turn-report.test.ts ../plugin/test/nudge-fixtures.test.ts`. Record actual outcomes, not inherited counts.
- [x] 5.2 Parent ran `pnpm run typecheck && pnpm run lint && pnpm test` after all seven mutation checks and verified restoration: exit 0. Hermes suite reports 112 passing tests. Real gateway/local end-to-end acceptance stays pending under 4.1–4.3; no operator configuration or installation was changed.
- [x] 5.3 Run `openspec validate improve-hermes-chat-session-summaries --strict`, review the five delta specs for consistency and preserve pending operator acceptance in the handoff. Implementation is authorized locally; commits, releases, data cleanup and deployment remain excluded.
