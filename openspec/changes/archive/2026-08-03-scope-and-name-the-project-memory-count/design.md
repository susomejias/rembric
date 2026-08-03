## Context

`project.list` is a directory tool: it answers "which projects exist, and which of them has content", so an agent can pick a `project.use` target. Its per-project number comes from `MemoryRepository.countByProject()` (`apps/server/src/db/repositories/memory-repository.ts:253-261`), an unparameterised read whose only predicate is `isNotNull(memory.projectId)`. Two facts about it are settled by the proposal and not re-litigated here: it counts every status, and it takes no `Scope`.

Three constraints shape the fix, and all three are load-bearing.

**1. `handleList` cannot resolve an effective scope.** `project.list` must succeed on a connection whose URL slug names no project. `openspec/specs/mcp-api/spec.md:85` verbatim:

> - **WHEN** the client calls `project.current`, `project.list`, `memory.about`, or `project.use({slug: 'no-such-project', autocreate: true})`
> - **THEN** each call SHALL succeed

pinned by `apps/server/src/mcp/unresolvable-slug.test.ts:233-246` ("the refusal does not brick the connection"), and stated again in `docs/troubleshooting.md:136` — "`project.use`, `project.list`, `project.current` and `memory.about` keep working throughout — they resolve no scope, so the connection is never stuck." So the usual `resolveEffectiveProject` / `scopeFromContext` path is unavailable to this handler by design.

**2. Authorization already filters the rows, upstream of the count.** `apps/server/src/mcp/project-tools.ts:198-200` filters by `isAuthorized(ctx.scope, 'read', { scope: 'project', projectId: p.id })`; `ctx.scope` is the **token** scope (`apps/server/src/server/request-context.ts:16`), and `isAuthorized` (`apps/server/src/services/tokens.ts:268-290`) admits a `project:<id>` / `read:project:<id>` token only for its own project. `apps/server/src/mcp/authorization.test.ts:348-381` pins all four token shapes.

**3. The `Scope` in this codebase is the pair `(MemoryScope, projectId)`.** `scopeCondition(scope, projectId)` (`apps/server/src/db/repositories/scope-clause.ts:31-35`) is the builder-side fragment every scoped `memory` read already uses, and `countByStatusAndTypeInScope(scope, projectId)` (`memory-repository.ts:225-249`) is the count method one screen above the defect.

## Goals / Non-Goals

**Goals:**

- `project.list`'s per-project number agrees with what `memory.search` in that scope can return, closing the measured divergence.
- The number's name states what it counts, so no future reader has to open the query — and so it no longer collides with the unrelated `memoryCount` at `agent-sessions-repository.ts:266`.
- The read requires a `Scope` as a parameter, so omitting it is a type error (`data-access/spec.md:155`), and it disappears from the unscoped-read inventory in the same commit that removes it from the source.
- `project.list` keeps working on an unresolvable-slug connection (`mcp-api/spec.md:85`), and the authorization filter stays upstream of the count.

**Non-Goals:**

- Restricting which project **rows** `project.list` returns. The row filter is authorization's job and is already correct; this change touches only the number attached to each row.
- Adding a second count (`total`, `byStatus`) to `project.list`. Rejected in D4, not deferred.
- Any schema change, migration, or new index. The read reuses an existing index (D1).
- Changing `memory.stats`, `memory.doctor`, or the per-session `memoryCount` at `agent-sessions-repository.ts:266`.
- Making the count include global rows. It never did (`isNotNull(memory.projectId)`), and a per-project field including global memories would be a new defect.

## Decisions

### D1 — The scoped read is a per-scope count in the `*InScope` family, called once per authorized row

**Chosen:** replace `countByProject()` with a single-scope method in the existing naming family, shaped like its neighbour:

```ts
countActiveInScope(scope: MemoryScope, projectId: string | null): number
```

filtered by `and(scopeCondition(scope, projectId), eq(memory.status, 'active'))`. `handleList` calls it once per authorized project row, with `('project', p.id)`.

