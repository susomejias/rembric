## Context

`AgentSessionsService.summarize()` is the last survivor of a two-step refactor that split summary persistence (`writeSummary`, no transition) from session closure (`end`, transition). The wrapper kept the old combined shape alive for in-tree callers during the migration. The migration completed; the wrapper did not.

Current state, measured rather than argued:

- `summarize` has **zero production callers**. `grep -rn 'summarize' apps/server/src --include='*.ts'` outside test files returns four hits: the class docstring at `agent-sessions.ts:95`, the definition at `:399`, its own error string at `:401`, and two unrelated English words in `server/http.ts:114` and `mcp/memory-tools.ts:1236`. No MCP tool, HTTP route, dashboard handler, seed script or plugin file names it.
- All ten call sites are in `apps/server/src/services/agent-sessions.test.ts`.
- The published `sessions` spec names it three times: a body sentence (`spec.md:13`), an enumerated write path (`:764`), and a **scenario title** (`:789`).

The change is small in diff and non-trivial in shape, because the third mention forces a spec-delta operation most changes never need, and because the test inventory turned up one assertion that existed nowhere else.

## Goals / Non-Goals

**Goals:**

- Remove `summarize()` and its input type from the service surface without losing a single assertion.
- Get the emptiness guard on `end()` — and on `writeSummary()`, which is in the same state — under test, and prove that test load-bearing by mutation.
- Land a spec delta that archives cleanly: no dropped published scenario inside a `MODIFIED` block, no duplicate requirement header after merge.
- Record, for the next person who deletes something that looks dead, why the inventory came before the deletion.

**Non-Goals:**

- Re-litigating `SUMMARY_MAX_CHARS`, the head/tail truncation rule, the `summary_final` precedence rule, or the DB-`CHECK` decision. The re-added cap requirement is the published text minus two `summarize` mentions and nothing else.
- Consolidating `end()` and `writeSummary()`. They stay two verbs with two distinct contracts.
- Adding an emptiness scenario for `memory.session_end` or `POST /api/<slug>/sessions/:id/end` in the `mcp-api` / `http-api` capabilities. The guard is a service-layer precondition; specifying it once, in `sessions`, is enough.

## Decisions

### D1 — Port the assertion before deleting the wrapper, not after

The empty-summary rejection at `agent-sessions.test.ts:104` (HEAD) is the **only** test of any emptiness guard in this service. `end()` has the guard at `agent-sessions.ts:338-340`; `writeSummary()` has the byte-identical condition at `:291-293`. Neither was asserted.

Order matters because the intermediate state is the dangerous one: delete first and the tree has a live guard on a production path with zero coverage, and no signal says so. Port first and the deletion is guarded at every commit.

_Alternative considered — delete and port in one commit._ Rejected: the working tree is what matters, not the commit boundary, and a single commit still gives no evidence the port actually covers the guard. See D2.

_Alternative considered — accept the loss and not port at all, on the grounds that `writeSummary`'s emptiness path is symmetric and the HTTP/MCP zod schemas bound the input._ Rejected on the evidence bar: "the schema probably catches it" is a reading of code, and the guard is reachable from two request paths whose schemas were not checked for a whitespace-only string. The cheaper move is to test the guard.

### D2 — Prove the ported assertion with `scripts/mutate.mjs`, with mutation strings that span the unique error message

A test that is green both with and without the guard proves nothing, and per `CLAUDE.md` that is the default outcome, not the exception. So the port is verified by weakening the condition and confirming the named test goes red.

The mechanical hazard is uniqueness. `mutate.mjs:103-108`:

```js
const occurrences = pristine.split(find).length - 1;
if (occurrences !== 1) {
  console.error(`SKIP (matched ${occurrences}×, need exactly 1): ${find.slice(0, 60)}`);
  uncovered += 1;
```

A non-unique match is **skipped and counted as uncovered** — it reports as a failure, which is the correct-but-confusing outcome: the operator sees "NOT caught" and must notice it was a `SKIP`, not a green mutant. `agent-sessions.ts` makes this easy to hit: seven `DomainError('invalid_input', …)` throws (`:78`, `:205`, `:292`, `:298`, `:339`, `:345`, `:401`), and `if (input.summary !== undefined && input.summary.trim().length === 0) {` occurs **twice**, verbatim, at `:291` and `:338`.

