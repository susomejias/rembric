# Design — search across authorized projects

## Context

`proposal.md` carries the motivation and the headline measurements. This document records the decisions by number (D1–D16), the constraints that bound every one of them, and the questions deliberately left open.

**Three published requirements govern this change before it writes a line of code**, and two of them constrain it far more than the feature request suggests.

1. **`openspec/specs/auth/spec.md:222`**, verbatim: "Where a change proposes ANY argument, filter, flag or default that admits rows from a scope other than the resolved one, that change SHALL evaluate `isAuthorized(tokenScope, 'read', <the wider scope>)` before widening, and SHALL be bound by this requirement from the moment it is proposed. **Where the check fails, the widening SHALL be dropped and the resolved-scope result served unchanged rather than the call being rejected**, because the caller is authorized for everything it actually receives." The emphasised half is the surprising one: an unauthorized widening is **not** an error. That single sentence is why the response marker (D10) is load-bearing rather than cosmetic.
2. **`auth/spec.md:224`**: "a widening flag that travels beside the resolved scope as a bare boolean cannot tell any layer that carries it whether anyone was authorized to set it. Any future widening SHALL therefore carry its authorization decision with it, or be constructed at exactly one site that has already made that decision." This is GHSA-cc4j-ch4r-9pf5's lesson, already generalised. D3 is the answer.
3. **`mcp-api/spec.md:23`**: "`memory.search` SHALL return only memories whose `project_id` equals the bound project. **No argument SHALL widen the result set past it**". This change contradicts that sentence head-on and must modify it. Grep found four further sentences of the same shape — `memory/spec.md:79`, `memory/spec.md:1633`, `auth/spec.md:239`, `mcp-api/spec.md:2662` — plus `memory-entities/spec.md:271` ("**No widening exists.**"). Every one is enumerated in the deltas; none is worked around.

**One finding qualifies the brief this change was written from, and it is stated up front because it changes a phase boundary.** The retrieval harness still holds **10 global-scoped memories** (`test/retrieval/corpus.ts`) and **4 global-scoped queries** (`test/retrieval/queries.ts`), ingested through `test/retrieval/ingest.ts:66-69` into `SCOPE_GLOBAL`. So the "phantom" arm is not merely typed — it is exercised by the only harness that gates retrieval quality, and collapsing `Scope` (phase 1) forces the eval fixtures to move whether or not phase 3 wanted them to. That coupling is real and it is also an opportunity: those 10 memories are the natural seed of a third project, which is most of the cross-project distractor corpus phase 3 needs.

## Goals / Non-Goals

**Goals**

- One `memory.search` call can read several projects, opt-in, with the set determined by the token's read reach and by nothing else.
- The widening is **unforgeable**: a value that a write cannot hold and that only one site can construct, checked by the compiler first and by a grep gate second.
- The evaluation harness can **fail** on over-widening before any widening ships, proved by the over-widening mutation going red.
- Ranking is decided by measurement, not by taste, and the measurement is committed as an artifact.
- `Scope` becomes one arm, so the widening variant sits beside a live arm rather than a ghost.

**Non-Goals**

- **The schema half of release N+1** (D2) — dropping `memory.scope`, the five scope-bearing indexes and `memory_entities_identity_idx`, and the `NOT NULL` flips on `sessions.project_id` / `prompts.project_id`.
- **Any widening of `memory.context`, `memory.get`, `memory.timeline`, `memory.stats`, or any automatic recall path** (D13).
- **Any widening of the HTTP surface.** `http-api/spec.md:393` — "no argument on this endpoint widens the result set past it, and none is accepted" — stays true verbatim and is not amended.
- **Calibrating `ABSTENTION_FLOOR`** (D14), which is still `null` at `hybrid-search.ts:47` with the committed cap `abstentionFalsePositiveRate: 1` at both `k` (`baselines/hybrid.json:31,35`). Knowingly accepted, with its consequence stated.
- **Gating `avgTokensReturned`** (D9) — reserved by `retrieval-evaluation/spec.md:116` for its own change.
- **Cross-project writes of any kind.** No memory row is written by this change.

---

## Decisions

### D1 — Phase order is a hard sequence, not a preference, and phase 3 precedes phase 4 for a measured reason

1. **Collapse `Scope`.**
2. **Measure the sqlite-vec partition question** and commit the artifact.
3. **Give the harness the power to detect over-widening**, and prove it by re-running the over-widening arm and showing it goes RED.
4. **Ship the `Scope` variant, the plumbing, and the ranking policy** the phase-2 measurement selected.
5. **Ship the MCP surface.**
6. **Docs and release notes.**

Phases 1 and 2 are independent of each other and both precede 4. The load-bearing ordering is **3 before 4**, and the reason is a number rather than a principle: `archive/2026-08-05-retire-the-global-scope/tasks.md` 16.15 re-measured at HEAD that a mutation dissolving `scopeWhere`'s project branch — total loss of isolation — makes **MRR@8 rise 0.828 → 0.859 with `pnpm run eval` GREEN throughout**. A harness that scores the destruction of scope isolation as an improvement cannot be the evidence that a _deliberate_, _authorized_ widening is safe. Shipping phase 4 first would mean landing a retrieval change whose only quality gate is known to point the wrong way.

The same entry records the second half, which is why fixing the harness is not optional: "both rewritten `cross-project-isolation` queries are saturated at k=8 for the `grep` control too, so they contribute **zero** discrimination to the gated recall metric. Isolation is guarded **solely** by `queries.test.ts`."

**Rejected: three separate changes.** Precedent against it is `retire-the-global-scope`, one change with 121 tasks across 16 sections. Split three ways, the harness change would have no consumer to justify its fixtures, the `Scope` collapse would be a pure refactor with no behavioural argument, and the tool change would arrive with its two prerequisites in someone else's queue. The cost of one change is a large diff; the cost of three is that the middle one is the one that gets deferred.

### D2 — Phase 1 is the TYPE half of release N+1 only; the schema half is deliberately left

