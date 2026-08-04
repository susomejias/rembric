# Design — stop promising a clamp that never happens

## Context

Six agent-facing MCP surfaces disagree with what the server does. `proposal.md` carries the measurements; this document records the decisions, the chronology that explains how the incoherence accumulated, and the questions deliberately left open.

The six are not six unrelated bugs. They are three shapes of one defect:

| #   | Surface                             | Shape                                              | Remedy       |
| --- | ----------------------------------- | -------------------------------------------------- | ------------ |
| 1   | `memory.get({ids})` review metadata | description right, code wrong                      | **fix code** |
| 2   | `memory.session_start.reused`       | closed-form `Returns:` list omits a required field | fix text     |
| 3   | `memory.doctor` counter divergence  | one of two causes named                            | fix text     |
| 4   | `clamped` ×2                        | field reports an unreachable state                 | remove field |
| 5   | `memory.doctor.db.open`             | field reports an unreachable state                 | remove field |
| 6   | `memory.timeline` bound             | rejects a bound the description never names        | fix text     |

**The `clamped` incoherence has a traceable history, and it is nobody's mistake.** Three commits, in order:

1. `b161006 feat: initial public release of Rembric` introduced `openspec/specs/mcp-api/spec.md:659` — "the server SHALL silently clamp to the maximum and SHALL include a `clamped: true` field in the response". Clamp-with-a-receipt was the model, stated plainly.
2. `05181a2 docs(openspec): archive surface-pending-judgment-inventory` added `judgments` as a fourth size argument and inherited the model without questioning it — `openspec/changes/archive/2026-07-28-surface-pending-judgment-inventory/design.md:38-39`, verbatim:

   > **D3 — The bound is the caller's `judgments` value, clamped like every other channel.**
   > `memories`, `prompts` and `sessions` are already clamped to documented maxima. `judgments` follows the same pattern rather than inventing an unbounded read

   On implementation its author discovered that zod rejects before the handler's clamp runs, and recorded the discovery as a footnote on the existing scenario rather than reopening it — `:660`: "the declared input-schema maximum, which over the MCP transport rejects an out-of-range value with `invalid_input` BEFORE the handler's clamp is reached, so the `clamped` flag is the in-process defence rather than the wire behaviour."

3. `a660548 feat(mcp): order relation annotations and report how many exist` added `:2163`, the current house rule: "A `relations_limit` above the maximum SHALL be REJECTED as an invalid argument, not silently clamped, **consistent with every other numeric bound on this surface**".

So `:659` is the legacy model, `:2163` is the later rule that supersedes it in spirit, and `:660` is the moment someone noticed the collision and wrote around it. **Nothing ever decided the flag should exist.** It was inherited, then footnoted. The other five have the same character: each is a true statement that stopped being true, or a claim nobody ever tested at the boundary the agent uses.

**Constraints the design has to respect:**

- The MCP SDK validates `structuredContent` against the `outputSchema` published at registration, so a field cannot leave the payload without leaving the schema in the same commit — and cannot ENTER the payload without entering the schema either (D7).
- `DESCRIPTION_MAX_LENGTH = 1900` (`apps/server/src/mcp/server.ts:124`) guards a verified external client ceiling (`openspec/specs/mcp-api/spec.md:2120-2126`) and does not move.
- Some clients do not surface per-property JSON-Schema descriptions to the model — `mcp-api/spec.md:1084`, with the same constraint imposed on three other tools at `:422`, `:869` and `:925`. Every obligation here is discharged in top-level description text.
- Published scenario TITLES are effectively immutable in this repo (D9).

## Goals / Non-Goals

**Goals:**

- No agent-facing description on the MCP surface states something the server does not do.
- `memory.get`'s two forms agree on the review signal, so the batch flow this repo teaches (`memory.context.needsReview` → batch read → `memory.confirm({ids})`) is not blind at the middle step.
- Where the transport rejects, the description teaches the bound, satisfying `:2163`'s safety condition ("Rejection is only safe if the caller is told how to stay inside the bound") on every tool that rejects.
- The rule is stated **once**, so instance seven costs one scenario.
- The rejection behaviour and the batch review parity each get their first test.

