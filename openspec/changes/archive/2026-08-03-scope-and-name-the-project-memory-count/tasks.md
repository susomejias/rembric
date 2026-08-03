## 1. Replace the unscoped read with a scoped one

- [x] 1.1 Replace `MemoryRepository.countByProject()` (`apps/server/src/db/repositories/memory-repository.ts:252-261`) with the scoped read from design D1: `countActiveInScope(scope: MemoryScope, projectId: string | null): number`, filtered by `and(scopeCondition(scope, projectId), eq(memory.status, 'active'))` using `scopeCondition` from `./scope-clause.js` (already imported at `:14`). Place it beside `countByStatusAndTypeInScope` (`:225`) so the family reads together. Do NOT add a prefix — design D3.
- [x] 1.2 Replace the doc comment. The current one (`:252`) promises "active+total memory counts", which the query implements in neither dimension; the replacement documents one concrete fact only (what the count filters), per the repo's comment policy. Do NOT write a banner or restate the signature.
- [x] 1.3 Rewrite `handleList` (`apps/server/src/mcp/project-tools.ts:193-215`) to call the scoped read once per authorized project row with `('project', p.id)`. The `isAuthorized` filter at `:198-200` MUST stay ABOVE the counting, not become a post-filter (design D2; `data-access` delta scenario "The scope reaching the read comes from an already-authorized project row"). Delete the batched `reduce` at `:201-205`.
- [x] 1.4 Confirm `handleList` calls neither `resolveEffectiveProject` nor `scopeFromContext` nor reads `ctx.project`. `grep -n 'resolveEffectiveProject\|scopeFromContext\|ctx.project' apps/server/src/mcp/project-tools.ts` MUST show no hit inside `handleList`. `project.list` must keep working on `/mcp/no-such-project` (`openspec/specs/mcp-api/spec.md:85`, pinned by `apps/server/src/mcp/unresolvable-slug.test.ts:233-246`).
- [x] 1.5 Rename the output field: `memoryCount: z.number()` → `activeMemoryCount: z.number()` in `projectListOutput` (`apps/server/src/mcp/project-tools.ts:55`) and in the emitted object (`:212`). **BREAKING** wire change, accepted in design D5.
- [x] 1.6 Update `project.list`'s registered description (`apps/server/src/mcp/server.ts:433-434`) to say the count is of **active** memories. Top-level description string only, never a zod `.describe()` — `openspec/specs/mcp-api/spec.md:387` and `:902`. Measure the new string's `String.length` and record it against `DESCRIPTION_MAX_LENGTH = 1900` (`apps/server/src/mcp/server.ts:124`).
- [x] 1.7 Do NOT add a second count. No `totalMemoryCount`, no `memoriesByStatus` on this payload — design D4. If the diff adds one, back it out.
- [x] 1.8 Confirm nothing else changed: `git diff --name-only` SHALL list only `apps/server/src/db/repositories/memory-repository.ts`, `apps/server/src/mcp/project-tools.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/test/invariants.test.ts`, the test files from tasks 2–3, and the change folder. In particular `apps/server/src/db/repositories/agent-sessions-repository.ts:266` and `apps/server/src/services/agent-sessions.ts:604` (the unrelated per-session `memoryCount`) MUST be byte-identical — design Open Question 3.

## 2. Integration test through the MCP boundary

Go through the real boundary — an in-process server via `createServer` driven by the official MCP SDK `Client` over `StreamableHTTPClientTransport`, as `apps/server/src/test/mcp-integration.test.ts` already does. Calling `projectHandlers.list({})` directly bypasses the tool's zod schemas and proves nothing about the tool. `apps/server/src/mcp/authorization.test.ts:348-381` is the right home for the token-scope cases (it already drives `projectHandlers` under `runWithContext`); `mcp-integration.test.ts` is the right home for the archive case.