**Why this shape.** It satisfies `data-access/spec.md:155` literally rather than by interpretation — the `Scope` is a required parameter, so a caller that forgets it does not compile. It is the same signature as `countByStatusAndTypeInScope(scope, projectId)` twenty lines above, so nothing new has to be learned to read it. And it falls out of the inventory detector naturally rather than by evading it: `unscopedUnprefixedReads` (`apps/server/src/test/invariants.test.ts:760-780`) skips a method whose parameter text matches `/\b(scope|projectId|partitionKey)\b/`, so the method stops being detected _because_ it is scoped, not because of how it is spelled.

**The cost, stated honestly and not hidden.** This is N queries where the current code runs one grouped query, N = the number of projects the token may read. **No measurement is offered here, and none is claimed.** The shape is chosen on clarity. Two facts bound the risk without pretending to be a measurement:

- The predicate is a prefix of an existing index: `memory_scope_project_status_created_idx` on `(scope, project_id, status, created_at)` (`apps/server/src/db/schema/memory.ts:91-96`). `WHERE scope = 'project' AND project_id = ? AND status = 'active'` is a left-prefix match, so each count is an index range, not a table scan. That is a reading of the schema, not a plan capture.
- `project.list` is a session-setup tool, not a per-turn one — its description is "Use when the user references a project that may not be active in this session" (`apps/server/src/mcp/server.ts:433-434`).

**The applier owns the measurement, and `tasks.md` names the number.** Per `CLAUDE.md`'s `db-performance-auditor` standard, the alternative gets measured rather than assumed. The applier records `EXPLAIN QUERY PLAN` for the new statement plus end-to-end `project.list` wall-clock at a realistic project count, on one named instrument, and states whether the loop is materially worse than the grouped query it replaced.

**Alternative A — keep one grouped query, pass the authorized ids:** `countActiveByProjectIds(projectIds: readonly string[])`, grouped, one statement. Rejected as the primary shape for two reasons. First, it does not satisfy `spec.md:155` on its face — an id list is not a `Scope`, and the requirement says `Scope`. Adopting it would need a spec amendment plus, per `spec.md:157`, a recorded measurement showing the scoped alternative unaffordable; "would be slower" is explicitly not the standard there. Second, it is invisible to the inventory detector for a _different_ reason — `unscopedUnprefixedReads` also skips any parameter text matching `/\b\w*[Ii]ds?\b/` (`invariants.test.ts:775`) — so the read would pass the gate by being key-bounded rather than by being scoped. Key-bounding is a legitimate category in that detector, and the shape is defensible; it is simply the second choice, and it must not be reached for on an assumption. **This is the named fallback**: if the applier's measurement shows the loop is materially worse, the fallback is this method plus a spec amendment plus the recorded figures — not a silent swap.

**Alternative B — one query grouped by `project_id` with `status = 'active'` added, still unparameterised, renamed `adminCountActiveByProject`:** rejected in D3.

**Alternative C — compute the count in `ProjectsService` and keep the repository unchanged:** rejected. It moves the SQL nowhere (all SQL stays under `db/` per `CLAUDE.md`) and leaves the unscoped repository method in place, which is the actual violation.

### D2 — The scope passed is the authorized row's own scope, and the ordering is a requirement, not a comment

**Chosen:** `handleList` passes `('project', p.id)` for each row that survived `isAuthorized`. It does **not** consult `ctx.project`, `resolveEffectiveProject`, or `scopeFromContext`.

This is the one place where the fix could be read as self-authorizing — "the handler chooses the scope it reads" looks, in isolation, like no scope check at all. It is sound only because of ordering: the row set is already narrowed by `isAuthorized` (`project-tools.ts:198-200`) before any count is taken, so the handler can only ask for a scope the token was already granted. Constraint 1 in Context makes this the _only_ available shape — a handler that resolved an effective scope would start failing on `/mcp/no-such-project`, breaking `mcp-api/spec.md:85`.

