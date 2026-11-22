## 1. Read the contract and record the baseline

- [x] 1.1 Read `specs/mcp-api/spec.md` in this change folder before touching code — it is a MODIFIED block that replaces the whole "The MCP server MUST expose four session-lifecycle tools" requirement, and the code must satisfy it rather than the other way round. The key additions: the `applied` paragraph for `memory.session_summary`, the `applied` paragraph for `memory.session_end`, and the new scenarios covering terminal-final-discard.
- [x] 1.2 Read `design.md` D1–D7. D4 (service layer signals no-op, handler does not infer) and D5 (the spec scenario is scoped to active rows) are the two that a plausible-looking implementation gets wrong.
- [x] 1.3 Record the baseline, so every later number has something to be compared against: `cd apps/server && pnpm vitest run src/mcp/session-tools.test.ts` and `pnpm vitest run src/test/mcp-integration.test.ts` both green, with their test counts written down. Baseline: `session-tools.test.ts` 20 tests passing; `mcp-integration.test.ts` 119 tests passing.

## 2. Service layer

- [x] 2.1 Change the return type of `writeTerminalFields` (`apps/server/src/services/agent-sessions.ts:322`) from `AgentSession` to `{ row: AgentSession; applied: boolean }`. When `Object.keys(set).length === 0`, return `{ row: existing, applied: false }`. When a real write occurs, return `{ row: updated, applied: true }`. The calling methods `writeSummary` and `end` must propagate this shape.
- [x] 2.2 Update `writeSummary` (`:375`) to handle the new return type from `writeTerminalFields`: when the terminal path returns `{ row, applied }`, return `{ row, applied }` to the caller. The active path (`updateActiveOrThrow`) always applies, so it returns `{ row: result, applied: true }`.
- [x] 2.3 Update `end` (`:390`) identically: propagate the `{ row, applied }` shape from `writeTerminalFields` on the terminal path, and return `{ row: result, applied: true }` from the active path.
- [x] 2.4 Confirm no other callers of `writeSummary` or `end` exist that would break on the shape change. Check `apps/server/src/server/api-router.ts` (the HTTP endpoint calls `agentSessions.end` directly or through a wrapper — verify the shape change is handled there too, or that the HTTP path delegates through a method that absorbs it). The HTTP `POST /sessions/<id>/summary` and `POST /sessions/<id>/end` paths are out of scope for the verdict surface, but they must not break on the return-type change.
- [x] 2.5 No comment on any edit. The "why" is in the spec and design doc, per house policy.

## 3. Handler and output schema

- [x] 3.1 Add `applied: z.boolean()` and `discardReason: z.string().optional()` to `sessionSummaryOutput` in `apps/server/src/mcp/session-tools.ts:83-89`. Both are declared in the `outputSchema` so clients can discover them; `applied` is required, `discardReason` is optional.
- [x] 3.2 Add `applied: z.boolean()` to `sessionEndOutput` in `apps/server/src/mcp/session-tools.ts:77-81`. Required.
- [x] 3.3 Update `handleSessionSummary` (`:266`) to destructure the `{ row, applied }` return from `writeSummary` and populate `applied` and `discardReason` (set to `'terminal_final'` when `applied === false`) in the `ok({ … })` payload.
- [x] 3.4 Update `handleSessionEnd` (`:253`) to destructure `{ row, applied }` from `end()` and populate `applied` in the `ok({ … })` payload.
- [x] 3.5 Confirm the HTTP API path in `apps/server/src/server/api-router.ts` does not break. `POST /api/<slug>/sessions/<id>/summary` calls `agentSessions.writeSummary` directly; if the router destructures the old `AgentSession` return, it must be updated to destructure `{ row, applied }` and use `row`. The verdict fields (`applied`, `discardReason`) SHALL NOT be added to the HTTP response — they are MCP-only, same as the precedent in `expose-session-start-agent` D5.

## 4. Tool description

- [x] 4.1 Update the `memory.session_summary` description at `apps/server/src/mcp/server.ts:323`: add `applied` to the `Returns:` list (when present in the description — if the current description does not have a `Returns:` list, add one or add a clause explaining `applied`). Add a clause stating that a terminal row keeps its first curated summary (`applied: false`, `discardReason: 'terminal_final'`) and that `memory.session_resume` is the way to resume the session for further writes.
- [x] 4.2 Update the `memory.session_end` description at `apps/server/src/mcp/server.ts:315`: add `applied` to the description, explaining that `applied: false` means the session was already terminal and the call was a no-op.
- [x] 4.3 Measure the new description lengths from a REAL `tools/list` response (not from the source constant) — the `descriptions` map in `apps/server/src/test/mcp-integration.test.ts` is the instrument. Confirm both remain below `DESCRIPTION_MAX_LENGTH`. Record the measured length and headroom for each. If either exceeds the cap, name the clause reclaimed rather than silently trimming.
- [x] 4.4 No operator advice ("use memory.session_resume") in the description beyond the one sentence stating the path — it is the model's remedy, not the operator's, and the operator-facing guidance is in `docs/`.

## 5. Tests — unit, integration, and probe cleanup