- [x] 2.1 **The defect case.** Two projects: `p` with exactly one `active` memory, `q` with two. Call `project.list`; assert `activeMemoryCount` is 1 for `p`. Call `memory.archive` on `p`'s only memory. Call `project.list` again; assert `activeMemoryCount` is now **0** for `p`. This is the exact divergence measured in issue #310.
- [x] 2.2 **The control that makes 2.1 non-vacuous.** In the same test assert `q`'s `activeMemoryCount` is 2 **both before and after** the archive, and assert the pre-archive value for `p` is non-zero. A test that only checks the post-archive `0` passes when the whole result set is empty or the project entry is missing — the failure mode `CLAUDE.md` records (three tests passed while proving nothing).
- [x] 2.3 **The entry must exist.** Assert `project.list` returned an entry for `p` at all (`expect(entry).toBeDefined()`) before reading its count. `find(...)` returning `undefined` makes every count assertion vacuous.
- [x] 2.4 **Agreement with `memory.stats`.** From a connection resolving to `p`, call `memory.stats` and assert `activeMemoryCount` for `p` equals `memoriesByStatus.active`. Also assert `activeMemoryCount` is strictly less than `p`'s total row count while an archived row exists, so the `status` filter is observable rather than vacuous.
- [x] 2.5 **Global rows are excluded.** With at least one `active` global memory present, assert no entry's `activeMemoryCount` includes it. The old predicate already excluded global rows; this pins that it stays excluded (design Non-Goals).
- [x] 2.6 **The old key is gone.** Assert `'memoryCount' in entry === false` for every entry. The rename is the load-bearing half; a payload carrying both keys would defeat design D5.
- [x] 2.7 **Token scoping.** Extend `apps/server/src/mcp/authorization.test.ts:348-381` so each of the four token shapes asserts the count as well as the slugs: `*` and `read:*` see both projects with their own counts; `project:<p.id>` and `read:project:<p.id>` see only `p` with `p`'s count.
- [x] 2.8 **Unresolvable slug.** Extend `apps/server/src/mcp/unresolvable-slug.test.ts:233-246` to assert `project.list` still succeeds AND returns `activeMemoryCount` for the readable projects on a connection whose slug resolves to nothing. Today that test asserts only `isError === false`.
- [x] 2.9 **Description content.** Add an assertion that `project.list`'s description from a live `tools/list` response conveys the active-memory filter, modelled on the existing description-content tests at `apps/server/src/test/mcp-integration.test.ts:175`, `:193`, `:214`, `:230`. Read it from `tools/list`, never from a constant. Do NOT assert the string verbatim.

## 3. Mutation — prove each condition is covered, one at a time

Each command runs from the repo root; `--file` resolves relative to the repo root and `--spec` relative to `apps/server`. `scripts/mutate.mjs` exits non-zero when a mutation reddens NOTHING **or** when the `find` string does not match exactly once — both are findings, not tooling noise. Adapt each `find` to the code actually landed in task 1. **Weaken one condition per run**; a combined mutation cannot tell you which assertion did the work. A test green on both sides of the change is the default outcome, not the exception.

- [x] 3.1 Weaken the `status` condition and confirm a test naming it goes red:

  ```
  node scripts/mutate.mjs --file apps/server/src/db/repositories/memory-repository.ts \
    --spec src/test/mcp-integration.test.ts \
    --mutation "eq(memory.status, 'active')" --with "sql\`1 = 1\`"
  ```

  Expected red: task 2.1's post-archive `0` and task 2.4's strict-inequality assertion.

- [x] 3.2 Weaken the **scope** condition, separately, and confirm red:

  ```
  node scripts/mutate.mjs --file apps/server/src/db/repositories/memory-repository.ts \
    --spec src/test/mcp-integration.test.ts \
    --mutation 'scopeCondition(scope, projectId)' --with 'isNotNull(memory.projectId)'
  ```

  Expected red: task 2.5 (global rows) and task 2.1/2.2 (`q`'s rows leaking into `p`'s count). If NOTHING reddens, the scope condition is uncovered — add the assertion, do not weaken the task. Note that scope and status are independent: a corpus where every project holds only `active` rows makes 3.1 unreddenable, and one with a single project makes 3.2 unreddenable, so the fixtures for both must have at least two projects AND at least one non-`active` row.

