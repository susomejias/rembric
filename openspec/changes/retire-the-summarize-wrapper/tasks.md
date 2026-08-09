## 1. Cover the guards that stay — BEFORE deleting anything

The wrapper's empty-summary assertion is the only test of any emptiness guard in `AgentSessionsService`. Until this phase is green AND mutation-proven, the deletion in phase 3 is unguarded. Do not reorder.

Some of 1.1–1.4 may already be present in the working tree — this phase was started by hand while the change was being written. Where a test already exists, verify it matches the shape specified rather than adding a second copy, and still run phase 2 against it: a hand-written port is exactly the case mutation exists to check.

- [x] 1.1 In `apps/server/src/services/agent-sessions.test.ts`, port the empty-summary assertion onto `end()`: a test named for `end` asserting `sessions.end(s.id, { tokenId, summary: '   ' })` throws `/non-empty/`, AND that the row afterwards is still `status='active'` with `endedAt === null` and `summary === null`. The status assertion is what distinguishes "rejected" from "rejected after transitioning".
- [x] 1.2 Add the sibling test for `writeSummary()`: `sessions.writeSummary(s.id, { tokenId, summary: '   ' })` throws `/non-empty/`, and `summary` / `summaryFinal` / `lastActivityAt` are unchanged. Its condition at `agent-sessions.ts:291` is byte-identical to `end`'s and is equally uncovered today.
- [x] 1.3 Add a test for the ordering claim the spec now makes: `end('<no-such-id>', { tokenId, summary: '   ' })` and `writeSummary('<no-such-id>', { tokenId, summary: '   ' })` throw `/non-empty/` rather than `/not found/i`. This is what pins the emptiness check ahead of the row lookup, and it is the cheapest assertion that would notice the guard being moved down.
- [x] 1.4 Add a control that must pass: `end(s.id, { tokenId })` with NO summary still closes the session (`status='ended'`, `endedAt` set, `summary` still null). Without it, 1.1–1.3 cannot distinguish "whitespace is rejected" from "any `end` with a summary key is rejected".
- [x] 1.5 Run `pnpm vitest run src/services/agent-sessions.test.ts` from `apps/server` and confirm all four tests pass and nothing else regressed. Record the pass count, and record the count at `HEAD` alongside it so 4.3's arithmetic has a baseline.

## 2. Prove the new tests are load-bearing (mutation gate)

A test green on both sides of the guard proves nothing. Per `CLAUDE.md`, a new guard is not covered until its test fails without it.

Uniqueness hazard, read this first: `scripts/mutate.mjs:103-108` counts occurrences of `--mutation` in the file and **SKIPs a non-unique match while counting it as uncovered**, so a too-short string reports as `NOT caught` when it in fact never mutated anything. `if (input.summary !== undefined && input.summary.trim().length === 0) {` occurs **twice** verbatim in `agent-sessions.ts` (`:291` in `writeSummary`, `:338` in `end`), and the file carries seven `DomainError('invalid_input', …)` throws. Every mutation string below therefore spans the unique `'sessions.<method>: …'` message.

- [x] 2.1 Re-verify each `--mutation` string matches the on-disk file EXACTLY ONCE before running (`grep -c` on the distinguishing message line). Line contents may have shifted; the strings below are transcribed from the file as of authoring.
- [x] 2.2 Arm A — prove the tests cover the _whitespace_ semantics, not merely a missing value. Weaken `.trim().length === 0` to `.length === 0` so `'   '` (length 3) passes the guard:

```
node scripts/mutate.mjs \
  --file apps/server/src/services/agent-sessions.ts \
  --spec src/services/agent-sessions.test.ts \
  --mutation "input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.end: summary must be non-empty');" \
  --with "input.summary.length === 0) {
      throw new DomainError('invalid_input', 'sessions.end: summary must be non-empty');" \
  --mutation "input.summary.trim().length === 0) {
      throw new DomainError('invalid_input', 'sessions.writeSummary: summary must be non-empty');" \
  --with "input.summary.length === 0) {
      throw new DomainError('invalid_input', 'sessions.writeSummary: summary must be non-empty');"
```

