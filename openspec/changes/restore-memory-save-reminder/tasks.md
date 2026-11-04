## 1. Save clause in the server notice

- [x] 1.1 `session-nudge.ts`: `SessionNudgeRow` gains `lastWorkAt` and `lastMemoryAt`; `composeSaveClause(ms)`; `composeSessionNotice(row, max, saveClause?)` keeps the clause first inside `NOTICE_MAX_BYTES`; `evaluateSessionNudge` emits on floor AND (summary OR save condition).
- [x] 1.2 `MemoryRepository.lastCreatedAtForSession(scope, sessionId)` with repository tests (any status, scoped, null when none).
- [x] 1.3 `AgentSessionsService.reportTurn` feeds `lastWorkAt` and the derived `lastMemoryAt` to the gate.
- [x] 1.4 Tests: gate and composer (`session-nudge.test.ts`), service timeline including the #439 shape (`agent-sessions.test.ts`), and the HTTP `/turn` boundary with a memory saved through `MemoryService` (`api-router.test.ts`). Existing summary-gate tests now assert the summary directive specifically.

## 2. Instructions teach the loop

- [x] 2.1 Rewrite `BASE` in `packages/mcp/src/instructions.ts`; raise `INSTRUCTIONS_MAX_LENGTH` to 1500.
- [x] 2.2 Mirror byte-identically in `.hermes-plugin/__init__.py::system_prompt_block`; update the Hermes cap test.
- [x] 2.3 Tests for the loop framing, RECALL→SAVE→SUMMARIZE order, SAVE timing, the no-host recovery and the cap staying below 2048; replace the two hard-coded `1000` caps in `mcp-transport.test.ts` with the constant.

## 3. Fallback titles

- [x] 3.1 `rembric_fallback_title` in `_transcript.sh`; `session-end.sh` and `pre-compact.sh` use it.
- [x] 3.2 Hook-chain tests (`prompt-nudge.sh` → `stop-report.sh` → `session-end.sh`/`pre-compact.sh`) with an isolated `TMPDIR`; the pre-compact test was observed red against the previous script.

## 4. Verification

- [x] 4.1 Mutation-check every new guard condition: 11 server/repository mutations (scratch runner, byte-verified restore) and 3 hook mutations (`scripts/mutate.mjs`), all caught by the tests naming them.
- [x] 4.2 `pnpm test` (db 299, mcp 448, core 1108, web 1506, Hermes 126), `pnpm run typecheck`, `pnpm run lint`, `openspec validate restore-memory-save-reminder --strict` — all exit 0.
- [x] 4.3 E2E against the production build on scratch data (timestamps shifted only while the server was stopped): real hooks → `/turn` → the next prompt injects the save clause; a `memory.save` with the explicit `sessionId` inside the turn suppresses it on a report past the floor (summary directive still present as control); `session-end.sh` keeps the first-prompt title. Observed: a `memory.save` WITHOUT `sessionId` stays unattached when the token has more than one active session in the project (ambiguous-session fallback), so the clause keeps firing for that session — the `sessionId=` line printed with every notice is the existing mitigation.
