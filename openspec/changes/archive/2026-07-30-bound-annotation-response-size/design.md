## Context

Three surfaces project a memory's judgment edges into a `relations[]` list, through two
`RelationsService` methods. Since `order-relation-annotations` the per-row bound is
caller-settable and the response bound does not exist:

| surface                    | rows per response | per-row annotations     | worst case |
| -------------------------- | ----------------- | ----------------------- | ---------- |
| `memory.search` rows       | `limit` ≤ 200     | `listForMemories`, ≤ 50 | **10 000** |
| `memory.get` batch (`ids`) | `ids` ≤ 100       | `listForMemories`, ≤ 50 | **5 000**  |
| `memory.get` single (`id`) | 1                 | `listForMemory`, ≤ 50   | 50         |

An annotation is `{kind, targetId, status, judgmentId?, reason?, confidence?}`. `reason` is
agent-supplied text capped at 2 000 chars by `mcp/relations-tools.ts` and emitted verbatim.
Pretty-printed (`JSON.stringify(payload, null, 2)`) one annotation is ~2.1 KB at that cap, so
10 000 is ~20 MB — and `mcp/result.ts::ok()` returns the payload twice, as a `text` block AND as
`structuredContent`, so the transported size is ~2× that. These are arithmetic estimates; task 1
replaces every one of them with a measured figure before any constant is chosen, because a bound
argued from `200 × 50 × 2000` is exactly the reasoning this repo rejects.

Constraints that shape the fix:

- **No MCP input schema may gain an argument** without work across four clients. A server-side
  bound needs none, and that is a deciding factor.
- **Published on the same day, and contradicted by every candidate remedy**: `mcp-api`'s "a value
  above 50 is REJECTED, not clamped", the independent `limit` max of 200, and the obligation that
  the `relations_limit` description teach `min(relationsTotal, 50)`.
- **Append-only.** Stored `reason` text is immutable; any bound is a read projection.
- Services never import from `mcp/`, so `snippet()` (in `mcp/_shared.ts`) is reachable from the
  projection layer but not from `RelationsService`.
- **No response-size guard exists anywhere today.** `ok()` serializes what it is handed;
  `DESCRIPTION_MAX_LENGTH` bounds tool descriptions, not results. This change adds the first one,
  and the scope of what such a guard can honestly bound is D8.

## Goals / Non-Goals

**Goals:**

- The worst-case annotation payload of any legal request SHALL be bounded by named constants, and
  that bound SHALL be measured over real tool invocations rather than derived arithmetically.
- A request that passes nothing new SHALL be byte-identical in count and rejected never.
- A caller that hits the bound SHALL be told, and told the legal trade — no silent clamp.
- The full `reason` SHALL remain reachable (single-id `memory.get`, dashboard).
- No client work: no new argument on any tool input schema.

**Non-Goals:**

- Bounding `content` (D8) — data-derived, remedied by `snippet` / `fields`, unbounded before this
  regression and unrelated to it.
- A general response-size guard over every read (D8) — no measurement supports it, and at the one
  choke point (`ok()`) it can only fail a read the caller has no way to shrink.
- Changing `RELATION_ANNOTATION_MAX`, the per-surface defaults, the annotation ORDER, or
  `relationsTotal`. All published this week, all correct.
- Removing the duplicate payload emission in `ok()` — measured here, decided elsewhere (Open
  question 1).
- Retrieval, ranking, eval metrics, corpora or baselines. The annotation list is not scored.

## Decisions

### D1. Measure first; the constants follow the measurement

Task 1 builds one pathological corpus (≥ 200 active in-scope memories, ≥ 50 judged annotations
each, every `reason` exactly at the 2 000-char schema cap) and measures, per surface, both the
`text` block length and the serialized `structuredContent` length of a real `CallToolResult`:
search at defaults, search at the largest legal request, batch `get` at both, single-id `get`.
The same four surfaces are re-measured after D2 and D3 land, and both sets of numbers are
committed into `tasks.md`.

