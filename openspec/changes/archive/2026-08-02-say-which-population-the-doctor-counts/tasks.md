## 1. Rewrite the two tool descriptions

- [x] 1.1 Replace `memory.doctor`'s `description` at `apps/server/src/mcp/server.ts:378` with text satisfying all four obligations from the `mcp-api` delta: server-wide across all projects + global; `memory.stats` named as the scoped counterpart with an explicit "they will differ"; the returned blocks named including `entities`, `sessions.active` and `review`; and no `LLM` claim. Design D1 carries the approved wording (391 chars). Put the server-wide clause in the FIRST sentence, not the last — client truncation is a tail cut (`openspec/specs/mcp-api/spec.md:1938` requirement, "Truncation is a tail cut, so the LAST content of a description is what is lost first").
- [x] 1.2 Replace `memory.stats`' `description` at `apps/server/src/mcp/server.ts:400` with text that names `needsReviewTotal` and `pendingJudgmentsTotal`, keeps "scoped to the active project (or global)", and states that `memory.doctor`'s same-named counters are server-wide and will differ. Design D4 carries the approved wording (242 chars).
- [x] 1.3 Confirm by inspection that no other file changed: `git diff --stat` SHALL list exactly `apps/server/src/mcp/server.ts` plus the new/changed test file. `DoctorReport` (`apps/server/src/mcp/observability-tools.ts:81-91`), `doctorOutput` (`:93-109`), `statsOutput` (`:111-119`), `handleDoctor`, `handleStats` and `buildDoctorReportFactory` (`apps/server/src/server/bootstrap.ts:510-578`) MUST be byte-identical. Renaming a payload field is explicitly rejected (design D2) — if the diff touches a field name, back it out.
- [x] 1.4 Confirm neither disclosure was added via a zod `.describe()`. `grep -n 'describe(' apps/server/src/mcp/observability-tools.ts` SHALL return no hit on `doctorOutput` or `statsOutput`; the spec forbids the schema-only channel twice (`openspec/specs/mcp-api/spec.md:387` and `:902`).

## 2. Test the obligations separately

- [x] 2.1 Add `it('memory.doctor description discloses the server-wide population and names memory.stats', …)` to `apps/server/src/test/mcp-integration.test.ts`, beside the four existing description-content tests (`:175`, `:193`, `:214`, `:230`) and modelled on `:230`. Read the description from a live `tools/list` response, never from a constant. Assert each obligation as its OWN expectation so one can fail without the others: (a) `expect(desc).not.toMatch(/llm/i)`; (b) the server-wide semantics; (c) `expect(desc).toContain('memory.stats')`; (d) `expect(desc).toContain('entities')`, `toContain('sessions')`, `toContain('review')`.
- [x] 2.2 In the same test, add the payload-agreement control: call `memory.doctor` and assert `'llm' in payload === false`, so the test proves the description and the payload agree rather than only that a substring is absent. The existing assertion at `:1192` covers the payload half already — the point of repeating it here is that this test fails if the two ever diverge again.
- [x] 2.3 Add `it('memory.stats description names its queue-depth totals and the divergence', …)` asserting `toContain('needsReviewTotal')`, `toContain('pendingJudgmentsTotal')`, the retained scoped wording, and `toContain('memory.doctor')`.
- [x] 2.4 Include a control that must pass in both tests: assert the description is non-empty and that `tools/list` returned the tool at all. A `tools.find(...)` that returns `undefined` makes `desc` the empty string, and every `not.toMatch` then passes vacuously — the exact failure mode CLAUDE.md records (three tests passed while proving nothing).
- [x] 2.5 Do NOT assert the description verbatim. A full-string equality test pins wording rather than behaviour and will be edited away the first time the text is reworded; assert the obligations.

## 3. Prove the tests fail without the fix (mutation)