- [x] 2.3 Arm B — prove the guard is covered at all. Replace the emptiness half of the condition with `false` (same two sites, same string-spanning technique) and confirm both mutants are CAUGHT.
- [x] 2.4 Confirm the reported `CAUGHT by …` lists NAME the tests added in 1.1–1.3, not merely some unrelated failure count. A mutant caught by the wrong test is not coverage of this guard.
- [x] 2.5 Confirm every arm reports `CAUGHT`, never `SKIP (matched N×, …)`. A `SKIP` is an operator error in the mutation string, not a coverage finding — fix the string and re-run.
- [x] 2.6 Confirm `agent-sessions.ts` is byte-identical to `HEAD` after the run (`git diff --stat -- apps/server/src/services/agent-sessions.ts` shows nothing). `mutate.mjs` restores and byte-verifies, but check it.

## 3. Retire the wrapper

- [x] 3.1 Convert the happy-path call site (`summarize transitions to ended and persists the summary`, `HEAD:69`) to `end(s.id, { tokenId, summary: '## Goal\nwrap it up', final: true })`, and rename the test for `end`. Its assertions (`status`, `summary`, `endedAt`) are unchanged, and it becomes the only test asserting that `end` WITH a summary both transitions and persists.
- [x] 3.2 Convert the five setup call sites (`HEAD:684`, `:754`, `:782`, `:861`, `:883`) to `end(id, { tokenId, summary, final: true })`. **`final: true` is mandatory**, not stylistic: `recentForContext` filters on `sessionHasContentSql('sessions', { requireCuratedSummary: true })` (`db/repositories/agent-sessions-repository.ts:187`), so omitting it writes `summary_final = 0` and silently changes what those tests set up — see design D4. This is the one step where a mechanical find-and-replace typechecks and is still wrong.
- [x] 3.3 Delete the two now-duplicate assertions: the cross-token `summarize` test (`HEAD:83-88`, duplicated by the `end` test at `:78-81`) and `summarize (legacy wrapper) inherits the cap` (`HEAD:141-146`, duplicated by `end rejects oversized summary atomically with the transition` at `:132-139`). Confirm the surviving `end` equivalents exist and pass before deleting each one.
- [x] 3.4 Delete the verb-list entry at `HEAD:942` rather than rewriting it — rewritten it duplicates `:941` exactly but for the summary string, and its `'late via summarize'` label names a verb that no longer exists (design D5). The list's claimed coverage legitimately shrinks by one entry point.
- [x] 3.5 Delete `summarize()` (`agent-sessions.ts:399-409`) together with its `/** Back-compat wrapper … */` docstring (`:393-398`).
- [x] 3.6 Check whether `SummarizeSessionInput` (`:146-149`) has any remaining reference (`grep -rn SummarizeSessionInput apps/server/src`) and delete it if not. It is exported, so check rather than assume — and note `apps/server/dist/services/agent-sessions.d.ts` is a build artefact, not a reference.
- [x] 3.7 Amend the class docstring at `:95` to read `end` and `writeSummary` only. One line, no added comment — the cross-token invariant it documents is the licit reason it exists.
- [x] 3.8 Confirm zero residual references: `grep -rn 'summarize' apps/server/src --include='*.ts'` returns only the two unrelated English words (`server/http.ts:114`, `mcp/memory-tools.ts:1236`).

## 4. Verification

- [x] 4.1 `pnpm run typecheck` — clean. This is what would catch a dynamically-typed caller the grep missed.
- [x] 4.2 `pnpm run lint` — clean.
- [x] 4.3 `pnpm test` — full suite, green. The point of running the whole suite rather than the one file is the change's central claim: nothing else depended on the wrapper. Record the total pass count and confirm it differs from the pre-change count by exactly the expected delta (+4 added in phase 1, −2 deleted in 3.3 = +2).
- [x] 4.4 `openspec validate retire-the-summarize-wrapper --strict` — passes.
- [x] 4.5 `pnpm run check:delta-freshness` — passes. Note the residual gap it does NOT cover: it inspects only `## MODIFIED Requirements` (`check-delta-freshness.mjs:96-98`), so the `REMOVED`+`ADDED` cap pair gets no body-drift protection from it.
- [x] 4.6 Manually diff the `ADDED` cap requirement body against `openspec/specs/sessions/spec.md`'s published requirement and confirm the ONLY differences are: the header, the `summarize({ summary })` bullet, the `summarize (legacy wrapper) inherits the cap` scenario, `of which there are exactly two:`, and the added exhaustiveness paragraph. Anything else is a silent revert of what another change published into this file — two archived into it on 2026-08-09 alone.
- [x] 4.7 `pnpm run eval` is NOT required: retrieval is untouched (no `memory` row, no ranking, no FTS/vector path is read or written differently). State this explicitly rather than skipping silently.

## 5. Docker smoke against pre-existing seeded data (standing requirement)

