# Retire the `summarize` back-compat wrapper

## Why

`AgentSessionsService.summarize()` (`apps/server/src/services/agent-sessions.ts:399-409`) is a nine-line back-compat wrapper: reject an empty summary, apply the cap, delegate to `end({ final: true })`. Its own docstring (`:393-398`) says "remove in a follow-up change once those are migrated", and the migration is finished — **it has zero production callers.** Grepped across `apps/server/src`: the only non-test occurrences of the identifier are its own definition, its own error message, and a prose mention in the class docstring at `:95`. Every call site is in `agent-sessions.test.ts`.

Deleting it is nonetheless a **contract change**, for two independent reasons.

**First, the published spec names it in three places** (`openspec/specs/sessions/spec.md`, re-checked against the current file after two changes archived into it today):

| Line   | Requirement it sits in                                       | Shape                                                                                           |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `:13`  | Sessions MUST be append-only                                 | body sentence — "the cross-token rule that already protects `end` and `summarize`"              |
| `:764` | Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` | bullet in the enumerated write-path list — `` `summarize({ summary })` (back-compat wrapper) `` |
| `:789` | same requirement                                             | **scenario title** — `` `summarize` (legacy wrapper) inherits the cap ``                        |

A published scenario cannot be dropped by a `MODIFIED` block: `scripts/check-delta-freshness.mjs:112-121` fails on any published `#### Scenario:` title absent from the delta, and `openspec archive` refuses the same. So the cap requirement needs `REMOVED` + `ADDED` under a changed header — same-header `REMOVED`+`ADDED` is rejected by `openspec validate`. `:13` is a body sentence in a different requirement and is a plain `MODIFIED`. A rename does not help: `check-delta-freshness.mjs:102` resolves the published slice through the `RENAMED` map and still applies the dropped-scenario check.

**Second, and this is the substance: one of the ten test references was the only test of a guard that stays.** Full inventory of `summarize(` in `agent-sessions.test.ts` at `HEAD` (`git show HEAD:…` line numbers, so they are stable against the concurrent edit):

| Refs                                   | Class                 | Disposition                                                                               |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `:85` cross-token                      | assertion, duplicate  | already asserted on `end()` at `:80` (`/not found/i`) — deleting loses nothing            |
| `:143` cap                             | assertion, duplicate  | already asserted on `end()` at `:134` (`toThrow(cap)`) — deleting loses nothing           |
| **`:104` empty summary**               | **assertion, UNIQUE** | **`end()` has the guard (`agent-sessions.ts:339`) and NO test named it. Must be ported.** |
| `:69`                                  | happy path            | its assertions are about the resulting row, not the verb                                  |
| `:684`, `:754`, `:782`, `:861`, `:883` | setup                 | give a session a final summary so it satisfies `sessionHasContent`                        |
| `:942`                                 | verb-list entry       | one item in an exhaustive mutation-verb list against a terminal row                       |

That third row is why this change exists in this shape rather than as a one-line deletion. `sessions.end: summary must be non-empty` is live, reachable from `POST /api/<slug>/sessions/:id/end` and `memory.session_end`, and unguarded by any test — deleting the wrapper would have silently removed its only coverage, and **nothing would have turned red**, because a test that disappears does not fail. Nine of ten references looked redundant on inspection; the inventory is what distinguished the tenth.

## What Changes

- **Port the empty-summary assertion onto `end()` first, and prove it load-bearing with `scripts/mutate.mjs` before the wrapper is deleted.** Chosen over deleting-then-porting because the intermediate state has a live guard with zero coverage, and over trusting the port on inspection because a green test proves nothing about a guard until it goes red without it. Mutation matters more than usual here: `agent-sessions.ts` carries near-identical `throw new DomainError('invalid_input', …)` lines (`:78`, `:205`, `:292`, `:298`, `:339`, `:345`, `:401`), and `writeSummary`'s emptiness condition at `:291` is byte-identical to `end`'s at `:338`. `mutate.mjs:103-108` counts occurrences and **SKIPs** a non-unique match while counting it as uncovered — so an insufficiently-specific `--mutation` string reports as a failure rather than mutating the wrong site. Each mutation string must therefore span the unique `'sessions.end: …'` message.
- **Delete `summarize()`, then check whether `SummarizeSessionInput` (`:146-149`) became unused and delete it if so.** Check rather than assume; it is exported.
- **Convert the seven convenience call sites to `end(id, { tokenId, summary, final: true })`.** `final: true` is not cosmetic: `recentForContext` filters on `sessionHasContentSql('sessions', { requireCuratedSummary: true })` (`db/repositories/agent-sessions-repository.ts:187`), so a conversion that drops `final` changes what five of those tests set up and can leave them passing for the wrong reason.
- **Fix the `:942` verb-list entry rather than mechanically rewriting it.** Rewritten as `end(…, { summary, final: true })` it becomes a duplicate of the entry above it at `:941`, differing only in the summary string. The list is deliberately exhaustive over mutation verbs, so the honest outcome is that it now covers one fewer distinct entry point — because there IS one fewer. Delete the redundant entry rather than keep a line whose `'late via summarize'` label names a verb that no longer exists.
- **Spec: `REMOVED` + `ADDED` for the cap requirement under a header that states the write-path list is exhaustive; plain `MODIFIED` for the append-only requirement's `:13` sentence.** The re-added requirement is the published text with the `summarize` bullet and the `summarize` scenario dropped and no other edit — the point is to lose two mentions, not to relitigate the cap.
- **Update the class docstring at `:95`** so it names `end` and `writeSummary` only. One prose line, no new comment.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sessions`: the requirement "Session summary writes MUST be capped at `SUMMARY_MAX_CHARS`" is REMOVED and re-ADDED under a header naming the write-path list as exhaustive, dropping the `summarize` bullet and the `summarize` cap scenario. "Sessions MUST be append-only" is MODIFIED to drop `summarize` from the cross-token sentence. One new requirement is ADDED for the empty/whitespace-only summary guard on `end` and `writeSummary`, which the spec asserts nowhere at service level today.

## Impact

- **Code**: `apps/server/src/services/agent-sessions.ts` — delete `summarize()` (`:399-409`), delete `SummarizeSessionInput` (`:146-149`) if unused, amend the docstring at `:95`. `apps/server/src/services/agent-sessions.test.ts` — port one assertion, convert seven call sites, drop two now-duplicate assertions and one now-duplicate verb-list entry.
- **BREAKING** at the TypeScript API surface of `AgentSessionsService`, and nowhere else. No MCP tool, no HTTP route, no dashboard handler, no zod schema and no plugin file references `summarize`; the only out-of-tree carrier is `apps/server/dist/services/agent-sessions.d.ts`, a build artefact regenerated on the next `tsc`. The server is distributed as a Docker image, not as a library, so no consumer can be holding this type.
- **No migration, no schema change, no new column, no data touched.** Existing installations need nothing on first boot after upgrade: no derived data is involved (`memory_fts`, `memory_vec` and the three entity tables key off `memory`, which this change does not reach), and no `sessions` row is read or written differently. Rollback is a plain code revert with no data consequence.
- **No behaviour change on any wire.** `summarize()` performed exactly `end({ final: true })` plus two checks that `end()` performs itself; every observable path already goes through `end()`.
- **Invariants**: none touched. Append-only holds — this deletes a method, not a row. Scope-at-service-layer, `topic_key` convergence, fresh-context judgment and derived-review-state are all uninvolved.