Each command below runs from the repo root. `--file` resolves relative to the repo root, `--spec` relative to `apps/server`. `mutate.mjs` exits non-zero if a mutation reddens NOTHING **or** if the `find` string does not match exactly once — both outcomes are findings, not tooling noise. Adapt each `find` to the wording actually landed in task 1.

- [x] 3.1 Restore the exact current defect and confirm the no-`LLM` assertion goes red:

  ```
  node scripts/mutate.mjs --file apps/server/src/mcp/server.ts \
    --spec src/test/mcp-integration.test.ts \
    --mutation 'DB/embeddings/entities/consolidation health' \
    --with 'DB/LLM/embeddings/consolidation health'
  ```

- [x] 3.2 Remove the server-wide disclosure and confirm red:

  ```
  node scripts/mutate.mjs --file apps/server/src/mcp/server.ts \
    --spec src/test/mcp-integration.test.ts \
    --mutation 'SERVER-WIDE (all projects + global)' --with 'scoped'
  ```

- [x] 3.3 Remove the `memory.stats` cross-reference and confirm red — this is the obligation most likely to be trimmed for length, so it needs its own case:

  ```
  node scripts/mutate.mjs --file apps/server/src/mcp/server.ts \
    --spec src/test/mcp-integration.test.ts \
    --mutation 'memory.stats carries the scoped equivalents' --with 'counters may differ'
  ```

- [x] 3.4 Remove the newly named blocks and confirm red (one mutation per block name if a single string cannot be matched uniquely).
- [x] 3.5 Remove `memory.stats`' two totals and confirm the task-2.3 test goes red:

  ```
  node scripts/mutate.mjs --file apps/server/src/mcp/server.ts \
    --spec src/test/mcp-integration.test.ts \
    --mutation 'needsReviewTotal, pendingJudgmentsTotal, ' --with ''
  ```

- [x] 3.6 Record the mutation output in the change folder (which test name went red for each mutation). A mutation that reddens nothing means the assertion for that obligation is not real — fix the test, do not weaken the task.

## 4. Measure the descriptions against the cap

- [x] 4.1 Measure both final strings with `String.length` (UTF-16 code units, not bytes — the client compares `String.length`) and record the two numbers. Expected from design: doctor ≈ 391, stats ≈ 242, against `DESCRIPTION_MAX_LENGTH = 1900` (`apps/server/src/mcp/server.ts:124`). Both MUST be under the cap with the margin the `:1938` requirement describes.
- [x] 4.2 Confirm the existing cap guard covers them without modification: `pnpm vitest run src/test/mcp-integration.test.ts -t 'keeps every tool description under the client truncation ceiling'` (from `apps/server`). It derives from a live `tools/list` over every registered tool (`:307-329`), so no new assertion is needed there.
- [x] 4.3 Do NOT raise `DESCRIPTION_MAX_LENGTH`. If a clause does not fit, cut prose — the delta and `openspec/specs/mcp-api/spec.md:1938` both require this direction, and the latter states raising the cap to clear a CI failure without re-verifying the client ceiling does not satisfy the requirement.

## 5. Verification

- [x] 5.1 `pnpm run typecheck`
- [x] 5.2 `pnpm run lint`
- [x] 5.3 `pnpm test`
- [x] 5.4 `pnpm run check:spec-provenance` (CI-gated) and `pnpm run check:delta-freshness`.
- [x] 5.5 `pnpm run eval` is deliberately NOT required: this change touches no retrieval path — no ranking, no FTS, no vector read, no scoring. Recorded so the omission reads as a decision rather than an oversight.

## 6. Real Docker smoke against pre-existing seeded data (standing requirement — MCP surface)

Use the `rembric-smoke-tests` skill for bring-up and teardown rather than improvising them. **Operator note:** `pnpm run dev:docker:up` runs `seed-dev --reset` inside the container command, so it WIPES and reseeds `data-dev` on every boot — never point this at a directory holding a real corpus. If bring-up fails with `SQLITE_CANTOPEN`, the data dir needs `chown -R 10001:10001 data-dev`.