- [x] 5.1 In `apps/server/src/mcp/session-tools.test.ts`, add the **distinguishing test** in the `memory.session_summary on a session the sweep already abandoned` block: create a terminal row with `summaryFinal: true`, call `sessionSummary`, and assert `applied: false` and `discardReason: 'terminal_final'`. The two candidate implementations (always-true flag vs. service-signal) disagree only here.
- [x] 5.2 Add the **control**: create a terminal row with `summaryFinal: false` (no prior curated summary), call `sessionSummary`, and assert `applied: true`. Without this, a green 5.1 cannot be told from a test that never exercises the terminal-without-summary path.
- [x] 5.3 Add the **active-row control**: call `sessionSummary` on an `active` session and assert `applied: true` and `discardReason` is `undefined` (not present in the response). This guards against `discardReason` leaking onto active-row writes.
- [x] 5.4 Add a test for `memory.session_end` on an active row: assert `applied: true`. Add a test for `session_end` on a terminal row: assert `applied: false`. Both in the `memory.session_summary on a session the sweep already abandoned` block or a new adjacent block.
- [x] 5.5 Fold the assertions from the temporary reproduction probe (`apps/server/src/mcp/session-371-probe.test.ts`) into proper regression tests in `apps/server/src/mcp/session-tools.test.ts` (or the appropriate co-located test file). The probe's three tests (REPRO, CONTROL, secondary terminal-without-summary) map to 5.1, 5.2, and the existing test at `:198` ("still writes when the terminal session belongs to the scoped project").
- [x] 5.6 Delete `apps/server/src/mcp/session-371-probe.test.ts`.
- [x] 5.7 Update the integration test's required-field pins if `sessionSummaryOutput` or `sessionEndOutput` required-field lists changed (the CI test at `apps/server/src/test/mcp-integration.test.ts` that compares `outputSchema` required fields against the `Returns:` list in the description).
- [x] 5.8 Mutation gate — the `applied` field is not covered until this reddens: `node scripts/mutate.mjs --file apps/server/src/mcp/session-tools.ts --spec src/mcp/session-tools.test.ts --mutation 'applied: row.applied,' --with "applied: true,"`. It MUST report red. A green run means the tests prove nothing and the tests are what gets fixed.
- [x] 5.9 Second mutation, against the integration boundary: same find/replace with `--spec src/test/mcp-integration.test.ts`. It MUST redden the terminal-discard scenario. Record which named tests each mutation caught, and confirm `scripts/mutate.mjs` restored both files byte-identically.

## 6. Verification

- [x] 6.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 6.2 `pnpm test` green from the repo root, with the new counts recorded. `apps/server/src/test/invariants.test.ts` must stay green — nothing here emits SQL outside `db/` and nothing mutates an immutable session column.
- [ ] 6.3 `pnpm run eval` is NOT required and SHALL NOT be run as evidence for this change: no retrieval, ranking, embedding or search path is touched.
- [x] 6.4 `pnpm run check:spec-provenance` locally (it inspects only `origin/main...HEAD`; CI is the actual gate) and `node scripts/check-delta-freshness.mjs` clean.

## 7. Real Docker smoke against pre-existing seeded data (operator-assisted — `/opsx:apply` must pause here)

- [x] 7.1 Bring up the dev stack: `pnpm run dev:docker:up` (if it dies with `SQLITE_CANTOPEN`, `chown -R 10001:10001 data-dev` first). Note that the boot seeds and reseeds, so "pre-existing data" here means the seeded corpus present before the probe, not an empty database — capture the session row count before probing so the after-count is comparable.
- [x] 7.2 Over the REAL `/mcp/<slug>` transport with a real token from the boot banner (never the handler directly — that path bypasses the registered schema), call `memory.session_summary` on a terminal row with a prior curated summary. Confirm `applied: false` and `discardReason: 'terminal_final'` in the response.
- [x] 7.3 The control: call `memory.session_summary` on a terminal row WITHOUT a prior curated summary. Confirm `applied: true`.
- [x] 7.4 Call `memory.session_end` on an already-terminal row. Confirm `applied: false`.
- [x] 7.5 Tear the stack down and record in the PR which client and transport the probe used, alongside the response payloads.

## 8. Deferred and explicitly rejected — do not silently drop

- [ ] 8.1 The first-curated-stands precedence rule is deliberately NOT changed (design D1, D5). Do not change it inside this change; the `plugin-session-protocol` capability requires it, and there is no `replaces` chain for sessions.
- [ ] 8.2 The HTTP `POST /api/<slug>/sessions/<id>/summary` path is deliberately NOT given the verdict surface (design D5 analogy, same as `expose-session-start-agent`). Its adopt path keys on the host session id, not on `(token, project)`, and each client already handles its own retry. Tracked as a follow-up if the MCP surface proves insufficient.
- [ ] 8.3 `session_already_ended` SHALL NOT become an error code (the spec says so and the plugin nudge path depends on it). Confirmed: not added.
- [ ] 8.4 PR title and description in English, Conventional Commits (`fix(mcp): …`), hooks never bypassed. Reference issue #371, and state plainly that this change makes the discard observable and does NOT change the precedence rule.