**Non-Goals:**

- Relaxing any maximum. Closed by precedent — D2.
- Removing the in-process `clamp()` calls — D3.
- Adding telemetry to count field rejections — D2, open question 1.
- Changing what any counter counts. `memory.doctor`'s unfiltered pending count stays exactly as `memory/spec.md:1130` specifies; only its description changes.
- Touching `POST /api/<slug>/memory/recall`, whose `[1,5]` clamp is deliberate and publishes no field.
- Moving `DESCRIPTION_MAX_LENGTH`, adding an MCP tool, or any database change.

## Decisions

### D1 — One general requirement with three failure modes and three remedies, not six tool-specific edits

Six instances in one sweep, on top of `abstained` three days earlier, is the evidence that a per-tool rule does not hold the line. The added requirement states the invariant at the level the defect lives at — **the description, the declared `outputSchema` and the emitted payload SHALL agree** — and enumerates the three shapes and the three remedies, with the six as scenarios.

The third remedy is the load-bearing one: **correct the CODE.** Without it the rule would read as "make the description match whatever ships", which is precisely the wrong direction for instance 1, where the description states the intended contract and one branch fails to honour it. The requirement therefore says explicitly that a description SHALL NOT be weakened to match a defective implementation, and that which of the two moves is a decision the change must record.

**Alternative considered: fold the rule into the existing `:2157` reject-not-clamp requirement.** Rejected. That requirement is specifically about `relations_limit` on `memory.search`/`memory.get`, including a per-parameter recipe (`min(relationsTotal, <maximum>)`) that does not generalise — `memory.context` has no `sessionsTotal`. It also has nothing to say about instances 1, 2, 3 or 5.

**Alternative considered: one new requirement per instance.** Rejected as the six special cases the general form exists to avoid.

**Alternative considered: extend `:856` ("The observability tool descriptions MUST disclose which population their counters cover") to cover all tools.** Rejected — that requirement is about counter POPULATIONS specifically and is the right home for instance 3 (which is why instance 3 lands there), but stretching it to cover unreachable output fields would leave the general rule filed under a name nobody would search for.

### D2 — "Relax the maxima so `clamped` becomes reachable" is closed by precedent, not open

`openspec/changes/archive/2026-07-30-bound-annotation-response-size/design.md:206-211` already rejected, in writing, the exact design `clamped` embodies:

> **Clamping with a receipt** (clamp, and report the applied bound in the response) — not silent, and honestly the closest call. Rejected because it splits one parameter into two truths (requested vs applied) that a caller must reconcile on every read; because the caller only learns after paying for the round trip it was trying to budget; and because it adds a response field on every read to describe a situation that the description can teach an agent to avoid entirely.

and, on the silent variant, `:200-204`:

> the caller cannot distinguish a clamped list from a complete one except by comparing against `relationsTotal`, which is the boolean-truncation-flag problem in a new place. It also contradicts the published "REJECTED, not clamped" in the requirement it would amend.

Both objections apply here word for word, and the second names this repo's own published rule. **Recorded as rejected-by-precedent, not re-argued.**

That design's Open question 2 keeps a door ajar — clamp-with-a-receipt may be revisited "in case field evidence shows agents hitting the rejection often" (`:211`). The honest statement of its status: **the instrument it names does not exist.** Nothing records a field-level rejection rate; `-32602` responses are not counted, logged per-parameter, or aggregated anywhere. The door is ajar onto a measurement no one is taking, and reopening the question requires building the counter first — a separate change, not a reason to keep dead fields meanwhile.

### D3 — The in-process `clamp()` calls stay