The estimates in `proposal.md` are a HYPOTHESIS. If measurement contradicts them — for example if
the dominant term turns out to be JSON indentation rather than `reason`, or if the double
emission is not in fact 2× — the constants follow the measurement and the design is amended,
not the reverse. Two things measurement is specifically there to settle: whether bounding
`reason` alone would have sufficed (arithmetic says no: ~1.3 MB of scaffolding survives at
10 000 annotations), and what byte ceiling D4 should assert.

_Alternative._ Choose the constants from the arithmetic above and skip the corpus — rejected: the
arithmetic ignores indentation, key order, the double emission and the `pending` shape (which
carries no `reason` at all but does carry a `judgmentId`), and a wrong estimate would be baked
into a CI ceiling that nobody re-derives.

### D2. Bound `reason` in the multi-row projections only; keep the deep read verbatim

`memory.search` rows and batch `memory.get` project each judged annotation's `reason` through the
existing `snippet()` helper (slice + `…`) at `ANNOTATION_REASON_CHARS`. Single-id `memory.get`
does not.

**Why `reason` is the right field.** It is the only unbounded-ish term in an annotation; the rest
is ~134 bytes of fixed scaffolding. And the surrounding contract already treats the annotation
body as short: the published `mcp-api` requirement describes it as "a short snippet", and every
other multi-item text projection in the MCP surface is already snippeted at
`CONTEXT_SNIPPET_CHARS = 350` (`memory.context` recent memories, prompts, session summaries,
pending judgments). Bounding it is therefore aligning one straggler with a shipped convention,
not inventing a policy.

**Why the split by surface rather than uniformly.** Single-id `memory.get` returns ONE memory;
its exposure is 50 annotations, not 10 000, and it is the deliberate deep read. It is also the
destination the truncation must leave intact, or the bound would make full reasons unreachable
over MCP and force an operator to the dashboard for a fact an agent needs. Conveniently the
split falls exactly on the method boundary: `listForMemories` IS the multi-memory projection and
`listForMemory` IS the single one, so "multi-row" needs no new concept.

**Value: 350, proposed not asserted.** Reusing `CONTEXT_SNIPPET_CHARS`'s number means no new
magic number enters the codebase. Task 1's measurement may show 350 leaves the D4 ceiling above
what a context window can hold, in which case the reason bound is the knob that moves (D3's
budget cannot — it is pinned to shipped behaviour), and the chosen value is recorded with the
measurement that forced it.

**Where the truncation lives.** In the MCP projection layer (`mcp/_shared.ts` helper, applied at
the two multi-row call sites in `memory-tools.ts`), not in `RelationsService`. Services do not
import from `mcp/`, and the per-surface difference is a presentation decision, not a domain one.
The drift risk of two call sites is answered by one shared helper plus an invariant-style test
asserting no multi-row surface can emit an over-long reason.

_Alternatives._ **Truncate inside `listForMemories`** — would need `snippet()` relocated out of
`mcp/` for one caller, and would put a presentation bound in the domain service; revisit only if
a third multi-row consumer appears. **Drop `reason` from multi-row rows entirely** — the reason
is the decision content of a judgment; a `conflicts_with` with no stated reason tells the agent
there is a problem and nothing about it, which is the `entitiesTruncated` mistake in a new place.
**Truncate at write time in `memory.judge`** — forbidden: append-only, and it destroys the
operator-visible record. **Lower the `reason` input cap from 2 000** — narrows future judgments
to fix a read bound, and does nothing for the reasons already stored.

### D3. An aggregate budget of `rows × per-row bound`, pinned to shipped default behaviour

`RELATION_ANNOTATION_RESPONSE_BUDGET` bounds the product for the multi-row surfaces:
`limit × effective relations bound` for `memory.search`, `ids.length × effective relations bound`
for batch `memory.get`. Proposed value **2 000 = 200 × 10**: the `limit` maximum times the
shipped multi-row default.

That derivation is the whole point of the number. It is the worst case the server ALREADY serves
to a caller who passes nothing, so:

- **no default request can ever be rejected** (search 200 × 10 = 2 000 sits exactly at the
  budget; batch 100 × 10 = 1 000 well inside), which is what keeps this change free of a silent
  behaviour change for existing callers;