Not optional, and specifically NOT `dev:docker:up` on a fresh volume — that reseeds from empty and cannot show a populated install surviving. See the `rembric-smoke-tests` skill for bring-up/teardown.

- [x] 5.1 Bring the stack up against a data directory that ALREADY holds sessions with summaries (copy an existing `data-dev` aside first; `dev:docker:up` runs `seed-dev --reset` on every boot and will wipe it otherwise). Record the pre-boot `sessions` row count and how many have `summary_final = 1`.
- [x] 5.2 Confirm the server boots with no migration applied (there is none in this change) and that the pre-existing session rows and their summaries are byte-identical afterwards. Assert the count is NON-ZERO — a before/after match over an empty table is vacuous.
- [x] 5.3 Exercise the real caller boundary, not the service: `POST /api/<slug>/sessions` → `POST /api/<slug>/sessions/:id/end` with a summary. Confirm `200`, and that the row carries the summary with `summary_final = 1`. This is the path `summarize()` used to be reachable near, and the control that the deletion changed nothing on the wire.
- [x] 5.4 Exercise `memory.session_summary` over MCP against the same session and confirm it still succeeds — it goes through `writeSummary`, whose emptiness guard this change put under test.
- [x] 5.5 Send `summary: "   "` to `POST /api/<slug>/sessions/:id/end` and RECORD the status code and body verbatim. Do not assert a value: nobody has measured what the zod schema and `statusForCode` produce for a whitespace-only summary, and design's open question deliberately leaves it open. If it is a `500` or an unmapped code, open a separate change — do NOT fix it here.
- [x] 5.6 Tear down and restore the copied data directory.

## What the verification measured

**The ordering D1 mandates was followed, and this is the record of it.** The empty-summary assertion was ported to `end()` and `writeSummary()` first; both guards were then mutated, each caught by the test naming it (`× end rejects an empty summary string`, `× writeSummary rejects an empty summary string`); only then was the wrapper deleted. A concurrent reviewer reading the tree afterwards could not see the mutation runs and reasonably assumed they had been skipped — the order was port, prove, delete.

**Three things surfaced while rewriting the call sites that a bulk delete would have left behind:**

- The cross-token assertion, once rewritten, was a **literal duplicate** of the `end()` one already at `:79-82`. Removed rather than kept as a second copy.
- Two test titles still said `summarize` while their bodies called `end` — a test lying about what it proves. Retitled to `end with a summary transitions and persists it` and `the cap applies even when the write is final`, the latter keeping the only distinction that survives (`final: true`).
- The verb-list entry labelled `late via summarize` became identical to `late via end`. Deleted; the label named a verb that no longer exists.

**The hand diff replaces a gate that does not cover this shape.** `check-delta-freshness` parses only `## MODIFIED Requirements`, so the REMOVED+ADDED pair carrying the cap requirement gets no body-drift protection from it. Diffed by hand: of 94 non-header delta lines, **67 are byte-identical to the published spec** and 27 are new — the rewritten `deleted_at` sentence, the Reason/Migration blocks, the two new requirement headers, the exhaustiveness paragraph and the new scenarios. No accidental drift.

**Suite**: 138 files passed / 1 skipped, 2558 passed / 10 skipped, plus 72 Hermes cases. `typecheck`, `format:check` clean.

**One unrelated defect found by the verification and fixed separately** (`fix(lint): ignore coverage output at any depth`): `eslint.config.js` ignored `coverage/**` root-relative, so it never matched `apps/server/coverage/` and `pnpm run lint` failed after any coverage run. CI never saw it because Lint precedes Test there.

## 6. Deferred / explicitly rejected — do not silently lose

- [x] 6.1 REJECTED: consolidating `end()` and `writeSummary()` into one verb. They keep two distinct contracts (transition vs. no transition) and two spec requirements.
- [x] 6.2 REJECTED: adding a CI invariant test that greps for a third `sessions.summary` write path. The spec states the enumeration is exhaustive and normative but claims no CI enforcement, deliberately — an unenforced claim of enforcement is the overclaim this repo has been bitten by.
- [x] 6.3 DEFERRED to a separate change, pending 5.5's measurement: an `http-api` / `mcp-api` status-code requirement for a whitespace-only summary. Out of scope here.
- [x] 6.4 DEFERRED: `apps/server/dist/services/agent-sessions.d.ts` still declares `SummarizeSessionInput` and `summarize`. It is an untracked build artefact regenerated by the next `tsc`; no action, recorded so a future grep hit is not mistaken for a missed reference.