`clamp(args.sessions ?? 3, 0, 25)` and its siblings (`memory-tools.ts:1332,1333,1373`), the timeline pair (`:1529-1530`) and `clamp(requestedLimit, 1, 100)` (`prompts.ts:279`) are all kept, with nothing reporting on them.

**Why keeping is the consistent choice, not the lazy one:** `memory.search`'s `clampLimit` (`services/memory.ts:819-824`) is already in exactly this state — an unreachable in-process bound with no flag — and nobody has proposed deleting it. After this change every bounded surface looks the same: the transport rejects, a defensive clamp sits behind it.

**Why not delete them:** `buildMemoryHandlers` returns plain functions. Today the only caller is the tool registration, so the schema is always in front; a future direct caller (an HTTP route, a job, a test) would face an unbounded `memories: 10_000_000` and get a slow query instead of a validation error. Cheap insurance for a bound this repo has been bitten by before (`surface-pending-judgment-inventory` D3's own risk line: "An unbounded-feeling `judgments` value invites a large joined read on the session-start path").

**Alternative considered: delete the clamps, making the schema the single source of the bound.** Rejected for the reason above, and because it turns a text-and-schema change into a behaviour-changing one for zero observable gain.

**Alternative considered: keep them and add a comment explaining they are defensive.** Rejected under this repo's comment policy — the rationale belongs in the spec (which now says it) and here. The named constants from D5 make the intent readable without prose.

### D4 — The five descriptions, with the character arithmetic fixed here

Every figure below is measured from the constant and MUST be re-measured from a real `tools/list` response, per `mcp-api/spec.md:2122` ("reading each description from a real `tools/list` response rather than from the description constants"). If a measured figure differs, the wording drifted — fix the wording, not the expectation.

**`memory.context` (`server.ts:312`): 1333 → 1432, headroom 468.** Delete the 96-character tail clause, verbatim and including its leading space:

> ` Default sizes are small; the response includes a \`clamped:true\` flag if you asked for too much.`

leaving 1237, then append (195 characters, including its leading space):

> ` Default sizes are small (sessions 3, memories 10, prompts 5, judgments 5) and each has a maximum: sessions 25, prompts 50, memories 100, judgments 50. Above it the call is rejected, not clamped.`

The existing mid-string `judgments` clause ("max 50 — a deeper queue takes more than one pass; asking for more is rejected, not clamped") is **left alone**: it is mandated by the description scenario at `mcp-api/spec.md:713-718`, and the duplicated "50" costs three characters against 468 of slack.

_Alternative wording_ (191 chars, 1428 / 472 headroom): ` Default sizes are small and every size is bounded: sessions max 25, prompts max 50, memories max 100, judgments max 50. A value above a maximum is rejected, not clamped — ask at or below it.` Rejected for the 4 characters it saves: it drops the concrete defaults, and an agent that knows the default is 3 sessions can decide whether to pass an argument at all without a schema read. Recorded because the delta mandates only the **maxima** and the reject clause, so a future editor may reclaim those 44 characters without breaking a requirement.

**`memory.search_prompts` (`server.ts:367`): 357 → 428, headroom 1472.** `Returns \`{ scope, prompts[], total, clamped }\`.`(47) becomes`Returns \`{ scope, prompts[], total }\`. \`limit\` defaults to 25, max 100 — above that the call is rejected, not clamped.`(118). This description never mentioned`limit`at all, so`:2163`'s safety condition was unmet and is now met.

**`memory.session_start` (`server.ts:280`): 461 → 624, headroom 1276.** `Returns: { sessionId, scope, projectId, startedAt }.` (52) becomes `Returns: { sessionId, scope, projectId, startedAt, title, reused }. \`reused:true\` means this call ADOPTED the host's already-active session instead of starting one, so the sessionId is the host's, not a new session.`(215). The tail placement is deliberate: the description's own first sentence tells the agent it usually should not call this tool, and`reused` is what tells it what happened when it did anyway.

**`memory.doctor` (`server.ts:378`): 403 → 612, headroom 1288.** `and they will differ.` (21) becomes `and they will differ — for two reasons: population (server-wide vs scoped) and, for \`pendingJudgments\` only, filtering (doctor counts every pending row; the scoped totals count only adjudicable pairs, both endpoints still active).`(230). Inserted mid-string, before the closing "Use at session start when behavior seems off." — required, not stylistic:`:856` mandates that "`memory.doctor`'s server-wide disclosure SHALL NOT be the trailing clause", because truncation is a tail cut.

**`memory.timeline` (`server.ts:334`): 210 → 395, headroom 1505.** The opening sentence gains `Args: { memoryId, before? (default 5), after? (default 5) }; before + after must not exceed 50 — a larger window is rejected with invalid_input, not clamped; use memory.search instead.` The remedy clause is the same one the handler's error message already prints (`memory-tools.ts:1531-1536`), deliberately, so the description and the error agree word for word.

**`GET_DESCRIPTION` (`server.ts:133`) is NOT touched.** It says "For an active memory the response also carries `reviewState`/`reviewAfter`" without qualifying by form, and after D7 that is true of both forms. Qualifying it instead would have been the wrong remedy (D1).

### D5 — The maxima become named constants; the timeline window gets its own

Today `PENDING_JUDGMENTS_MAX = 50` (`memory-tools.ts:84`) is the only named bound on this surface. `25`, `50` and `100` each appear twice for `contextSchema` (`:260-262` and the handler's clamps at `:1332,1333,1373`), and `50` appears three more times for the timeline window (`:283,284,1531`). The removals edit the second copy of each anyway, so hoisting is free now and not later.

**The timeline bound is in scope and takes a SEPARATE constant.** Two reasons, one of them a live divergence risk:

1. Its `50` is embedded in the error message text — `'memory.timeline: before + after exceeds 50; for larger windows use memory.search'`. A bound change that misses the string ships a message disagreeing with the check it explains, which is this change's own defect class in miniature. D4 now also puts that number in the tool DESCRIPTION, making it a third copy — so the constant has to feed all three.
2. It is **semantically a different 50** from `prompts`' and `judgments`': a combined-window budget across two arguments, not a per-argument page cap. One shared constant would mean tuning the prompt page size silently moves the timeline window.

**Alternative considered: leave `timelineSchema` out of scope.** Rejected — same file, same edit session, and it carries the only message-drift risk of the five.

**Alternative considered: one shared `CONTEXT_PAGE_MAX` for every 50 on the surface.** Rejected per reason 2.

### D6 — The `abstained` parallel is cited for the standard, not the outcome

`openspec/changes/archive/2026-08-03-tell-the-truth-about-the-relevance-gate` is the same family: an agent-facing flag documenting an unreachable state. Its remedy was the opposite of `clamped`'s — it **repaired** `abstained` by giving it a newly reachable meaning (an empty fused pool) rather than removing it.

That is not an inconsistency, and the difference is not taste:

- `abstained` had a reachable meaning available that nothing forbade. The empty-pool state genuinely occurs and one branch condition made it observable.
- `clamped` has **no** reachable meaning without relaxing a maximum, and relaxing a maximum is what `bound-annotation-response-size` D6 forbids (D2). Every path to a live `clamped: true` runs through a design already rejected in writing.
- `db.open` is worse still: its `false` is reachable only in a state where the tool returns nothing, so there is no observation to make.

The general requirement therefore permits all three remedies and lets the instance decide, which is what keeps the `abstained` repair conforming under the rule this change adds. Stated explicitly so a future reader does not read the two changes as contradicting each other.

### D7 — The `memory.get` fix is a code fix, and it needs a schema widening first

The batch branch gains one `reviewStateForMemories` call over the rows it already fetched — the same batched derivation `handleSearch` performs at `memory-tools.ts:992` — plus `replaces`, which is a column on those rows.

**It cannot be done without touching `memoryRow` first.** `memoryRow` (`memory-tools.ts:310-337`) is the shared row schema for BOTH `memory.search` rows (`:376`) and `memory.get`'s batch rows (`:441`). It declares `reviewState` and `reviewAfter` (`:331-332`) but neither `reviewEscalated` nor `replaces`, so emitting either without widening the schema fails output validation and the call is rejected rather than silently wrong. Both are added as OPTIONAL, which leaves `memory.search` byte-identical: it emits `reviewState`/`reviewAfter` only (`:1061-1062`) and continues to.

**Alternative considered: split the batch row into its own schema** so the two surfaces cannot drift. Rejected — it duplicates twenty field declarations to express a difference of two, and the shared schema is what makes the batch/search parity cheap to keep. The optional-field widening is the smaller change and the drift it permits is bounded by the scenarios this change adds.

**The two asymmetries that stay, each with its reason recorded in spec text** so a future reader cannot mistake either for drift:

- **`lastSeenAt` stays batch-only.** The single-`id` form advances the very signal it would be reporting, so the value it could return is the timestamp its own call just wrote — tautological rather than informative.
- **The ancestry projection stays single-`id`-only** (`head`, `predecessors`, `predecessorCount`, `truncated`, `headTruncated`). Those are per-target walks; N of them would turn a bulk read into N ancestry queries, against a path `walk-ancestry-in-one-query` was optimised for. A caller needing history uses the single-`id` form, and the description promises ancestry only there.

**`confirmationCount` is deferred, not decided.** It is a single count per row and could be batched, but no description promises it on the batch form, and adding a per-row count to a bulk read is a query-shape decision for `db-performance-auditor` rather than a guess inside a prose-correctness change. Open question 3.

**Why `:297` is rewritten rather than merely satisfied.** "Each entry carrying the same per-memory shape as the single-`id` form" is unenforceable: it names no fields, so no scenario can be written against it, and it was false in both directions for however long the batch form has existed. An enumeration plus explicitly-named asymmetries is testable; a parity claim is not. This is the same reasoning `say-which-population-the-doctor-counts` applied to counter names.

### D8 — `memory.doctor`'s counters do not move; only its description does

Instance 3 is a prose defect over correct, deliberate behaviour. `memory/spec.md:1130` says doctor's pending count "SHALL remain an unfiltered count of pending rows", and `filter-retired-endpoints-from-pending-queue` D5 chose that deliberately: "They are inventory counters over the table… filtering an `admin*` count would give the operator a number that hides rows their own list shows."

So this change adds an obligation to `:856` (name EVERY cause of the divergence) and edits one string. It does not touch `adminCountByStatus`, `countPendingInScope`, or the dashboard badge fed from the same admin count. `:856`'s own closing sentence already forbids more: "It SHALL NOT be read as re-scoping any counter… satisfying it SHALL NOT add, remove or rename a field on either payload."

**Alternative considered: filter doctor's count so the two agree.** Rejected — it contradicts `memory/spec.md:1130` and D5's operator argument, and it would need its own change against the `memory` capability.

**Alternative considered: leave the description alone because the divergence is specified.** Rejected. Being specified is not being disclosed: the spec says the field is unfiltered, and the description says the only difference is scope. An agent reads the description.

### D9 — Two published scenario TITLES are kept although their wording predates the change, because the repo's tooling makes a scenario rename impossible

The two `clamped` scenarios this change rewrites are titled "`memory.context` arguments exceed clamps" and "`memory.search_prompts` clamps limit and reports it". Both titles assert the retired behaviour. They are kept **verbatim**, with the corrected behaviour in their bodies and a one-line note under each saying the title predates it.

The reason is mechanical, and it was found by running the gate rather than reading it. `scripts/check-delta-freshness.mjs:93-101` fails a change when any published `#### Scenario:` title inside a `## MODIFIED Requirements` block is absent from the delta; its header states the rule as absolute — "Missing headers and dropped scenarios always fail — neither can be intentional" — and it is CI-gated at `.github/workflows/ci.yml:118`. A rename is indistinguishable, to that script, from a delta authored against stale text, and there is no exemption directive. Measured: with the renamed titles the script exited 1 with two blocking problems; with the published titles restored it exits 0 with six body advisories, and every one of those six is a deliberate rewrite this change makes.

**Alternative considered: rename and accept the CI failure.** Rejected — a red gate on a spec-hygiene change is the wrong precedent, and the gate exists because delta staleness silently reverted published text three times in one day.

**Alternative considered: keep the old title as a stub pointing at a new, correctly-named scenario.** Rejected — tool-appeasing cruft in the public contract is worse than an imprecise title.

**Alternative considered: teach the script an explicit rename directive.** Not rejected on the merits, but out of scope: it is a tracked script outside this change's boundary and needs its own tests. Open question 4.

### D10 — Removals are BREAKING on three output schemas and that is accepted

`clamped` is required on two schemas and `db.open` on a third, on a surface with no version negotiation. Accepted, on the reasoning `openspec/changes/archive/2026-08-03-scope-and-name-the-project-memory-count/design.md` set at D5:

- `:90`, on the compatibility shim: "ship both fields for backward compatibility … rejected. It preserves a field the change exists to discredit, and a consumer reading the old key keeps getting the misleading number indefinitely."
- `:98`, on why a loud failure is the better one: keeping the key "would ship changed semantics under an unchanged key, which is the worse of the two failure modes — a consumer has no signal to re-check. A renamed key fails loudly at the first parse."

A removed key fails loudly on the same terms, and the blast radius is smaller than in that precedent: zero hits for `clamped` under `apps/plugin/`, `docs/`, `README.md`, `CONTRIBUTING.md`; no typed client; agents read the JSON.

**Alternative considered: `clamped: z.literal(false)`** — keep the key and make its impossibility self-enforcing, as `gateShortened` did with `z.literal(true).optional()`. Rejected: `gateShortened`'s literal encodes a RULE (omit rather than emit `false`); this one would encode only "this field has one value forever", shipping a required key no caller can use.

**Alternative considered: deprecate in the schema description, remove next major.** Rejected — the MCP surface has no deprecation mechanism (no version negotiation, no capability flag), so "deprecated" is a note the model may never see, carrying a false promise through another release.

### D11 — The dead unit test is replaced, not deleted

`context-pending-judgments.test.ts:208` ("the in-process clamp bounds a size over the max instead of throwing") is a _correct_ test of a genuinely dead path, and its own comment at `:205-207` says the state is unobservable on the wire. It goes because its assertion (`clamped === true`) names a field that will not exist — not because it was wrong.

What replaces it is coverage the shipped behaviour has never had: **each of the four arguments at max+1 asserting `-32602`, with an at-max control that must pass.** The pattern is `mcp-integration.test.ts:378-410`, which already does this for `relations_limit` including the control. Same for `prompts.test.ts:288-295`, whose service-level clamp test becomes a wire-level `limit:101` and `limit:0` rejection plus a `limit:100` control.

The controls are not decoration: with only failing cases, a broken probe and a real rejection look identical (CLAUDE.md, "Probe the boundary the real caller uses, and include a control that must pass"). The same rule is why the `memory.get` parity test asserts BOTH forms in the same connection — a test asserting only the batch form cannot distinguish a correct batch from a scope where nothing needs review.

### D12 — `memory.context`'s relevance-channel signal is deferred, with the line stated

The sweep also found that `memory.context`'s description explains a small `relevantMemories` only as "empty if nothing is relevant", while `rankedPass`/`gateShortened` are reachable there — measured `rankedPass {abstained:false, gateShortened:true}` with `relevantCount 1` on a 7-row pool, control `{abstained:false}` with `relevantCount 5`.

**Deferred**, and the line is worth stating because it is what distinguishes it from instance 2, which IS included: **does the description make a false statement, or merely an incomplete one?** `memory.session_start` says "Returns: { sessionId, scope, projectId, startedAt }." — a closed enumeration that is factually wrong about a REQUIRED field. `memory.doctor` names one of two causes — factually incomplete in a way that leads to a wrong conclusion. `memory.context`'s "empty if nothing is relevant" is true as written; it simply does not mention a conditional field. That is an omission, not a disagreement, so it falls outside the requirement this change adds.

Two further reasons: it belongs to a different requirement (`mcp-api/spec.md:744`), and it competes for the same 468 characters as the maxima clause this change owes under `:2163` — which is mandated, while the relevance clause is discretionary.

**It should nonetheless be reopened.** The archived deferral's stated premise was "adding a mention would be new mandated content in a second capped string for no measured benefit" (`archive/2026-08-03-tell-the-truth-about-the-relevance-gate/design.md:122`), and the measurement above falsifies "no measured benefit". Recorded in `tasks.md` 12.3 with the numbers so the next change starts from evidence. Open question 2.

## Risks / Trade-offs

- [Risk] A consumer outside this repo parses `clamped` or `db.open` and breaks on the missing key → Mitigation: measured, not assumed — zero hits under `apps/plugin/`, `docs/`, `README.md`, `CONTRIBUTING.md`; four HTTP routes, none of them context or doctor; no typed client. Removal is also announced in the descriptions' return shapes, the only channel an agent consumer reads. Rollback is an image downgrade with no data step.
- [Risk] The `memory.get` batch fix adds a per-call cost on a bulk read → Mitigation: it is ONE batched derivation for the whole page, the same call `handleSearch` already makes on every search (`memory-tools.ts:992`), not one per row. Measure it on the seeded Docker volume at the largest `ids` batch the schema admits, and record the figure; if it is not flat in page size, the implementation looped and must be corrected.
- [Risk] Widening the shared `memoryRow` lets `memory.search` and `memory.get({ids})` drift on the new fields → Mitigation: both additions are optional, so nothing changes for search today, and the parity scenarios name the batch form explicitly. Whether search should also emit `reviewEscalated` is pre-existing and recorded as deferred (`tasks.md` 12.5) rather than silently absorbed.
- [Risk] Five description edits push a mandated clause out of the truncation window → Mitigation: the arithmetic is fixed per-tool in D4 with the largest result at 1432 of 1900, all re-measured from a real `tools/list` as a task, with the existing every-tool cap assertion (`mcp-integration.test.ts:582`) as the backstop. `memory.doctor`'s new clause is inserted mid-string because `:856` forbids its disclosure being the tail.
- [Risk] Hoisting maxima to constants relaxes a bound by typo → Mitigation: the mutation gate weakens each `.max()` **separately** — four mutations for `contextSchema`, one for `search_prompts`, one for the timeline window — each requiring the test naming that argument to go red while the others stay green. A combined mutation cannot tell which test carried which bound.
- [Trade-off] The general requirement constrains tools that do not exist yet → Accepted: seven instances in three days is the evidence that a per-tool rule does not hold. The constraint is cheap (do not publish a claim you cannot honour) and the escape hatches are explicit (make the state reachable, or fix the code).
- [Trade-off] `:660`'s "in-process defence" clause leaves the spec while the defence stays in the code (D3) → Accepted: the clause exists only to excuse a field that will no longer exist, and the surviving clamps are now indistinguishable from `memory.search`'s, which no requirement documents either.
- [Trade-off] Four scenarios are rewritten rather than corrected in place, and two keep stale titles (D9) → Accepted: both `clamped` scenarios assert a `clamped: true` response, so neither has a corrected form; they are replaced one-for-one by rejection scenarios over the same inputs, so coverage does not drop.
- [Trade-off] This change touches seven published requirements at once → Accepted, because the alternative is seven changes that each re-argue the same rule. The blast radius is bounded by what does NOT move: no counter's value, no query, no migration, no invariant.

## Migration Plan

There is no migration. Stated positively so it is not read as an omission: **no database change of any kind** — no new column, index, trigger or table rebuild, and no migration file. Nothing derived needs invalidating: `memory_fts`, `memory_vec` and the three entity tables are not written, not read differently, and not re-scoped.

**First boot after upgrade** on a populated installation (hundreds of memories, a live pending queue): no startup work, no sweep change, no re-index. `memory.context` returns 9 keys instead of 10, `memory.search_prompts` 3 instead of 4, `memory.doctor`'s `db` block 3 instead of 4, `memory.get({ids})` rows gain up to four keys, and five descriptions read differently. No error code changes, no result-set changes, no ordering changes; no argument becomes newly valid or newly invalid; no counter's value moves.

The one behaviour that changes on real data is `memory.get({ids})`, which starts returning review metadata for `active` rows. It is derived from `confirmations` rows and per-type TTLs that already exist, so there is no backfill and no first-run cost beyond one batched lookup per call — the same lookup every `memory.search` already performs.

**Rollback** is a plain image downgrade. An older server republishes the old schemas, re-emits `clamped: false` and `db.open: true`, and stops returning review metadata on batch reads. Nothing persisted differs, so nothing must be undone. The only client this could break is one that hard-requires a removed field; the measured consumer set is zero.

**Verification against pre-existing data** is a standing requirement for anything touching MCP: the Docker smoke runs against an already-seeded volume (not a fresh reset), exercising all six surfaces before and after the upgrade image, including a row that is genuinely `needs_review` so the batch fix is observed on real data rather than a fixture. Encoded in `tasks.md` §11.

## Open Questions

1. **Should a field-rejection counter exist, so `bound-annotation-response-size`'s Open question 2 becomes answerable?** That design left clamp-with-a-receipt reviewable "in case field evidence shows agents hitting the rejection often", but nothing counts `-32602` responses per parameter, so the condition can never be evaluated. Deliberately **not** decided here: observability on the MCP error path is its own change with its own scope (where the counter lives, whether it is per-token, whether the dashboard surfaces it), and building it inside a change whose purpose is deleting dead fields is exactly the scope creep this repo penalises. **Default meanwhile: no counter, question stays closed** — reopening it requires the instrument first.
2. **Should `memory.context`'s description teach `rankedPass`/`gateShortened`?** Deferred here with the line stated in D12 (a true-but-incomplete statement is outside this requirement; a false one is inside it). Default: **its own change**, which should start from the measurement in `tasks.md` 12.3 rather than from the archived "no measured benefit", which that measurement falsifies.
3. **Should the batch form carry `confirmationCount`?** Default: **no, deferred.** No description promises it there, and the cost of a per-row count on a bulk read is a query-shape question for `db-performance-auditor`. Recorded so it is not rediscovered as an inconsistency next to the `replaces` addition, which IS in scope because `:297` was false about it in both directions.
4. **Should `check-delta-freshness` gain an explicit scenario-rename directive?** Under the current script a published scenario title can never be renamed by any change (D9), so this change leaves two titles whose wording contradicts their own bodies. Default, a real cost accepted rather than shrugged off: **no script change here**, because it is a tracked file outside this change's boundary and needs its own tests. Named so the next contributor who wants to rename a scenario finds the reason diagnosed instead of rediscovering it against a red CI job.
5. **Does instance seven belong in this change or its own?** Default: **its own change, citing the requirement this one adds** — the general form means it costs one scenario, while folding it in here would mean re-validating and re-smoking a change already measured. The sweep reports the class closed (every other `z.boolean()`/`z.literal()` under `apps/server/src/mcp/` has both values reachable; every error code named by a description was reached), so there may be no seventh; this question exists so a later finding is not read as a failure of the sweep.