- [x] 3.3 Move the authorization filter BELOW the counting (design D2's ordering) and confirm red:

  ```
  node scripts/mutate.mjs --file apps/server/src/mcp/project-tools.ts \
    --spec src/mcp/authorization.test.ts \
    --mutation ".filter((p) => isAuthorized(ctx.scope, 'read', { scope: 'project', projectId: p.id }))" --with ""
  ```

  Expected red: task 2.7's two project-scoped cases. This is the mutation that proves the handler is not self-authorizing.

- [x] 3.4 Remove the description clause and confirm task 2.9 goes red (`--mutation '<the active clause>' --with ''`).
- [x] 3.5 Record, in this change folder, which named test went red for each mutation above. A mutation that reddens nothing is a finding about the test, not about the tooling.

## 4. Move the invariant inventory in lock-step

The inventory asserts SET EQUALITY (`apps/server/src/test/invariants.test.ts:693-697`: "both directions fail: an unlisted read, and a listed read that is gone"), so source and inventory must change in one commit.

- [x] 4.1 Delete `apps/server/src/test/invariants.test.ts:726`, verbatim today:

  ```ts
    'memory-repository.ts::countByProject', // known violation: reached from mcp/project-tools.ts, to be fixed separately
  ```

- [x] 4.2 **Verify direction one:** with the source fix in place, temporarily restore the inventory line and confirm `pnpm vitest run src/test/invariants.test.ts -t 'the unscoped, un-keyed, unprefixed reads are exactly the inventory'` FAILS (a listed read that is gone). Restore.
- [x] 4.3 **Verify direction two:** with the inventory line deleted, temporarily revert the repository method to its unparameterised form and confirm the same test FAILS (an unlisted read). Restore. If either direction passes, the inventory is not actually gating and that is the finding.
- [x] 4.4 Confirm the new method's parameter text is what makes it undetected, not its spelling: `unscopedUnprefixedReads` (`apps/server/src/test/invariants.test.ts:760-780`) skips a method matching `/\b(scope|projectId|partitionKey)\b/` on its parameters (`:774`). The new signature matches on both words. Do NOT rely on the `/\b\w*[Ii]ds?\b/` branch at `:775` — that is the key-bounded branch, which is the rejected fallback shape (design D1 Alternative A).
- [x] 4.5 **Report which way the `admin*` confinement gate falls.** Run `pnpm vitest run src/test/invariants.test.ts -t 'admin-method confinement invariant'` and state explicitly in the change folder that the gate (`:623-679`, pattern `/\.(admin[A-Z]\w*)\(/g`) **correctly does not see** the new method, because the method is not `admin`-prefixed and needs no allow-list entry — and that `ADMIN_CALL_SITES` (`:625-645`) gained no entry for `mcp/project-tools.ts`. This is the required answer, not a finding: design D3 rejects the `admin` prefix. If the gate reports an offender, something was renamed against D3.
- [x] 4.6 Confirm `openspec/specs/data-access/spec.md:47` needs no change. Its clause "SHALL mark any entry that is also a violation of the `admin`-prefix rule above" is conditional and is satisfied vacuously once no inventory entry is a violation. Re-verify by grepping for comments inside the inventory block (`:718-738`); `memory-repository.ts::countByProject` is the only line carrying a violation marker today, so after 4.1 there are none.

## 5. Measure the shape (design D1 — the number this change must produce)

Design D1 chose the per-scope loop on **clarity**, explicitly deferring the measurement. This section is that measurement. One instrument per row, named — never mix an isolated statement's timing with an end-to-end figure in one table (`CLAUDE.md`).

- [x] 5.1 Capture `EXPLAIN QUERY PLAN` for the new count statement and record it. The prediction from design D1 is a range scan over `memory_scope_project_status_created_idx` (`apps/server/src/db/schema/memory.ts:91-96`), not a table scan. Record what the planner actually says; a `SCAN memory` is a finding.
- [x] 5.2 Record **end-to-end `project.list` wall-clock** (the figure a caller waits on) before and after, at a realistic project count and at a deliberately unrealistic one — e.g. 5 and 50 projects with a populated `memory` table. State the instrument, the row count, and the percentile. Label the row "end-to-end `project.list`", not "count query".
- [x] 5.3 State the conclusion in one sentence: whether the N-query loop is materially worse than the grouped query it replaced at the realistic project count. **If it is**, do NOT silently swap shapes — design D1's fallback (`countActiveByProjectIds(projectIds)`, one grouped statement) requires a `data-access` spec amendment plus these recorded figures, per `openspec/specs/data-access/spec.md:157` ("the numbers and the instrument that produced them are [the standard], and they SHALL be recorded with the change that admits the read"). Stop and hand back rather than deciding it inside the apply phase.
- [x] 5.4 Do NOT add an index. If the measurement suggests one, that is a separate change and belongs to `db-performance-auditor`, which measures the alternative rather than assuming it.

## 6. Verification

- [x] 6.1 `pnpm run typecheck`
- [x] 6.2 `pnpm run lint`
- [x] 6.3 `pnpm test`
- [x] 6.4 `pnpm run check:spec-provenance` and `pnpm run check:delta-freshness`.
- [x] 6.5 `pnpm run eval` is deliberately NOT required: this change touches no retrieval path — no ranking, no FTS, no vector read, no scoring, no `hybrid-search`. Recorded so the omission reads as a decision rather than an oversight.

## 7. Real Docker smoke against pre-existing seeded data (standing requirement — MCP surface)

Use the `rembric-smoke-tests` skill for bring-up and teardown rather than improvising them. **Operator note:** `pnpm run dev:docker:up` runs `seed-dev --reset` inside the container command, so it WIPES and reseeds `data-dev` on every boot — never point it at a directory holding a real corpus. If bring-up fails with `SQLITE_CANTOPEN`, the data dir needs `chown -R 10001:10001 data-dev`. Operator-only: requires Docker on the host.

- [x] 7.1 Bring the stack up and confirm the running image contains the new code, not a cached layer.
- [x] 7.2 Over a **real MCP connection** (not by calling the handler directly), fetch `tools/list` and assert `project.list`'s description carries the active-memory clause. This is the boundary the real client uses.
- [x] 7.3 Call `project.list` and assert every entry carries `activeMemoryCount` and no entry carries `memoryCount`.
- [x] 7.4 **Assert the new number is TRUE against the seeded corpus, not merely present.** For at least one seeded project, cross-check `activeMemoryCount` against `memory.stats`' `memoriesByStatus.active` from a connection resolving to that project. They MUST be equal.
- [x] 7.5 **Control that must pass, or 7.4 is vacuous:** confirm the seeded corpus holds more than one project AND at least one non-`active` memory (`superseded` or `archived`), so at least one project's `activeMemoryCount` is strictly less than its total row count. Record both numbers. Two equal-and-zero readings satisfy the assertion while proving nothing. If the seed does not produce a non-`active` row, archive one over MCP first and record the before/after counts.
- [x] 7.6 Confirm no migration ran and no derived data was rebuilt on this boot — `memory_fts`, `memory_vec` and the three entity tables MUST be untouched. This change has no migration; a migration in the log means something outside its scope was edited.
- [x] 7.7 Record the observed counts in the change folder as the smoke evidence, then tear the stack down.

## 8. Confirm no plugin change

- [x] 8.1 Re-run the blast-radius grep and record the result: `grep -rn memoryCount . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=archive` — expect **zero** hits under `apps/plugin/`, `docs/` and `README.md`. Zero plugin hits means the four-client shared-resource rule and the unified `plugin` version track are not in play, and no plugin release is implied by this change.
- [x] 8.2 Confirm the remaining hits are only: this change's own files, `apps/server/src/db/repositories/agent-sessions-repository.ts:266` + `apps/server/src/services/agent-sessions.ts:604` (unrelated per-session count, untouched), and the local counter variable in `apps/server/src/scripts/seed-dev.ts` (`:193`, `:206`, `:249`, `:349`, `:417`, `:425`) — which is a seeder log field, not this payload.
- [x] 8.3 Confirm `git ls-files apps/plugin/ | wc -l` is unchanged and `git diff --name-only apps/plugin/` is empty.

## 9. Explicitly out of scope — do not drift into these

- [x] 9.1 Confirm the landed diff does NOT rename the per-session `memoryCount` (`apps/server/src/db/repositories/agent-sessions-repository.ts:266`, `apps/server/src/services/agent-sessions.ts:604`). Deliberately left open — design Open Question 3. It is key-bounded by `sessionId` and is not a scope violation; renaming it would be a second **BREAKING** wire change bundled into a fix that does not need it.
- [x] 9.2 Confirm no `needsReviewCount` or any other per-project aggregate was added to `project.list` — design Open Question 2, deliberately left open.
- [x] 9.3 Confirm the count still excludes global-scope memories, and that no `includeGlobal` widening was introduced. Global widening is an authorization decision (`openspec/changes/archive/2026-08-01-gate-global-widening-on-authorization`), not a free one.
- [x] 9.4 Confirm no requirement text in `openspec/specs/data-access/spec.md` was edited by the apply phase. Those requirements were already correct; the code disagreed with them. The delta ADDS one requirement and MODIFIES none there — design D6.
- [x] 9.5 Confirm no explanatory comment was added to `handleList` about the authorization ordering. The ordering is a spec requirement and a mutation target (task 3.3); a comment would neither fail nor be trusted, and per repo policy the rationale lives in the spec.

## 10. Wrap up

- [x] 10.1 Commit with a Conventional Commit subject scoped to the MCP surface, e.g. `fix(mcp)!: count only active memories in project.list`. The `!` marks the wire-breaking field rename. Never bypass the git hooks.

  **DEVIATION:** the `!` marker was NOT used — this repo's commitlint rejects it.
  Measured: `echo "fix(mcp)!: count only active memories in project.list" | npx commitlint`
  reports `✖ subject may not be empty [subject-empty]` and `✖ type may not be empty
[type-empty]`, i.e. the header does not parse at all. The breaking change is carried
  by a `BREAKING CHANGE:` footer instead, which the same check accepts. Subject landed:
  `fix(mcp): count only active memories in project.list`.

- [ ] 10.2 Reference `Closes #310` in the PR description (English, as required for all PR titles and descriptions), and state the **BREAKING** field rename `memoryCount` → `activeMemoryCount` explicitly in the body.