- **the ceiling introduces no payload regime that is not already shipping** — the same argument
  archived D7 used to pick 50 as the per-row maximum;
- the budget is a TRADE the caller can spend as it likes: `limit: 8 × 50`, `limit: 40 × 50`,
  `limit: 200 × 10`, `ids: 40 × 50`. Every one of those is legal; only the product is bounded.

**Validated pre-query, on the declared parameters.** Legality is a function of the request, never
of how many rows the corpus happens to hold. A post-query check would make the identical request
succeed on a small corpus and fail on a large one — unpredictable for an agent, untestable
without a corpus-size fixture, and impossible to state in a description.

_Alternatives._ **Lower `RELATION_ANNOTATION_MAX` for the multi-row surfaces** (e.g. 50 → 15) —
declarable in zod and therefore client-pre-validatable, which the product rule is not; rejected
because it penalises the common small-`limit` deep ask (`limit: 8` with 50 annotations is 400
annotations, ~1/5 of the budget, and would start erroring) while a caller can still spend the
whole budget at `limit: 200`. It also contradicts the published "single shared value of 50",
which the product rule leaves standing. **A byte budget instead of an annotation budget** — not
knowable before the query, so it could only reject after the work was done or truncate
mid-response; bytes are D4's job, as an assertion over the product of two count bounds.
**An aggregate cap enforced by shedding annotations from some rows** — makes a row's `relations`
depend on the other rows on the page, so two searches differing only in `limit` describe the same
memory differently; that directly contradicts "`relations_limit` bounds a per-row projection
only" and destroys the "prefix of the same ordered sequence" guarantee.

### D4. A named byte ceiling, asserted in CI over a real response

`MCP_ANNOTATION_PAYLOAD_CEILING` (value from task 1) bounds the serialized worst case, and a test
constructs the largest LEGAL request at each of the three surfaces, invokes the real tool through
the MCP integration harness, and asserts the measured size — counting BOTH copies `ok()` emits —
is within it. A change that later raises `limit`, `RELATION_ANNOTATION_MAX`,
`ANNOTATION_REASON_CHARS` or the budget fails this test rather than quietly re-opening the hole.

This is deliberately the shape of the shipped `DESCRIPTION_MAX_LENGTH` requirement: a named
ceiling, measured over a REAL response rather than over constants, and an explicit rule that a
collision is resolved as a decision (fit it, or raise the ceiling and record the re-verified
measurement) rather than by truncation. The alternative — asserting the arithmetic product of the
constants — would pass while the actual serializer disagreed, which is the failure D1 exists to
prevent.

_Alternative._ **A runtime guard in `ok()` that errors when a payload exceeds the ceiling** —
rejected here (D8): at that point the work is done and, on a surface with no projection
parameters, the caller has no way to comply, so a working read becomes a hard failure. The
budget belongs where the caller can still act on it (D3), and CI is where the byte claim belongs.

### D5. Two published inaccuracies are corrected inside the requirements being restated

A MODIFIED requirement must carry its entire text, so re-publishing a sentence known to be wrong
is a decision. Two are corrected:

1. "Each annotation SHALL include the target id and (when judged) a short snippet of the target's
   content" — the projection emits `reason` + `confidence` and has never emitted a content
   snippet. The scenario's `{ kind: 'supersedes', targetId: 'M', snippet }` is corrected the same
   way. Left as-is, this change would be bounding a field the spec does not admit exists.
2. "the response SHALL include the 10 most recent annotations" — since
   `order-relation-annotations` the survivors are the highest-precedence ones (tier, then
   recency, then `judgment_id`). This has contradicted the `memory` capability's ordering
   requirement for a day; restating it verbatim would republish the contradiction.

Both corrections describe SHIPPED behaviour. No new behaviour is claimed by either.

### D6. Rejection over silent clamping, and over clamping-with-a-receipt

An over-budget request fails with `invalid_input` naming both parameters, the budget, and at
least one legal trade. Two candidates were weighed and rejected.