Decision: every `--mutation` string spans the throw line, whose `'sessions.end: …'` / `'sessions.writeSummary: …'` message is unique. `tasks.md` carries the exact strings.

_Alternative considered — use `-t` to filter to one test and mutate the shared condition string._ Rejected: `-t` filters the vitest run, not the file match. Uniqueness is a property of the file text and the filter cannot rescue it.

### D3 — `REMOVED` + `ADDED` under a changed header for the cap requirement; plain `MODIFIED` for the append-only one

Three published mentions, two different shapes, two different delta operations.

`spec.md:789` is a `#### Scenario:` title. `check-delta-freshness.mjs:112-121` fails when a published scenario title is absent from a `MODIFIED` delta slice, and `openspec archive` refuses the same merge. A `MODIFIED` block therefore **cannot** drop it. `REMOVED` + `ADDED` can, and the two headers must differ because `openspec validate` rejects a same-header `REMOVED`+`ADDED` pair.

New header: `` ### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary` ``. The rename is not cosmetic — the requirement's residual claim after the edit is precisely that the enumerated list is exhaustive, and the header now says so.

`spec.md:13` is a body sentence inside `Sessions MUST be append-only`, a different requirement with its own scenarios, none of which mention `summarize`. That is a plain `MODIFIED` carrying the full requirement block verbatim with one word removed from one sentence.

_Alternative considered — `RENAMED` + `MODIFIED`._ Rejected, and this one is a trap worth recording: `check-delta-freshness.mjs:102` resolves the published slice through the `RENAMED` map (`renamedFrom.get(header) ?? header`) and then applies the dropped-scenario check to it anyway. A rename buys nothing here.

_Alternative considered — keep the `summarize` scenario and retarget it at `end`._ Rejected: `end` already has its own cap scenario at `:782-787`, so the retargeted one would be a duplicate, and its title would still name a verb that no longer exists.

_Alternative considered — leave the spec alone and delete only the code._ Rejected outright: it produces exactly the failure mode this repo has been bitten by, a spec that claims behaviour nobody implements.

### D4 — Converted setup calls MUST pass `final: true`

`summarize()` delegated with `final: true` hard-coded (`agent-sessions.ts:404-408`). Five of the seven convenience call sites (`:684`, `:754`, `:782`, `:861`, `:883` at HEAD) exist to make a session satisfy `sessionHasContent`, and `recentForContext` requires the **curated** form: `sessionHasContentSql('sessions', { requireCuratedSummary: true })` (`db/repositories/agent-sessions-repository.ts:187`). A conversion that drops `final` writes `summary_final = 0`, changes what the test set up, and can leave it green for the wrong reason or red for a reason unrelated to this change.

This is the one place a mechanical find-and-replace would produce a wrong answer that still typechecks.

### D5 — Delete the `:942` verb-list entry rather than rewrite it

`:942` is one item in a deliberately exhaustive list of mutation verbs driven against a terminal row, asserting that none of them flips `status` back or rewrites `ended_at`. Rewritten as `end(id, { tokenId, summary: …, final: true })` it becomes a duplicate of `:941`, differing only in the summary string, while its `'late via summarize'` label names a verb that no longer exists.

The list's claimed coverage genuinely shrinks by one entry point, because there is one fewer entry point. Recording that honestly is better than keeping a line that inflates the count. `SummarizeSessionInput`'s removal is a compile-time guarantee that no future entry can reintroduce it silently.

### D6 — The transferable lesson: deleting dead code is a coverage change wearing the costume of cleanup

Worth stating in the archive because the failure mode is invisible by construction: **a test that disappears does not fail.** Every other kind of coverage regression announces itself — a weakened assertion goes green where it should be red, a deleted `expect` shows in review. A deleted test file, or a deleted test whose subject was the thing being deleted, leaves a suite that is smaller and entirely green.

Here, nine of ten references were genuinely redundant, and inspection said so correctly nine times. It was wrong once, on the one that mattered. The generalisable procedure:

1. Enumerate every reference to the symbol being deleted, from `HEAD` rather than the working tree, so the list is stable while it is being worked through.
2. Classify each one: assertion-bearing, or convenience (setup / happy-path scaffolding / list entry).
3. For each assertion, find the equivalent on the path that **stays**. Where there is none, port it — and mutate to prove the port.
4. Only then delete.