Because the soundness lives in the ordering rather than in the read, the ordering is pinned in the `mcp-api` delta and mutation-tested: weakening or removing the `isAuthorized` filter must redden a test that names it. A comment saying "authorization runs first" is exactly the kind of comment this repo's policy rejects, and it would not fail if someone reordered the code.

**Alternative — narrow `ctx.scope` per row via `narrowScope` and pass the result:** rejected as ceremony. The narrowing would be derived from the same `isAuthorized` predicate that already ran, so it adds an indirection without adding a check, and it re-introduces the risk of a reader believing the check happens inside the read.

### D3 — The method carries no prefix; `admin`/`unsafe` would both be wrong

**Chosen:** `countActiveInScope` — unprefixed.

The two prefixes are defined by what the read does to scope, not by who calls it. `data-access/spec.md:39`: "Deliberately cross-scope repository methods … SHALL carry the `unsafe` prefix … Unscoped reads SHALL carry the `admin` name prefix and SHALL be invoked only from an allow-listed call site." And `:41`: "`admin` names what the read does to SCOPE — it does not filter — and not who consumes it."

The new read filters to exactly one scope. It is therefore neither family, and the unprefixed name is not a third category being smuggled in — `:45`'s "There is no third, unprefixed category" is about **unscoped** reads, and this one is scoped. Its siblings confirm the family: `countByStatusAndTypeInScope`, `searchMemoryIds(opts.scope, opts.projectId)`, `countNeedsReviewInScope`.

**Why `admin*` is actively worse, not merely unnecessary.** Naming it `adminCountActiveByProject` would require adding `mcp/project-tools.ts` to `ADMIN_CALL_SITES` (`invariants.test.ts:625-645`), whose four existing non-dashboard entries are each argued for individually in `data-access/spec.md:49-54`. Three of those arguments are unavailable here: the `bootstrap.ts` argument ("constructed once at boot and reads nothing per-request-scoped") is false for a per-request MCP handler; the `hybrid-search.ts` argument (admitted "on the RETURN TYPES" because "neither return type carries a memory id, content, or a `project_id`") is false because a per-project count returns `project_id`s — issue #310 already noted this; and the structural argument for `fts5vocab` ("`memory_fts_vocab` … has no scope column") is false because `memory` has both `scope` and `project_id`. Adding a fifth entry with no argument would weaken the allow-list, whose whole value is that every entry carries one.

**Why `unsafe*` is wrong.** `unsafe` marks a _deliberate_ cross-scope read. Reading every project's memories to answer "how much is in project A" is not deliberate; it is the defect.

### D4 — The discarded "total" dimension is dropped, not relocated

The old doc comment promised "active+total". `active` is what ships; `total` goes nowhere.

**Reason:** `memory.stats` already answers it, properly scoped. `openspec/specs/mcp-api/spec.md:775` verbatim: "the server SHALL return `{ scope, memoriesByStatus, memoriesByType, sessionsByStatus, needsReviewTotal, pendingJudgmentsTotal }` … every one of them computed against the request context", and the implementation is `countByStatusAndTypeInScope(scope, projectId)` (`memory-repository.ts:225-249`) — a per-status breakdown, scope-resolved, which is strictly more informative than a single total. Adding a `totalMemoryCount` to `project.list` would be a second answer to a question already answered, on a path that (per D2) cannot resolve the caller's scope, i.e. a _less_ trustworthy answer than the one that exists.

**Alternative — ship both fields for backward compatibility (`memoryCount` unchanged + `activeMemoryCount` added):** rejected. It preserves a field the change exists to discredit, and a consumer reading the old key keeps getting the misleading number indefinitely. The point of D5 is that a consumer should be _forced_ to look.

### D5 — Renaming to `activeMemoryCount` is a **BREAKING** wire change, and it is accepted