- [x] 6.1 Bring the stack up and confirm the running image contains the new code, not a cached layer.
- [x] 6.2 Over a real MCP connection (not by calling the handler directly — a direct call bypasses the registration layer and proves nothing about what `tools/list` returns), fetch `tools/list` and assert `memory.doctor`'s description carries all four obligations and `memory.stats`' carries its three. This is the boundary the real client uses.
- [x] 6.3 **Assert the new claim is TRUE against real data, not just present.** From a path-scoped connection (`/mcp/<slug>`), call both `memory.doctor` and `memory.stats` and confirm the divergence the description now advertises: `doctor.review.pendingJudgments >= stats.pendingJudgmentsTotal` and `doctor.sessions.active >= stats.sessionsByStatus.active`. A description that promises a divergence the deployment does not exhibit is the same class of defect as the `LLM` claim.
- [x] 6.4 **Control that must pass, or 6.3 is vacuous:** confirm the seeded corpus has more than one project AND non-zero pendings in at least two distinct scopes, so at least one comparison in 6.3 is a STRICT inequality. Two zeroes satisfy `>=` while proving nothing. If the seed does not produce this, create the second scope's rows before asserting, and record the counts observed on both sides.
- [x] 6.5 Confirm no migration ran and no derived index was rebuilt on this boot — `memory_fts`, `memory_vec` and the three entity tables MUST be untouched. This change has no migration; a migration appearing in the log means something outside the change's scope was edited.
- [x] 6.6 Record the observed doctor and stats counter values in the change folder as the smoke evidence, then tear the stack down.

## 7. Explicitly out of scope — do not drift into these

- [x] 7.1 Confirm the landed diff renames NO payload field. Issue #306's option A (`sessions.activeAllScopes` and siblings) is rejected outright, not deferred to a follow-up phase — it is wire-breaking on a tool with a declared `outputSchema` and no version negotiation, and the uniform suffix is false for `pendingJudgments`, which diverges on two axes (design D2).
- [x] 7.2 Confirm no `scope` field was added to the doctor payload. Option B is rejected: `scope` already means "the scope that resolved for this call" on three other MCP payloads (design D3).
- [x] 7.3 Confirm no doctor counter was re-scoped. The server-wide semantics stay exactly as specified at `openspec/specs/data-access/spec.md:46`, `openspec/specs/memory/spec.md:985` and `openspec/specs/mcp-api/spec.md:770`.
- [x] 7.4 Confirm the dashboard's parallel `collectStats` struct (`apps/server/src/server/bootstrap.ts:580-599`) is unchanged. The operator surface is always server-wide, so there is nothing to disclose there (design Non-Goals).
- [x] 7.5 Deferred, named so they are not silently lost — both are design Open Questions, neither is part of this change: (1) adding a runtime assertion for `sessions.active`, which today has none anywhere (only a docstring at `observability-tools.ts:88` and two comments at `db/repositories/agent-sessions-repository.ts:259` and `services/agent-sessions.ts:595`); (2) a general `mcp-api` requirement that no tool description may assert a field its output contract forbids, which would catch the NEXT `llm`-style drift rather than this one.

## 8. Wrap up

- [ ] 8.1 Commit with a Conventional Commit subject scoped to the MCP surface (e.g. `fix(mcp): say which population memory.doctor's counters cover`). Never bypass the git hooks. **Not done in the apply session — the operator explicitly withheld commit/push; the working tree carries the change.**
- [x] 8.2 Do NOT add explanatory comments to `server.ts` alongside the new strings. Per repo policy the rationale lives in the spec, and the description text is now self-describing; a comment restating it is the anti-pattern.
- [ ] 8.3 Reference `Closes #306` in the PR description (English, as required for all PR titles and descriptions). **Deferred with 8.1 — no commit, no branch, no PR opened in the apply session.**