**Silent clamping** (serve `floor(budget / limit)` annotations per row) — the repo's convention
treats a silent behaviour change as worse than an error, and the caller cannot distinguish a
clamped list from a complete one except by comparing against `relationsTotal`, which is the
boolean-truncation-flag problem in a new place. It also contradicts the published "REJECTED, not
clamped" in the requirement it would amend.

**Clamping with a receipt** (clamp, and report the applied bound in the response) — not silent,
and honestly the closest call. Rejected because it splits one parameter into two truths
(requested vs applied) that a caller must reconcile on every read; because the caller only learns
after paying for the round trip it was trying to budget; and because it adds a response field on
every read to describe a situation that the description can teach an agent to avoid entirely.
Recorded as Open question 2 in case field evidence shows agents hitting the rejection often.

**Why rejection is cheap here.** The three levers a rejected caller has — lower `limit`, lower
`relations_limit`, or drill in with single-id `memory.get` — are all available in the same turn,
and the error names them. Contrast the recorded failure this repo already fixed
(`surface-pending-judgment-inventory`): there the DESCRIPTION taught an ask the schema rejected.
So the mitigation is the same one: the `relations_limit` description must state the aggregate
rule, and that obligation is a spec scenario, not a code comment.

### D7. Cross-parameter validation lives in the handler, and is advertised in the description

The MCP SDK takes a zod SHAPE, not a `z.object`, so `.refine()` across two fields cannot be
declared in the input schema. The check therefore runs at the top of the `memory.search` and
`memory.get` handlers, before any query, and returns the standard `invalid_input` error shape.

The cost is that a client cannot pre-validate the combination from the advertised schema — the
honest disadvantage of D3 versus lowering the per-surface maximum. It is mitigated where agents
actually read: `relations_limit`'s description states the budget and the trade, and a test
asserts that text (parameter descriptions do not count against `DESCRIPTION_MAX_LENGTH`, which
measures tool descriptions — verified in `order-relation-annotations` task 3.3).

### D8. What a response-size guard can honestly bound — and what stays out

A response's size has two kinds of term:

- **Schema-derived**: bounded by declared request parameters and constants. The annotation term is
  one — `rows × per-row bound × reason cap` — so it can be bounded before the query, and asserted
  in CI. That is this change.
- **Data-derived**: a function of stored content. `content` has NO maximum at save
  (`z.string().min(1)`, no DB `CHECK` on length), so a 200-row search is unbounded regardless of
  annotations.

A guard at `ok()` would be one line at a single choke point, which is tempting, but it can only
bound the data-derived term by FAILING a read — and on `memory.get` by `id`, or `memory.context`,
the caller has no projection parameter with which to comply, so a legitimately large memory would
become permanently unreadable over MCP. That is a worse outcome than a large response, and it is
not the regression this change was opened for. Unbounded `content` is therefore stated as
out-of-scope with its existing remedies (`snippet`, `fields`, `limit`) and left to a change that
can measure real corpora and design per-surface remedies. Recorded so a future reader does not
read this change as having settled it.

## Risks / Trade-offs

- [Risk] A caller that legitimately used `limit: 200, relations_limit: 50` starts getting an
  error. → Grep says no shipped client sends `relations_limit` at all
  (`grep -r relations_limit apps/plugin/` is empty; task 6.5 re-verifies), the parameter is one
  day old, the error names three legal alternatives, and the budget is derived so that no request
  using DEFAULTS can ever be rejected. Marked **BREAKING** in the proposal.
- [Risk] An agent reads a truncated `reason`, concludes the judgment was shallow, and re-judges
  or contradicts it. → The ellipsis is the shipped `snippet()` marker used by every other MCP
  text projection, the annotation carries `judgmentId`, and single-id `memory.get` returns the
  reason verbatim; the delta spec requires the truncated value to be a PREFIX of the stored one,
  so it can never mislead by rearrangement.
- [Risk] The truncation is mistaken for data loss by an operator comparing before/after. → It is a
  read projection; `memory_relations.reason` is never written, the dashboard shows the full text,
  and rollback restores verbatim reasons with nothing to migrate.
