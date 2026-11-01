## Local implementation evidence

Only local runtime policy/tests and change artifacts were edited. No provider lifecycle, dependency, configuration, historical data, deployment or git index changes. CodeGraph callers plus tracked-reference inspection found the gate input used only by the allowed service and pure-gate tests before renaming it. Renderer text and byte limit are unchanged; `lastWorkAt` remains tool-only and monotone.

### RED

`pnpm --filter @rembric/core exec vitest run src/services/agent-sessions.test.ts -t 'a conversation-only session over three hours'`

Before runtime edits: exit 1, 1 failed / 158 skipped. Expected one notice at minute 25, received zero. The same command after implementation: exit 0, 1 passed / 158 skipped.

### GREEN and triangulation

- `pnpm --filter @rembric/core exec vitest run src/services/session-nudge.test.ts src/services/agent-sessions.test.ts`: exit 0, 176 passed. Covers strict equality, exact floor boundaries, mid-turn curation/RAW anchoring, later chat re-arming, lost reports, clock rollback, terminal/access guards and monotone observations.
- `pnpm --filter @rembric/web exec vitest run src/test/api-router.test.ts --silent`: exit 0, 34 passed. New tests call the actual Request/route/schema/auth/service boundary with isolated SQLite, not a mocked service. Cover conversation eligibility, first/repeat floors, equality with a later-chat positive control, paired curated/no-curated mid-turn cases, RAW precedence and terminal/foreign/deleted/archived controls.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests -p test_prefetch_and_sync_turn.py -k late_chat_notice`: exit 0, 1 passed. An event blocks the real provider worker's mocked HTTP response while prefetch returns; after worker join, a second empty report cannot erase the notice; delivery is exact, session-ID-prefixed, network-free and consumed once.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/plugin/.hermes-plugin/tests`: exit 0, 112 passed. Existing tool-observation, scoped binding, lifecycle/suppression tests were reused rather than duplicated. Existing opening test was extended for one-shot identity ordering and same-ID provider recreation/resumed-read. Python emitted HTTPError ResourceWarnings from pre-existing mocks; no test failed on the final run.
- `pnpm --filter @rembric/web exec vitest run ../plugin/test/turn-report.test.ts ../plugin/test/nudge-fixtures.test.ts --silent`: exit 0, 52 passed.
- `pnpm exec prettier --check packages/core/src/services/agent-sessions.ts packages/core/src/services/session-nudge.ts packages/core/src/services/agent-sessions.test.ts packages/core/src/services/session-nudge.test.ts apps/web/src/test/api-router.test.ts`: passed.
- `git diff --check`: passed.
- `openspec validate improve-hermes-chat-session-summaries --strict`: passed.

Test-authoring corrections observed before the final passes: archived project refusal is the existing 403, not 409 (`apps/web/src/lib/api.ts`); the new Python assertion initially addressed a module constant through the instance and was corrected. Neither required a runtime change. Edit-time TypeScript and Python diagnostics are clean after the gate rename/helper assertion; an initial empty-catch diagnostic on unchanged HTTP setup did not recur on subsequent checks. Full workspace typecheck/lint/test remain parent-owned.

## Parent-owned mutation checks

The worker did not execute `scripts/mutate.mjs` because its backup/deletion operations exceed worker limits. After final handoff, the parent executed all seven commands below sequentially: every baseline passed and every mutation was caught by named HTTP assertions; aggregate exit 0. SHA256 equality of both source files and absence of `.mutate-backup` files were verified after each command. No concurrent writer or broad suite ran during mutation.

### Conversational eligibility without tool use

Expected failure: `turn chat earns notices at the floor without claiming tool work`.

```sh
node scripts/mutate.mjs --file packages/core/src/services/agent-sessions.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation '      activityStartedAt,' --with '      activityStartedAt: input.usedTools ? activityStartedAt : null,'
```

### Report-arrival anchor must not replace turn start

Expected failure: curated mid-turn case and summary-equality suppression; no-curated control must still be reachable.

```sh
node scripts/mutate.mjs --file packages/core/src/services/agent-sessions.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation 'const activityStartedAt = existing.lastTurnReportAt ?? existing.startedAt;' --with 'const activityStartedAt = ts;'
```

### RAW/activity stamping must not replace the single-writer anchor

Expected failure: curated mid-turn case after a later RAW sync.

```sh
node scripts/mutate.mjs --file packages/core/src/services/agent-sessions.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation 'const activityStartedAt = existing.lastTurnReportAt ?? existing.startedAt;' --with 'const activityStartedAt = existing.lastActivityAt ?? existing.startedAt;'
```

### Strict summary comparison, independently from the floor

Expected failure: `turn summary equality suppresses but later chat re-arms`.

```sh
node scripts/mutate.mjs --file packages/core/src/services/session-nudge.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation 'row.activityStartedAt.getTime() > row.lastSummaryAt.getTime()' --with 'row.activityStartedAt.getTime() >= row.lastSummaryAt.getTime()'
```

### Summary suppression itself

Expected failure: curated mid-turn case; the no-curated variant remains a positive control.

```sh
node scripts/mutate.mjs --file packages/core/src/services/session-nudge.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation '  if (!activityAfterSummary) return null;' --with ''
```

### Exact first/repeat floor boundary

Expected failure: chat floor case at exactly 25 minutes.

```sh
node scripts/mutate.mjs --file packages/core/src/services/session-nudge.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation 'now.getTime() - anchor.getTime() < floorMs' --with 'now.getTime() - anchor.getTime() <= floorMs'
```

### Minimum interval suppression

Expected failure: chat floor case one millisecond before first or repeated floor.

```sh
node scripts/mutate.mjs --file packages/core/src/services/session-nudge.ts --spec apps/web/src/test/api-router.test.ts -t 'turn conversational policy' --mutation 'now.getTime() - anchor.getTime() < floorMs' --with 'now.getTime() - anchor.getTime() < 0'
```

The inherited null-anchor guard is covered by the pure-gate suite; a valid HTTP turn always supplies a non-null captured anchor, so no artificial HTTP input is introduced to reach that internal-only case.

## Pending acceptance

Tasks 4.1–4.4 remain pending. Actual gateway/host versions, empty-row cause, real hook delivery and model-authored curated convergence are unverified. No deployed empty-session fix is claimed. Parent mutations passed. After verified restoration, `pnpm run typecheck && pnpm run lint && pnpm test` completed with exit 0 (112 Hermes Python tests passed). This is local validation, not gateway acceptance. Active LSP probes covered all seven changed source/test paths with no errors; nine auxiliary warnings/hints/information concern unchanged lines.