`project.list` declares an `outputSchema` (`apps/server/src/mcp/project-tools.ts:49-58`) and the MCP surface has no version negotiation, so renaming a key breaks any consumer that parses it. The repo has rejected exactly this move before: `openspec/changes/archive/2026-08-02-say-which-population-the-doctor-counts/design.md` D2 refused to rename `sessions.active` → `sessions.activeAllScopes`, reason 1 being "Wire-breaking with no negotiation. … disproportionate for a labelling problem."

**That precedent does not transfer, on its own terms:**

1. **It was "a labelling problem". This is not.** The doctor change altered no computed value — the rename would have bought nothing but a clearer name. Here the value changes: archived and superseded rows stop counting. Keeping the key `memoryCount` would ship changed semantics under an unchanged key, which is the worse of the two failure modes — a consumer has no signal to re-check. A renamed key fails loudly at the first parse. Renaming is the _cheaper_ option precisely because the number is changing anyway.
2. **The doctor's specific objection was a uniform-suffix problem across three fields diverging on two axes** (that design's D2 reason 2). Here it is one field with one filter; there is no suffix scheme to be inconsistent about.
3. **The doctor change measured "zero in-repo precedent for an unscoped marker on the wire"** and refused to invent a convention with one instance. `activeMemoryCount` invents nothing: `active` is the `status` enum value (`apps/server/src/db/schema/memory.ts`), used on the wire already in `memoriesByStatus.active` (`mcp-api/spec.md:775`) and in `memory.search`'s `status` filter.
4. **The doctor's field was under-covered, making the rename risky** (its D2 reason 4). Here the blast radius was re-measured: zero hits for `memoryCount` under `apps/plugin/`, `docs/`, `README.md`; the only non-test hits are the two lines this change edits plus the unrelated per-session method. There is no typed client — agents read the JSON.

**Alternative — deprecate over two releases (emit both keys, drop the old one later):** rejected. It requires a deprecation mechanism the MCP surface does not have (no version negotiation, no capability flag), and with zero known consumers it would be pure ceremony carrying the misleading number through another release.

The chosen name puts the filter in the name. `activeMemoryCount` over `activeCount` (ambiguous about what is being counted), over `memoryCountActive` (does not read as English), and over `activeMemories` (reads as an array).

### D6 — `data-access` gets a scenario, not a requirement edit

The four requirements this read violated (`:39`, `:45`, `:155`, `:157`) are already correct; the code disagreed with them. Fixing a violation does not change a requirement.

What the delta adds is one scenario recording that this instance is closed and that the inventory entry left with the source, because the inventory's set equality is a two-sided obligation that a future contributor will meet from either side. `:47`'s clause — "SHALL mark any entry that is also a violation of the `admin`-prefix rule above, so the inventory is not read as a blessing" — is conditional, and after this change it is satisfied vacuously: `invariants.test.ts:726` is the only inventory line carrying a violation marker today (re-verified by grepping for comments inside `:718-738`, which returns exactly that line). **No delta needed at `:47`; it stands unchanged.**

### D7 — `project.list`'s tool description is updated in the same change

`apps/server/src/mcp/server.ts:433-434` currently says "List existing projects and their memory counts." Leaving it would re-import through the model's channel the exact ambiguity the field name just shed — the same defect shape the doctor change fixed, one tool over. The description must say the count is of **active** memories. It is one clause on a 128-character string against `DESCRIPTION_MAX_LENGTH = 1900` (`server.ts:124`), and it goes in the top-level description, not a zod `.describe()`, per `mcp-api/spec.md:387` and `:902` (some clients do not surface per-property schema descriptions to the model).

## Risks / Trade-offs