The cost of skipping step 3 is not a failing build; it is a live guard that nothing tests, discovered by whoever eventually breaks it.

## Risks / Trade-offs

- **[Risk]** The ported emptiness test passes without actually covering the guard (e.g. a `.trim()`-insensitive assertion, or a throw arriving from a different precondition). → **Mitigation**: mandatory mutation gate, two arms — weaken `.trim().length === 0` to `.length === 0` (proves the test covers the whitespace-only case specifically) and to `false` (proves it covers the guard at all). Both must be CAUGHT and must name the ported test.
- **[Risk]** A mutation string matches more than once and `mutate.mjs` reports `SKIP` as "not caught", reading as a coverage failure when it is an operator error. → **Mitigation**: `tasks.md` carries strings that span the unique error message, and the task instructs re-verifying uniqueness against the on-disk file before running, since line content may have shifted.
- **[Risk]** The `REMOVED`/`ADDED` pair drifts from the published cap text and silently reverts what another change published into it. This spec file absorbed two archived changes today. → **Mitigation**: the `ADDED` body is produced by copying the current published requirement verbatim and deleting exactly one bullet, then `openspec validate --strict` and `pnpm run check:delta-freshness` before reporting. Note the residual gap honestly: `check-delta-freshness` inspects **only** `## MODIFIED Requirements` (`:96-98`), so a `REMOVED`+`ADDED` pair gets **no** body-drift protection from it. Verbatim copying is the whole safeguard, and a manual diff of the two bodies is part of the task.
- **[Trade-off]** The exhaustive verb list at `:942` loses one entry. → **Accepted because** the entry point it named is gone, and `SummarizeSessionInput`'s deletion means a re-added caller could not compile.
- **[Trade-off]** `AgentSessionsService`'s TypeScript surface changes incompatibly. → **Accepted because** the server ships as a Docker image, not as a library; the only out-of-tree carrier is `apps/server/dist/services/agent-sessions.d.ts`, regenerated by the next build.
- **[Risk]** Some path reaches `summarize` dynamically (string-keyed dispatch, a test helper, a script) and the grep missed it. → **Mitigation**: the deletion is compile-checked by `tsc --noEmit` across the workspace plus the full suite, and the change is smoke-tested against pre-existing seeded data so a runtime-only caller would surface as a broken session-end.

## Migration Plan

**Existing installations need nothing.** No migration file, no schema change, no column, no index, no trigger. No row in `sessions` — or anywhere else — is read or written differently: `summarize()` performed exactly `end({ final: true })` plus two preconditions `end()` enforces itself.

- **First boot after upgrade**: unchanged. The migration runner has no new migration to apply, so `PRAGMA foreign_key_check` and the FK-off/on wrapper are not engaged.
- **Derived data**: nothing to invalidate. `memory_fts`, `memory_vec` and the three entity tables are all regenerable from `memory`, which this change does not touch.
- **Rollback**: a plain code revert, safe at any time, with no data consequence — the change removes a method, never a row.
- **Wire compatibility**: no observable change. Verified by smoke against a pre-seeded volume rather than asserted: session start → save → end-with-summary must produce a `summary` with `summary_final = 1`, and the pre-existing session rows must be untouched.

## Open Questions

- **Should `writeSummary`'s emptiness guard get its own spec scenario, or only a test?** Defaulting to **both**, in the same `ADDED` block as `end`'s. The two conditions are byte-identical and equally reachable (`POST /api/<slug>/sessions/:id/summary`, `memory.session_summary`); specifying one and not the other would leave the asymmetry that produced this change.
- **Does the emptiness guard belong in `http-api` / `mcp-api` too, as a 4xx mapping?** Left open deliberately. `DomainError('invalid_input', …)` already has a status mapping, so there is no known defect — but nobody measured what `POST /api/<slug>/sessions/:id/end` returns for `summary: '   '`, and this change is not the place to find out. Out of scope; a separate change if the smoke turns up something.
- **Should the class docstring at `agent-sessions.ts:95` name the verbs at all?** Keeping the sentence, minus `summarize`, rather than deleting it: it documents a non-obvious cross-token invariant, which is the one licit reason for a comment here. If it drifts again, delete it and let the spec carry it.