`retire-the-global-scope` `tasks.md` 16.1 bundles both halves: "drop the five scope-bearing indexes … run `DROP COLUMN scope`, recreate them without it, **collapse `Scope` to a project id, delete `scopeWhere`'s branch and `GLOBAL_PARTITION_KEY`**, and make `sessions.project_id` / `prompts.project_id` `NOT NULL`."

This change takes only the emphasised half. Four reasons, in descending weight:

1. **`memory/spec.md:1619` already reserves the other half**, verbatim: "The `memory.scope` column remains present in this release, written as the constant `'project'` on every insert, solely so a rolled-back previous image can still execute its own queries; it carries no information and no read SHALL branch on it. **Its removal is a separate change.**"
2. **The column drop needs a decision this change cannot make.** `retire-the-global-scope` open question 1 is "how many releases may an operator skip and still roll back?" and its recorded default is "N+1 lands no earlier than one release after N". N shipped today as server 0.26.0. That is an operational judgement about the installed base, not a retrieval question.
3. **The two halves are independent.** `scopeWhere('project', id)` emits `scope = 'project' AND project_id = ?`, which is correct whether or not the column is later dropped. Nothing in the type collapse depends on the column going away, and nothing in the column drop depends on the union collapsing first.
4. **Coupling them makes the diff unreviewable.** The schema half is a five-index drop plus `DROP COLUMN` plus recreation on a populated table — measured at 200 000 rows in `retire-the-global-scope/measurements/scale.md`, with a rebuild hazard (rowids 4..51 → 1..48, FTS hits 12 → 10) recorded there. Landing that inside a retrieval feature means a rollback-breaking migration reviewed as an appendix to a ranking change.

**The honest cost, recorded rather than glossed:** after this change N+1 is _half_ done, and the remaining half is the part that carries the migration risk. `schema-drift.test.ts` keeps pinning six indexes on a dead column, and `memory.scope` stays written-as-constant for at least one more release. **This change does not make the remaining half harder** — it makes it strictly easier, because the union is gone and `memory-repository.ts`'s `scopeWhere('global', null, 'm')` call site (which 16.1 names as the reason the branches were live) disappears with it.

### D3 — The widening is a SEPARATE TYPE that a write cannot hold, not a third field on `Scope`

```ts
export type Scope = { kind: 'project'; projectId: string };

export type SearchScope =
  | Scope
  | {
      kind: 'authorized-projects';
      /** Every id here was individually admitted by isAuthorized(…, 'read', …). */
      projectIds: readonly string[];
      /** The scope the connection resolved to; always a member of projectIds. */
      homeProjectId: string;
    };
```

`Scope` remains the parameter of **every write and every non-search read**. Only `MemoryService.search` / `searchWithAbstention`, `hybridSearch`, and the three search-serving repository methods accept `SearchScope`. Handing a widened scope to `memory.save` is a **compile error**, which is what `services/scope.ts:1-15` already promises of scope generally ("The compiler enforces this: a service method called without a scope argument is a type error").

**This is a better answer than issue #304's own proposal**, and the difference is worth recording because #304 is closed (2026-08-02, `de6efd0`) and a reader may reach for its text. #304 proposed `{ kind: 'project'; projectId: string; alsoGlobal: boolean }` — one union, a widened value constructible anywhere a `Scope` is, and every write path structurally able to hold one. The two-type split makes the write path _unable to express_ the widening rather than merely _disciplined about it_.

**Rejected: a bare `widened: boolean` threaded beside `Scope`.** This is literally GHSA-cc4j-ch4r-9pf5's shape and `auth/spec.md:224` forbids it by name.

**Rejected: resolving the widening inside `MemoryService`.** The service reads no request context and must not start — `MemoryService.search` is called from `server/api-router.ts` and `hybridSearch` directly from the retrieval harness, neither of which has one. #304's own text makes this point and it still holds.

**Rejected: a runtime guard instead of a type.** `retire-the-global-scope` D7 retired the #304 grep invariant precisely because the value it guarded stopped existing. This change brings a widening value back, so it brings the guard back too — but as a _second_ line, behind the compiler. The grep gate (D4) catches a second construction site; the type catches a write.

### D4 — Exactly one construction site, in `mcp/_shared.ts`, and the grep gate is reinstated

One exported async function beside `resolveEffectiveScope`, taking the already-resolved `EffectiveScope` plus the request's `across_projects` flag, returning a `SearchScope`. Its body:

- If widening was not requested → return the narrow `Scope`. No project list is read.
- Else enumerate `projects.list(false)` and keep `p` where `isAuthorized(ctx, 'read', { scope: 'project', projectId: p.id })` — the identical predicate already live at `mcp/project-tools.ts:205`, reused rather than re-derived.
- If the surviving set has one member → return the narrow `Scope`. A one-member widened set and today's query are measured identical (`measurements/vec-partition-capability.md` §3), so this is a simplification, not a behaviour change — and it means a `project:<id>` token's widened search is provably the same call it makes today.
- Else return `{ kind: 'authorized-projects', projectIds, homeProjectId }`.

The set **always contains the home project**: the tool authorized `read` against it before the handler ran, so the filter cannot drop it. That is asserted rather than assumed, because §3 of the measurement shows `partition_key IN ()` returns an empty result set — a widening that resolved to zero projects would silently return nothing instead of falling back.

**Grep gate**, in `test/invariants.test.ts`, in the style of the (now-deleted) `includeGlobal` rules at `:493-568`: the `'authorized-projects'` literal appears in exactly one production file, and the assertion carries its own non-vacuity control (`expect(sites.length).toBeGreaterThan(0)`), because the two self-guarding assertions in the retired version are exactly what forced its clean removal rather than leaving a green-but-meaningless test (`retire-the-global-scope` D7).

**Rejected: constructing it inside `handleSearch`.** That is one site _today_. `auth/spec.md:224` asks for a site that is one site _by construction_, and a handler is where the second one goes.