- [Trade-off] N queries replace one grouped query (D1). → Accepted on clarity, with the measurement explicitly deferred to the applier rather than assumed away, and a named fallback (D1 Alternative A) that costs a spec amendment plus recorded figures. What is _not_ accepted is landing the loop with an unmeasured claim that it is fine — `tasks.md` names the number.
- [Risk] A future reader sees `handleList` choosing its own scope per row (D2) and concludes the read is self-authorizing — or reorders the code so that it becomes so. → Mitigation: the ordering is a spec requirement in the `mcp-api` delta and a mutation target in `tasks.md`; removing the `isAuthorized` filter must redden a test that names it. Not a code comment, which would neither fail nor be trusted.
- [Risk] The new test asserts over an empty result set and passes while proving nothing — the exact failure mode `CLAUDE.md` records ("Three tests in one session passed while proving nothing"). → Mitigation: `tasks.md` requires a control that must pass (the count is non-zero _before_ the archive, and the unrelated project's count does not move), and mutation runs weakening the `status` condition and the scope condition **one at a time**.
- [Risk] **BREAKING** rename silently breaks an unknown external consumer. → Mitigation: the blast radius was measured, not assumed (zero hits in all four plugin clients, docs and README; no typed client). Residual risk is an out-of-tree consumer, accepted per D5 — and mitigated by the rename itself, since such a consumer gets an absent key rather than a plausible wrong number.
- [Trade-off] The count still excludes global memories, so a project whose agent relies mostly on global memory reports a small number. → Accepted: it is a **per-project** field, and `isNotNull(memory.projectId)` already excluded global rows. Widening it to include global rows would be a new behaviour change, and `openspec/changes/archive/2026-08-01-gate-global-widening-on-authorization` already established that global widening is an authorization decision, not a free one.
- [Trade-off] `activeMemoryCount` still does not say whether it counts memories the caller can _retrieve_ — retrieval also applies relevance gates and review state. → Accepted: `status = 'active'` is the lifecycle fact the memory spec defines, it is the axis the measured divergence was on, and encoding retrieval-gate semantics into a directory tool's count would make the number depend on ranking configuration.

## Migration Plan

Nothing to migrate. No schema change, no migration file, no derived-data invalidation — `memory_fts`, `memory_vec` and the three entity tables are regenerable from `memory` and are untouched here.

On a populated install (hundreds of memories across several projects) the first boot after upgrade does no extra work. The only observable change is `project.list`'s payload: `memoryCount` gone, `activeMemoryCount` present, and smaller wherever the project holds archived or superseded rows. Already-connected MCP clients keep their cached `tools/list` until they reconnect, so the description lags by one connection — harmless.

Rollback is a plain revert. The pre-change code reads the same rows and needs no data fix-up, in either direction. The one thing a partial revert must not do is unrevert the source while leaving `invariants.test.ts:726` deleted (or the reverse): the inventory's set equality fails from both sides, so source and inventory must move together in one commit.

## Open Questions

1. **What is the actual project count on a real deployment, and does the N-query loop matter at it?** Deliberately left to the applier's measurement rather than guessed here (D1). Not parked as a judgement call — the default is decided: the loop ships unless a measurement says otherwise, and if it does, the fallback shape and its price are already named.
2. **Should `project.list` also report a `needsReviewCount` per project?** Genuinely open, and out of scope. Review state is derived at read time (`apps/server/src/services/review.ts`), so it is not a `status` filter and would cost a different query per project; deciding it needs a reason an agent would act on the number, which this change does not have. Left open rather than defaulted because folding it in would muddy what the mutation run proves.
3. **Should the per-session `memoryCount` (`agent-sessions-repository.ts:266`, surfaced at `services/agent-sessions.ts:604`) also be renamed, now that the collision is half-resolved?** Left open. It is a different aggregate on a different payload, it is key-bounded by `sessionId` (so it is not a scope violation), and renaming it would be a second **BREAKING** wire change bundled into a fix that does not need it. Recorded here so the collision argument in D5 is not later read as having settled both sides.

Settled by default rather than parked, so they are not mistaken for open: the count excludes global rows (Non-Goals); no `total` is shipped (D4); the method is unprefixed (D3); `data-access/spec.md:47` needs no delta (D6).