- [Risk] 350 chars proves too generous once measured, so the CI ceiling lands above a usable
  context window. → D1 makes the constant a measurement output, not an input; task 2.1 is
  explicitly allowed to land a smaller value with the measurement that forced it, and D3's budget
  is pinned so the reason cap is the only knob that moves.
- [Risk] The budget check drifts from the constants it enforces (e.g. `limit` max is raised to 500
  later and the product silently re-opens). → D4's CI test constructs the largest LEGAL request
  from the constants themselves, so raising any of them moves the measured worst case and fails
  the ceiling assertion.
- [Risk] The two multi-row call sites diverge, one bounding `reason` and one not. → One shared
  helper, plus a test that asserts every multi-row annotation surface bounds the reason, driven
  from a fixture whose stored reason exceeds the cap.
- [Trade-off] The combination rule is not visible in the advertised input schema, so a client
  cannot pre-validate it. → Accepted (D7): the alternative that IS declarable (a lower multi-row
  maximum) rejects small-`limit` deep asks that cost a twentieth of the budget, and contradicts a
  published maximum this change otherwise leaves untouched.
- [Trade-off] Bounding one field and one product does not make the response size bounded in
  general — `content` remains data-derived and unbounded. → Accepted and stated (D8) rather than
  papered over; claiming a bounded response here would be the overclaim this repo punishes.
- [Trade-off] `memory.search` rows and single-id `memory.get` now describe the same annotation
  with different reason lengths. → Accepted, and specified: ordering, bound semantics and
  `relationsTotal` stay identical across surfaces, only the body is bounded, and the bounded body
  is a prefix. Left unspecified it would contradict the `memory` capability's "two surfaces can
  never describe the same memory's relations differently", which is why that requirement is
  MODIFIED rather than left alone.

## Migration Plan

No migration, no schema change, no derived-index invalidation (`memory_fts`, `memory_vec` and the
three entity tables are untouched and none of their recipes moves), no `EXTRACTOR_VERSION` or
embedding-marker bump. Deploy is a plain image upgrade.

**First boot after upgrade** on a populated database: nothing runs, nothing is rewritten. The
first `memory.search` returns the same rows in the same order with the same annotation counts;
the only observable difference is that a judged annotation whose stored `reason` exceeds
`ANNOTATION_REASON_CHARS` arrives ellipsised on the multi-row surfaces. A caller that had started
sending `relations_limit: 50` with a wide `limit` now receives `invalid_input` instead of a
20 MB result.

**Rollback** is a plain image downgrade and breaks nothing: the older image reads the same
unmodified rows, emits verbatim reasons again, and accepts the over-budget combination again. No
stored data depends on either constant, so there is no forward-only step to undo — which is a
direct consequence of the bound being a read projection rather than a write.

**Existing installations carrying hundreds of memories** need no operator action. The one thing
worth telling an operator is in the risk table above: truncated reasons in search results are a
projection, and `/dashboard/judgments` remains the complete record.

## Open Questions

1. **Should `ok()` stop emitting the payload twice?** The `text` block plus `structuredContent`
   doubles every MCP response, not just this one — the MCP spec makes the text mirror a SHOULD for
   backwards compatibility. _Default: leave it_ — dropping it needs compatibility evidence from
   all four clients and would change every tool's output, which is its own change. Task 1
   measures the exact factor so that change starts with a number.
2. **Is rejection the right answer once agents meet it in the field?** _Default: yes_ (D6). The
   fallback if rejections turn out to be common is clamp-with-a-receipt, which needs a new
   response field and therefore a change; the instrument that would justify it is the rejection
   rate, which is observable in server logs.
3. **Should `ANNOTATION_REASON_CHARS` and `CONTEXT_SNIPPET_CHARS` become one constant?** They are
   the same idea (a short projection of stored text in a multi-item list) with the same proposed
   value, but they live in different layers and one is a context-payload budget while the other is
   an annotation-payload budget. _Default: keep them separate_, declared beside the behaviour each
   governs, per the `memory` capability's constants requirement.