### D5 — Reach, not privilege: the widened set is what the token may read, and the 2026-08-02 decision is superseded

The set is exactly `{p : isAuthorized(ctx, 'read', {scope:'project', projectId: p.id})}`. Consequences, each falling out rather than being added:

| token scope                          | widened reach                                                     |
| ------------------------------------ | ----------------------------------------------------------------- |
| `*` / `read:*`                       | every project — the old "admin only" behaviour, as a special case |
| `projects` / `read:projects`         | its `token_projects` members                                      |
| `project:<id>` / `read:project:<id>` | one project → collapses to the narrow scope (D4)                  |

**This supersedes the 2026-08-02 direction's "solo `*` / `read:*`" decision, which predates set tokens** (`grant-tokens-multiple-projects` shipped 2026-08-05). Under the old framing the widening was a privilege test and needed an admin check invented for it; under this one it is a set enumeration served by a live code path.

**Note what this deliberately does NOT do**, on the precedent of `grant-tokens-multiple-projects` D8: it does not make "reaches every project" mean admin, and it does not consult the three literal `scope !== '*'` admin gates (`server/dashboard-router.ts:156`, `server/http.ts:489`, `dashboard/maintenance.ts:143`). A set token naming every project widens to every project and still cannot log in to the dashboard. That is the same invariant, unchanged, and it gets its own control test.

**Archived projects are excluded** — `projects.list(false)`. An archived project already refuses even `initialize` with `project_archived` (`auth.ts:76-82`, measured in `retire-the-global-scope` 16.5), so admitting it into a widened set would return rows from a project the same token cannot open directly. Recorded because "my archived project's memories are missing from the widened search" is a predictable question with a defensible answer.

### D6 — One globally distance-ordered list per branch, via `partition_key IN (…)`, decided by measurement

Measured in `measurements/vec-partition-capability.md`; the four facts that decide it:

1. sqlite-vec 0.1.9 **accepts** `partition_key IN (…)` with literals, with bound parameters, and with a `json_each` subquery, and applies `k` per named partition, with `ORDER BY distance` merging into **one globally distance-ordered list** — so rank position is a global fact and RRF (`hybrid-search.ts:139`, `RANK_CONSTANT = 60` at `:19`) needs no fudge factor.
2. **`IN` scans the named shards, not the corpus**: at 50 000 vectors over 8 equal partitions, ratios of 1.00 / ≈2.03 / ≈4.05 / ≈8.09 for 1 / 2 / 4 / 8 partitions, reproduced across four independent runs with under 8% spread on every arm. The shard-scan property `vectors-repository.ts:116` exists to preserve survives `IN`.
3. **N separate queries cost the same** (8.47 / 8.42 / 8.43 / 8.39 ms against `IN (2)`'s 8.33 / 8.62 / 9.03 / 8.44 ms — indistinguishable over four runs), so the choice between the two is **not** a performance choice. It is decided purely on semantics: `IN` gives one ordered list; N queries give N rank-1 rows, which is precisely the "a project holding three memories yields a rank-1 row and RRF weights it like the best home match" failure.
4. **Dropping the predicate entirely is rejected on authorization, not on cost — this bullet's original cost claim was wrong.** As first written it said the predicate-free form is "never faster … and ≈1.4× slower in two of four runs". Phase 2 re-ran the committed harness five more times and measured it **2–8% faster** than `IN (all 8)` at every magnitude, with the bimodality not reproducing. The rejection survives on stronger ground: the form carries **no scope predicate at all**, so it cannot bound a read to the authorized set — a widening that reads every partition is the GHSA this change exists to avoid repeating, whatever it costs. Corrected in `measurements/vec-partition-scale.md` §8; the propose-phase artifact is left as written with the correction recorded against it.

**A correction worth recording rather than hiding, because it is the reason the figures above are stated as ranges.** The first run of this measurement read the predicate-free arm at a flat 48.37 ms and the design initially claimed a stable 1.41× penalty. Three repeats showed the arm is **bimodal** — two runs at ≈33.7 ms and two at ≈48.4 ms — while every other arm stayed tight. The conclusion survives (the form is dominated either way) but the number did not, and only repetition found that. The 20 000-vector `IN (all 8)` cell is still a single run and is therefore treated as unconfirmed rather than as a finding (task 2.6).

**The lexical branch takes the same shape**: `project_id IN (…)` instead of `= ?`, one BM25-ordered list. `scopeWhere` therefore grows a multi-project form rather than the caller looping.

**`EXPLAIN QUERY PLAN` is not the instrument here.** Both forms print the identical opaque vtable index string plus `USE TEMP B-TREE FOR ORDER BY`. Recorded so a later audit does not read identical plans as evidence the arms are equivalent — only wall-clock separates them.

**Rejected: merging N per-branch, per-project ranked lists in application code.** Same cost, worse ranking, more code. **Rejected: a per-project `k` divided by N.** It makes the result depend on how many projects the token happens to reach, so the same query returns different rows after an unrelated project is created.

**One query shape rather than two — but conditionally, and the condition is unmeasured today.** `IN ('X')` ≡ `= 'X'` in the result set (§3), which is what lets a one-project token's widened search be provably its narrow search and lets the repository carry a single form. That equivalence is proved in ROWS and not on the clock: §3 compares result sets on a 4-vector corpus, and §4's baseline arm is `partition_key = ?` (`vec-partition-scale.mjs:82`) with no timed single-element `IN`. Since the ordinary non-widened search — every call that exists today — is what changes shape, the equivalence must hold in wall-clock too, and EQP cannot establish it. **Task 2.5 measures it and decides this section**: indistinguishable keeps the single shape; measurably slower keeps `= ?` for the one-project case behind a branch on set size, and the two shapes are then a measured necessity rather than the drift this decision otherwise avoids. Stated as a conditional rather than settled because the predicate-free arm above is what an assumed vec-index cost looks like when it is finally timed.

### D7 — Widening does NOT recalibrate term weights, because IDF is already server-wide

`db/repositories/term-statistics-repository.ts:22` states it: "**Deliberately unscoped** — memory/spec.md, 'The relevance level's term statistics MUST come from the search index'", and `:30` pins the denominator: "Must stay the same denominator the per-term counts are drawn from: **every `memory` row, all scopes and statuses**." `memory/spec.md:474` already specifies it.

So the IDF weighting a widened query applies is byte-identical to the one a narrow query applies. **A whole class of feared problem does not arise**: no document-frequency denominator changes, no term's weight moves, and the relevance level (`RELATIVE_LEVEL_RATIO = 0.4`, `hybrid-search.ts:58`) is computed against the same distribution it was calibrated on in `archive/2026-08-03-weight-relevance-levels-by-idf`. Stated as a decision rather than left implicit, because "widening changes the corpus so the IDF must be re-derived" is the obvious wrong inference and it would have cost a re-calibration sweep.

### D8 — Pure relevance, no home-project boost; a home tiebreak only on an exact fused-score tie

The fused list is ordered by RRF score alone. Where two rows tie exactly, the home-project row sorts first; otherwise `project_id` plays no part in ordering.

**Rejected, with its reason, because it is the alternative a reader will reach for: strict home-project prioritisation (tiering home rows above foreign ones).** If you widen precisely because the answer is not in your project, and home rows always win, then with `k = 8` (`DEFAULT_SEARCH_LIMIT`) and eight mediocre home matches you never see the foreign answer. The feature silently defeats itself — and silently is the operative word: the caller gets a full page of plausible rows and no signal that the widening contributed nothing. A full page is already not evidence of relevance (`mcp-api/spec.md:486` requires the description to say so), and tiering would make that worse in exactly the case the argument was passed for.

**Rejected: a tunable home-project boost multiplier.** It is a new retrieval constant, and `memory/spec.md:1404` requires every such constant to be named, bounded in one place, and derived from a committed sweep. There is no sweep that could derive it, because the harness cannot yet score widening at all (D1). A constant with no derivable value is a knob, not a decision.

**The tiebreak is deliberately weak.** Exact RRF-score ties are common (two rows at the same rank in the same single branch), and in that case "prefer my own project" is a free, defensible answer. It is not a boost: it cannot move a foreign row below a home row that scored worse.

**And it is free rather than merely cheap, which is the answer to "is it worth keeping at all".** A total order over the fused list is needed regardless of any project preference: without one, exactly-tied rows come out in whatever order the sort happens to produce, which is unreproducible across runs and makes a test over a tied pair flaky for a reason that reads as a retrieval bug. Since a secondary sort key is being paid for anyway, spending it on "home project, then `id`" costs nothing over "`id`" alone. There is no cheaper variant to fall back to — dropping the preference does not remove the comparator, it only makes it say less. The expensive variant is the boost multiplier above, and that is already rejected.

### D9 — The harness's new gate is `foreignScopeRate`, a cap; `avgTokensReturned` is NOT promoted

`foreignScopeRate` = the fraction of returned rows whose `project_id` is not the query's own scope, aggregated over the query set, gated as a **cap** in `CAP_METRICS` (`floor-ratchet.ts:23`). For a query set in which no query requests widening the cap is **0**, so any leak — a dissolved `scopeWhere` branch, a widened default, a forgotten predicate — moves the metric off zero and fails CI. It measures the thing itself rather than a proxy.

**`avgTokensReturned` is deliberately NOT promoted to a cap**, and this is a decision rather than an omission because the brief offered it as an option. `retrieval-evaluation/spec.md:116` reserves it verbatim: "`avgTokensReturned` has no committed ceiling. **It SHALL be closed by its own change**; until then no requirement SHALL claim CI protects the token axis." Its scenario at `:157` goes further — "any claim that it is gated SHALL be treated as a spec defect". Promoting it here would mean modifying a requirement whose only content is the reservation, inside a change that has a sharper instrument available. A token cap would also catch over-widening only incidentally: a widening that returns the same 8 rows from the wrong projects moves no token count at all.

**The cap must be derived under the ratchet's own rule** (`retrieval-evaluation/spec.md:120`): `measured + headroom`, headroom = one query's worth of that metric's own step computed from **that metric's own denominator**, clamped to 1. `foreignScopeRate`'s denominator is the returned-row count, not the query count, so it must not borrow the abstention axis's step.

### D10 — The response names which projects were searched, and `widened` is a fact about the result

`searchedProjects: string[]` (slugs, in a stable order) and `widened: true` present only when more than one project was searched — joining `abstained` / `gateShortened` / `viaEntity` in `searchVerdict` (`memory-tools.ts:360-374`).

**Naming the projects is not decoration, and `auth/spec.md:222` is why.** An unauthorized widening is **dropped, not refused** — the call succeeds and returns the resolved-scope result. Without a marker the agent cannot distinguish "I searched five projects and this is everything" from "my token reaches one project, so your `across_projects: true` did nothing". Both are a full page of home-project rows. Rows already carry `projectId` (`memory-tools.ts`'s `formatRow`), so nothing new is disclosed — but requiring the agent to infer reach from the union of the `projectId`s it happened to receive is inference from an absence, which is the failure `mcp-api/spec.md:2576` governs.

**`widened` reports the result, not the request.** With `across_projects: true` on a `project:<id>` token, `searchedProjects` has one entry and `widened` is absent. Saying `widened: true` there would be a claim about the request dressed as a claim about the result.

**Rejected: `widened: true` with no project list.** It answers "did anything widen" and not "how far", and the second question is the one an agent asks before deciding whether to tell the user "I found nothing anywhere".

### D11 — The argument is `across_projects`, not `all_projects` and not `scope`

- **Not `all_projects`.** On a set token it promises every project and delivers the member set. A published input name that overclaims is the class `mcp-api/spec.md:2576` governs ("A tool's description and its response MUST agree, and neither may promise an unreachable state"). The name has three years of citations behind it in this repo's archive and is nonetheless wrong now that set tokens exist.
- **Not `scope`.** `mcp-api/spec.md:2716`'s scenario states "no property name SHALL be `scope` or `include_global`", and that requirement's subject is retirement — a name that used to mean something else is where the next silent misinterpretation goes.
- **`across_projects`** says what happens (the search crosses projects) without claiming how far. `searchedProjects` answers how far, truthfully, per call.

Strict-schema behaviour comes free: `mcp-api/spec.md:2723` already makes every tool input schema strict at a single registration seam, so an older client sending `all_projects` is **refused** with `-32602 unrecognized_keys` rather than silently ignored — which is exactly what a client pinned to a pre-upgrade plugin should get.

**RATIFIED by the owner, 2026-08-05.** Recorded because the owner asked for this feature by the name `all_projects` throughout its design, and every earlier memory and archived proposal calls it that. The rename was put to them explicitly and accepted, so a later reader finding `all_projects` in the history is looking at the superseded name, not at a drift this decision introduced.

### D12 — The entity branch widens too, under the same argument and the same authorization

`memory.search`'s `entity` branch is the exact-address lookup: unranked, chronological, complete within scope. It carries **none** of the ranking risk that motivates D6 and D8 — no fusion, no RRF, no dense branch, no relevance gate — and it is the strongest case for the feature ("which of my projects mentions this file / CVE / host").

The alternative — one argument on one tool that widens one branch and not the other — is a tool whose description cannot be written truthfully, which is what `mcp-api/spec.md:2576` forbids.

**The completeness bound stays a bound on the RESPONSE, not per project.** Without `limit`, the entity branch returns up to `RANK_WINDOW_CEILING` (400) rows. Widened, that is still 400 total. Per-project it would be `400 × N`, which would multiply the worst-case annotation payload that `mcp-api/spec.md:2430` pins with a named ceiling asserted in CI — a change to a CI-asserted bound smuggled in as a side effect. **Ordering across projects is the branch's existing chronological order**, applied to the union; no project-of-origin term enters it.

**Consequence recorded rather than left emergent:** widened, the branch can be complete-within-scope for the union and still truncate at 400, where narrow it rarely would. The existing truncation signal covers it; the description must not claim completeness it cannot deliver when widened.

### D13 — `memory.context` and every automatic recall path are explicitly out, and the reason is frequency

`memory.context` is what an agent calls at session start, after `/compact`, and on "what did we do" — i.e. unprompted and often. `memory.search` is what it calls when it is looking for something. Widening the second is a decision the agent makes per question; widening the first is a standing tax on every session's opening context, paid in tokens the user did not ask to spend and in precision on a surface whose whole job is "the most relevant recent context **for this project**".

The measured cost makes this concrete rather than stylistic, and the figure to quote is the **end-to-end** one, not the isolated statement: on a realistically skewed corpus a widened `memory.search` costs **1.3–2.6×** a narrow one (`measurements/vec-partition-scale.md`, instrument I2/I3, six process runs per cell). Per explicit question that is fine. Per session start it is not. **The ≈8× this decision originally quoted is instrument I1 on a uniformly-split synthetic fixture and must not be repeated as a user-facing cost** — it is the statement-versus-end-to-end conflation `CLAUDE.md` names, and it overstates what a caller waits for by roughly threefold.

Same reasoning excludes `memory.get`, `memory.timeline`, `memory.stats` and the HTTP `/api/<slug>/memory/search` endpoint. `memory.get` additionally has a security shape this change must not disturb: its cross-scope response is `not_found` precisely so existence does not leak (`mcp-api/spec.md:24`).

### D14 — `ABSTENTION_FLOOR` stays `null`, and that is a knowingly-accepted limitation with a named consequence

Measured at HEAD: `hybrid-search.ts:47` is `export const ABSTENTION_FLOOR: number | null = null`, and `baselines/hybrid.json:31,35` commit `abstentionFalsePositiveRate: 1` at both `k = 5` and `k = 8` — i.e. the cap tolerates every abstention query returning something.

**The consequence, stated plainly:** a widened search over an irrelevant question returns the least-bad rows from N projects instead of from one, and there is no absolute relevance threshold to stop it. The relative filter (`RELATIVE_LEVEL_RATIO = 0.4`) still applies and still cuts rows below 40% of the leader's level — but it is relative to whatever the leader happens to be, so a widened pool with a mediocre leader passes a mediocre page.

The only mitigations shipping here are the description's restraint clause (D15) and `foreignScopeRate` catching _unauthorized_ widening rather than _unhelpful_ widening. **Calibrating the floor is deliberately not attempted**: it requires a committed `pnpm run eval --sweep-abstention` grid (`retrieval-evaluation/spec.md:213`) over a corpus that does not yet contain the widened queries phase 3 adds, and the current grid's two level distributions still overlap on [0.296, 0.307] (`hybrid-search.ts:55`). Calibrating against a corpus that is about to change is calibrating against nothing.

### D15 — The description obligation is its own requirement, and the character budget is the hard part

Precedent: `mcp-api/spec.md:456`, "The `memory.archive` description MUST steer against autonomous retirement", is a requirement distinct from the one that registers the tool, for the same reason — the description is the only channel that reaches the model.

**The asymmetry, reasoned through rather than asserted:** on a single-user instance with a `*` token the authorization gate **always passes**, so it bounds nothing about how often the model widens. The description is the only thing that does. Symmetrically, the description cannot substitute for the gate: it is advisory text a model may ignore, and a multi-tenant instance needs the refusal to be structural. **Both are required, for different threats** — noise, token cost and precision on one side; unauthorized access on the other. `mcp-api/spec.md:456`'s own closing sentence applies here too: these constraints must be in the top-level description text, not only in the per-argument `describe()`, because some clients do not surface the latter to the model.

**The budget is genuinely tight and the arithmetic is named here because `mcp-api/spec.md:479` requires it.** Measured from the constant at `mcp/server.ts:130`: `SEARCH_DESCRIPTION.length = 1854` against `DESCRIPTION_MAX_LENGTH = 1900` — **46 characters of headroom**.

| clause                                                                                             | chars | status                             |
| -------------------------------------------------------------------------------------------------- | ----: | ---------------------------------- |
| existing headroom                                                                                  |    46 | free                               |
| `" Every connection sees exactly one project's memories."`                                         |    54 | becomes FALSE — must go regardless |
| `" (path, git SHA, URL, error code, ticket, CVE, IP, hostname, systemd unit, MAC, env var, UUID)"` |    94 | reclaim candidate                  |

Reclaiming the first gives **100** characters; reclaiming both gives **194**. A minimal conforming replacement — naming the argument, the restraint condition and the marker — measures ≈170 characters in draft, so **the second reclaim is probably required and its cost is real**: the entity-kind list is duplicated in substance inside the `entity` property's own uncapped `describe()`, but `mcp-api/spec.md:458` records that some clients do not surface per-argument descriptions, so moving it there is a partial loss rather than a free move.

**Recorded default: reclaim, do not raise the cap.** `mcp-api/spec.md:2183` permits raising it only with "the re-verified client ceiling and the retained margin" recorded, and the current 148-character margin below Claude Code's verified 2 048 exists so the guard fires on approach. Spending it to fit one clause trades a permanent safety margin for a one-off. The exact final wording and the exact reclaim are left to the apply phase under a **mandatory measurement from a live `tools/list` response**, not from the constant — `mcp-api/spec.md:2185`'s own scenario requires the change to record the measured length and remaining headroom.

### D16 — Every new guard is mutation-proved, and a single-project fixture proves nothing

`scripts/mutate.mjs` drives the backup/mutate/run/restore loop, one condition at a time. Guards owed a proof: the authorization filter (drop it → every project admitted), the home-project membership assertion, the empty-set guard, the write-path type barrier (a `SearchScope` reaching a write — verified by a hand `tsc` widen/restore loop, because `mutate.mjs` drives vitest and vitest ignores `@ts-expect-error`), the `foreignScopeRate` cap, and the `IN`-predicate construction.

**The vacuous-proof trap, named because this repo keeps hitting it:** a widening test whose corpus holds rows in only one project passes with the widening deleted, with the authorization filter deleted, and with the predicate inverted. Cross-project fixtures with **non-zero counts on both sides** are therefore mandatory, and every widening assertion carries a non-vacuity control — the same rule that produced `retire-the-global-scope`'s `count(*) FROM memory_vec > 0` beside its partition assertion. A test green on both sides of a mutation is the default outcome, not the exception.

---

## Risks / Trade-offs

- **[Risk] The harness is fixed but still cannot detect over-widening, and phase 4 ships on a green light that means nothing.** → Mitigation: phase 3's acceptance criterion is not "the new metric exists" but "the over-widening arm goes **RED**" — the same mutation `retire-the-global-scope` 16.15 measured as leaving the eval green with MRR@8 _rising_ 0.828 → 0.859. Until that arm reds, phase 4 does not start.
- **[Risk] A widened search leaks a project the token may not read.** → Mitigation: the set is built by the same `isAuthorized` predicate that already filters `project.list` (`project-tools.ts:205`), at one construction site (D4), behind a type a write cannot hold (D3), with the filter mutation-proved (D16). The residual is a bug in `isAuthorized` itself, which is shared with every other authorization decision in the tree.
- **[Risk] A one-element widened set silently changes behaviour for `project:<id>` tokens.** → Mitigation: measured identical — `partition_key IN ('P1')` returns exactly what `partition_key = 'P1'` returns (`measurements/vec-partition-capability.md` §3), and D4 collapses the set to the narrow scope before the query is built, so the code path is the same one, not merely an equivalent one.
- **[Risk] Widening resolves to an empty set and the search silently returns nothing.** → Mitigation: measured that `IN ()` returns empty rather than erroring, so the failure would be silent. The home project is always a member by construction; that is spec'd as a requirement and pinned by test rather than left to the constructor.
- **[Risk] The per-turn cost is 8.3× on the dense branch and nothing bounds how often the model widens.** → Mitigation: the description requirement (D15), which is the only lever on a single-user instance, plus `searchedProjects` making the reach visible to whoever reads the transcript. **Accepted, not eliminated** — this is the trade the feature is.
- **[Risk] The `Scope` collapse breaks the retrieval harness and the fixtures get rewritten under time pressure at the same moment the baselines are being re-derived.** → Mitigation: phases 1 and 3 both touch `test/retrieval/`, so the baselines are re-derived **once**, after phase 3, with `--lower-floors` **printed rather than silently applied** (`ratchetFloors` refuses to lower without the flag, `floor-ratchet.ts:52-61`). Any lowering must be named in review, per `retrieval-evaluation/spec.md:126`.
- **[Trade-off] Release N+1 is left half-done** (D2). → Accepted because `memory/spec.md:1619` already reserves the schema half, its timing depends on a rollback-window judgement this change cannot make, and the type collapse makes the remaining half strictly easier by deleting the call site that kept the branches live.
- **[Trade-off] `ABSTENTION_FLOOR` stays `null`, so a widened irrelevant query returns the least-bad rows from N projects** (D14). → Accepted knowingly, with the consequence named, because calibrating it against a corpus that phase 3 is about to change would calibrate against nothing.
- **[Trade-off] `avgTokensReturned` stays ungated** (D9). → Accepted because `retrieval-evaluation/spec.md:116` reserves it for its own change and `foreignScopeRate` is the sharper instrument for this one. **This does mean the token cost of widening is not gated by CI** — stated so nobody reads `foreignScopeRate` as covering it.
- **[Trade-off] The `memory.search` description loses a clause to fit the new obligation** (D15). → Accepted; the reclaimed clause is named, its partial-loss cost is stated, and the alternative (raising the cap) would spend a verified 148-character safety margin on a one-off.
- **[Trade-off] Archived projects are excluded from the widened set** (D5). → Accepted: an archived project refuses `initialize` outright, so including it would return rows from a project the same token cannot open.

## Migration Plan

**There is no migration.** No table is created, altered or rebuilt; no column is added; no index changes; `schema-drift.test.ts` is untouched. The `Scope` collapse is a TypeScript change, and `scopeWhere('project', id)` emits the same SQL against the same columns before and after.

**Existing installations, addressed explicitly:**

1. **First boot after upgrade** does nothing unusual. No migration runs, so `db/migrate.ts` applies nothing and the boot cost is unchanged.
2. **Derived data is not invalidated.** `memory_fts`, `memory_fts_vocab`, `memory_vec` and the three entity tables are functions of `memory`, and no `memory` row is read for writing or written. No reindex, no backfill, no drain, no `entity-state.json` deletion.
3. **Pre-existing tokens are unaffected.** No token row is read differently; `isAuthorized` is called with the same arguments it already receives, once per candidate project instead of once.
4. **Rollback is clean, and this is the one place to be precise.** The older image never sees `across_projects`, and because its schemas are strict it **refuses** the argument with `-32602 unrecognized_keys` rather than silently ignoring it — fail-closed, and legible to the operator. No data written by the new image is unreadable by the old one, because none of it is new. The one asymmetry worth a release-note sentence: an agent whose plugin still sends `across_projects` after a rollback gets a hard error on every search rather than a degraded search, which is the correct direction but is not what an operator expects from a "no schema change" rollback.
5. **The stranded-row hazard from `retire-the-global-scope` 16.14 is untouched and is NOT made worse.** A row written at `scope='global'` while rolled back onto 0.25.x is unreachable today; after this change it is unreachable in exactly the same way, because deleting `GLOBAL_PARTITION_KEY` from the code deletes no data and changes no query that could have found it. Recorded so the deletion is not mistaken for a fix or for a regression.

**Verification against pre-existing seeded data is a standing requirement**, and `dev:docker:up` reseeds with `seed-dev --reset` on every boot, so it is **not** a valid instrument for it. The Docker smoke uses a volume that already holds rows, upgrades on the same volume without reset, exercises a widened and a narrow search on it, and rolls back on the same volume.

## Open Questions

**OQ1 — Should the widened set include projects the token can read but that hold zero memories?** Recorded default: **yes, include them** — the set is the token's reach, and filtering on emptiness would make `searchedProjects` a function of corpus state rather than of authorization, so the same token would report a different reach on two days. The cost is a partition scan over an empty shard, which §4's linearity says is free. Left open because an owner who reads `searchedProjects` as "where I looked and found something" would want the opposite.

**OQ2 — Should `memory.search`'s `topic_key` filter behave differently when widened?** `topic_key` is unique per `(scope, project_id, topic_key)` among active rows, so a widened `topic_key` query can return N active rows for one key — one per project. Recorded default: **return them all**, because "which projects have converged on this topic, and did they converge on the same answer" is a legitimate and probably valuable question. Named because the narrow branch's documented behaviour ("returns a topic's whole history — the active row plus every row it superseded") reads as though there is exactly one active row, and widened there is not.

**OQ3 — Does `across_projects` belong on `memory.search_prompts` as well?** Recorded default: **no, out of scope.** Prompts are a separate corpus with its own FTS table and no dense branch, so it inherits none of the phase-2 measurement and would need its own. Named because "search my prompts across projects" is the obvious next request and the answer should be findable.

**OQ4 — RESOLVED (owner, 2026-08-05): with this change, as phase 1, in one PR.** The alternative — landing phase 1 as its own PR first — was put and declined. Consequence to carry into review rather than discover there: the final diff mixes a mechanical type deletion across ~15 files with the authorization and ranking logic, so the reviewer has to separate them mentally. Phase 1's commits SHALL therefore stay separate from phase 4's within the branch (no squashing the collapse into the widening), so `git log -p` recovers the separation the PR boundary does not give.

**OQ5 — RESOLVED (owner, 2026-08-05): a third project.** By content those 10 memories are cross-cutting conventions, which is what a shared project represents, and it is the cheapest source of the cross-project distractors phase 3 needs. The known cost is accepted deliberately: it moves the denominator of every committed baseline. That movement SHALL be attributed to phase 1 (where the fixtures move) and not to phase 4, so a later reader does not read a ranking regression into a fixture reshuffle — task 1.9 is what holds the line, since it requires the floors to hold across the collapse without `--lower-floors`.

**OQ6 — RESOLVED (owner, 2026-08-05): scored over non-widened queries only, as a hard 0 cap.** Any foreign row in a query that did not ask to widen is a leak — a dissolved `scopeWhere` branch, a widened default, a forgotten predicate — and the metric says so with no threshold to argue about. The rejected alternative, a hand-labelled expected range per widened query, was declined because the expectation is a fixture and a wrong fixture turns the gate into noise or, worse, into a gate that passes what it exists to catch.

**Widened queries are therefore NOT ungated, they are gated by a different instrument**, and the implementation must make that true rather than assume it: their gold SHALL deliberately live in a foreign project, so `recallAtK` cannot be satisfied without the widening actually reaching it, and `precisionAtK`/`mrr` move if foreign rows crowd out the answer. Task 3.x SHALL prove this the same way phase 3 proves everything else — mutate the widening to return home-project rows only and confirm those floors go RED. Without that demonstration the claim "widened queries are covered" is exactly the unverified assertion this repo keeps catching.

### D17 — The repository boundary should speak `Scope`, not `projectId: string` (correction to phase 1, found by review)

Phase 1 reduced `scopeWhere` / `scopeCondition` / `partitionKeyFor` to `(projectId: string)` and did the same to the six search-serving option bags (`SearchMemoryIdsOpts`, `SearchBm25IdsOpts`, `TextByIdsOpts`, `KnnOpts`, `HybridSearchOpts`, `findMemoriesByEntity`). Deleting the phantom `scope: MemoryScope` field was right; **replacing the value object with a bare primitive at that boundary was not**, and the cost falls due in phase 4.

Task 4.2 commits those same reads to accepting `SearchScope`. A `string` carries no discriminant, so phase 4 has exactly three routes from here, and all three are worse than the shape phase 1 could have left:

1. `string | readonly string[]` — stringly-typed, `Array.isArray()` at the seam, and the widened case is indistinguishable from a one-project list by type.
2. A second exported `scopeWhereIn` beside `scopeWhere` — the two-shape drift **D6 already argues against** for the query itself; the same argument applies to its builder.
3. Change the parameter to `SearchScope` — which re-edits the 19 `scopeWhere`/`scopeCondition` call sites in `memory-repository.ts` plus three elsewhere. That is the identical edit phase 1 just performed, performed again.

**Had the builders and those six bags taken `scope: Scope`, phase 4's widening would need no edit at the call sites at all.** That half is now landed and verified: 21 call sites moved (19 in `memory-repository.ts`, 2 in `entities-repository.ts` — not the "three elsewhere" this decision first claimed), the emitted SQL is byte-identical before and after, and widening `scopeWhere`/`scopeCondition` to `SearchScope` requires no further churn because the search bags already pass `opts.scope` and everything else passes an assignable `Scope`.

**Two claims in the original wording were wrong, and are corrected here rather than quietly dropped.**

1. **The compile-time barrier does NOT come free.** This decision said D3's barrier would fall out of the parameter types instead of needing 4.2's hand-`tsc` widen/restore proof. It will not: `scopeWhere` is shared by search and non-search reads, so the moment its parameter widens to `SearchScope`, _every_ caller accepts a widened scope by type. The barrier can only live one level up, at the option bag (`SearchMemoryIdsOpts.scope: SearchScope` against `findActiveByTopicKey`'s single-project parameter). **Task 4.2's hand-`tsc` proof stays; this work does not discharge it.**
2. **`partitionKeyFor` cannot become `SearchScope → string[]`.** It is on the write path — `embedding-worker.ts` and `seed-volumetric.ts` feed its result straight into `insertEmbedding`, which takes one key for one row. A `string[]` return would force every writer to index `[0]`. The widened form is a **second** function, not a widening of this one.

**"Three signature widenings" also undercounts**: the real figure is six to eight one-token field-type edits. The spirit survives — each is now a one-token change on a field type rather than a re-plumbing — but the number was wrong.

**Two edits remain unlanded because they cross into files phases 2 and 3 own**, measured by applying them, recording the `tsc` breakage and restoring: `partitionKeyFor(scope: Scope)` breaks `scripts/seed-volumetric.ts` (needs `partitionKeyFor(scope)`), and `HybridSearchOpts.scope` breaks `test/retrieval/queries.test.ts` (needs `scope: projectScope(scope.projectId)`). Task 4.0 stays unticked until those two land, after the phases merge and before 4.2.

The layering objection — `db/` importing a type from `services/` — is already settled by this change's own task 4.2, which has those repository reads taking `SearchScope` from `services/scope.ts`. So the boundary crosses either way; the only question is whether it crosses carrying a discriminated value or a bare string.

**Not applied in phase 1, deliberately.** The phase-0 baseline and phase 1's evidence (86 files, floors held, suite green) were measured against the shape as landed, and re-cutting the repository boundary afterwards would invalidate that evidence for a benefit that is not due until phase 4. **Phase 4 therefore does it as its first step**, before 4.2's widening, so the widening lands on the right shape rather than on top of a second rewrite. This entry exists so that step is planned work rather than a surprise discovered mid-phase.

### D18 — `adminBacklogCount`'s subtract-two-counts shortcut is gone, for correctness first and cost second

**This decision was rewritten after the fact and the original is wrong; the amendment is the point.** As first recorded, D18 read the phase-1 change to this method as a pure performance regression — the predicate `WHERE project_id IS NOT NULL` costing SQLite's `OP_Count` shortcut — and recommended a partial index as the fix if it were ever worth a migration. The code review that followed found the defect underneath, which the performance reading had walked straight past.

**The defect.** The shortcut was `(SELECT COUNT(*) FROM memory WHERE project_id IS NOT NULL) - (SELECT COUNT(*) FROM memory_entity_scan)`. Its exactness rested on a 1:1 FK identity between the two tables, and filtering only the first side broke it: a scan row belonging to a project-less memory is subtracted from a total that no longer contains it. 100 project memories of which 90 are scanned, plus 5 project-less rows scanned by a pre-rollback image, gives `105 − 105 = 0` — an **empty backlog reported while `findMissingScans` still returns 10 rows**. The negative-value guard below it does not fire, because the wrong answer is zero rather than negative. The method's own docstring already demanded the opposite: "Must filter exactly as `findMissingScans` does".

**What shipped instead** (`dd5435f`): the shortcut is deleted and `adminBacklogCount` is unconditionally the anti-join, which filters both sides by construction. Measured cost 1.3 ms against the shortcut's 0.8 ms at 50 000 rows, on an admin-only read (`memory.doctor`, `/dashboard/entities`) that is not on the boot path — the two call sites sit inside the lazily-invoked `buildDoctorReport` thunk.

**The partial-index fix this decision originally recorded is retracted, not deferred.** `ON memory(id) WHERE project_id IS NULL`, subtracted from a bare `COUNT(*)`, corrects one side of the same asymmetry and leaves the other — it would reintroduce exactly the silent undercount above. Its figures were also measured against a statement shape that no longer exists. Anyone optimising this read later must start from the anti-join and prove the result identical on a corpus that contains project-less scanned rows, because that is the population the arithmetic turns on and an empty one makes any comparison vacuous.

**Why this is recorded rather than quietly corrected.** A performance lens and a correctness lens were pointed at the same line on the same day and only the second one saw it. `CLAUDE.md`'s rule — classify from behaviour, not from the symptom's shape — is what the first pass failed: "the number got worse" was true and was not the finding.
