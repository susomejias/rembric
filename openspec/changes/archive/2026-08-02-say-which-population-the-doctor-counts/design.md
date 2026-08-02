## Context

`memory.doctor` and `memory.stats` return counters under colliding names over two different populations. Doctor's are server-wide (all projects + global), sourced from unscoped `admin*` reads in the boot-time closure (`apps/server/src/server/bootstrap.ts:555-563`, whose own comment names the exception). Stats' are resolved against the request context (`apps/server/src/mcp/observability-tools.ts:279-281`) and the payload carries a top-level `scope` field (`:112`). Doctor carries no such field, and a reader does not generalise from the _absence_ of a field in one tool to the semantics of another.

The server-wide semantics are settled and out of scope here. They are specified in three places on current `main`:

- `openspec/specs/data-access/spec.md:46` — "The doctor report is deliberately server-wide — `sessions.active`, the embedding and entity backlogs, the latest consolidation run and the review/pending queue depths are all unscoped by design, so that an operator debugging one project still sees the whole process's health."
- `openspec/specs/memory/spec.md:985` — "The equivalent field in the `memory.doctor` report SHALL be server-wide rather than scope-resolved, deliberately matching the precedent that `memory.doctor`'s `sessions.active` is already server-wide while `memory.stats`'s session counter is scoped"
- `openspec/specs/mcp-api/spec.md:770` — "**AND** `entities.backlog` and `review` SHALL be server-wide, matching `sessions.active`"

Plus a named decision one day before #306 was filed: `openspec/changes/archive/2026-08-01-filter-retired-endpoints-from-pending-queue/design.md:77`, headed "D5 — `memory.doctor` and the dashboard badge stay unfiltered", whose `:83` records the residual verbatim: "an agent that calls both tools can see `doctor.review.pendingJudgments` exceed `stats.pendingJudgmentsTotal` by the retired-endpoint rows".

There is an internal-consistency argument for keeping them server-wide that no spec states: `db.sizeBytes`, `embeddings.backlog`, `entities.backlog` and `consolidation.lastRunAt` **cannot** be scoped — there is one SQLite file and one embedding queue. Scoping only the review counters would produce a report where three fields mean "this project" and four mean "this process", a worse hazard than the one being fixed.

## Goals / Non-Goals

**Goals:**

- A model reading `memory.doctor`'s description knows, before it calls, that the counters cover the whole process and that `memory.stats` is where the scoped numbers live.
- The description stops asserting a block the tool cannot return (`LLM`).
- The description enumerates the blocks it does return, so absence of a field reads as a fault rather than as undocumented surface — the same principle `mcp-api/spec.md:764` already applies to the output contract.
- The obligation is spec-pinned and test-pinned, so a future edit that trims the description for length cannot silently drop it.

**Non-Goals:**

- Re-scoping any doctor counter. Explicitly out; see Context.
- Renaming any payload field (issue #306 option A). Rejected in D2, not deferred.
- Adding any discriminator field to the doctor payload (option B). Rejected in D3.
- Changing any computed value, read, schema, or migration. This change writes two string literals.
- Aligning the dashboard's parallel `collectStats` struct (`bootstrap.ts:580-599`, fields `activeSessions` / `pendingJudgments`). The operator surface is always server-wide, so there is no wire collision there and nothing to disclose.

## Decisions

### D1 — Fix the tool description; that is the model's actual channel

Chosen: rewrite `memory.doctor`'s top-level `description` at `apps/server/src/mcp/server.ts:378` to disclose the population, name the real blocks, and drop the `LLM` claim.

Rationale: the defect is that a reader cannot tell what population the number describes. The description is the only surface the model sees before choosing to call the tool, and it is where every other behavioural steer in this repo lives. The correcting sentence already exists in the codebase as a TypeScript docstring (`apps/server/src/mcp/observability-tools.ts:88`) — the fix is to move a fact from a channel the model cannot read into the one it can.

Approved shape, measured at **391 characters** against `DESCRIPTION_MAX_LENGTH = 1900` (`server.ts:124`):

> Read-only operational diagnostics, SERVER-WIDE (all projects + global): DB/embeddings/entities/consolidation health, `sessions.active`, and review queue depths (`needsReview`, `pendingJudgments`), plus warnings. These counters are NOT scoped — `memory.stats` carries the scoped equivalents (`needsReviewTotal`, `pendingJudgmentsTotal`) and they will differ. Use at session start when behavior seems off.

The exact wording is the implementer's to adjust for length or clarity; the four disclosures the spec delta pins are not.

Note the ordering constraint: `mcp-api/spec.md:1938`'s requirement records that Claude Code's truncation is a **tail cut**, so the last content is lost first. The scope disclosure is therefore placed in the first clause, not appended after the usage hint.

### D2 — Renaming the server-wide payload fields is rejected

Rejected: `sessions.active` → `sessions.activeAllScopes`, `review.needsReview` → `review.needsReviewAllScopes`, `review.pendingJudgments` → some third thing (issue #306 option A).

Four reasons, in order of weight:

1. **Wire-breaking with no negotiation.** `memory.doctor` declares an `outputSchema` and the MCP surface has no version negotiation, so any external client parsing the report breaks. Unknowable from here, and disproportionate for a labelling problem.
2. **The two-axis divergence breaks the uniform suffix — this is #306's own self-correction.** A `*AllScopes` suffix asserts "same counter, wider scope". True for `needsReview`, whose scoped and admin reads both delegate to one private `runCountNeedsReview` and differ only in the scope filter (`apps/server/src/db/repositories/memory-repository.ts:733-745` vs `:999-1011`). True for `sessions.active`. **False for `pendingJudgments`**: `adminCountByStatus('pending')` is a bare `COUNT(*) WHERE status = 'pending'`, while `countPendingInScope` applies both `endpointsInScope` and `endpointsActive` (the latter added by #298). So that counter diverges by scope _and_ by retired-endpoint rows, and would be larger even in a single-project deployment. The divergence is itself specified, `openspec/specs/memory/spec.md:1424`: "the scoped count SHALL be 1 and the server-wide counter SHALL be 4 — the divergence is deliberate". A rename would need two different suffixes, at which point it stops being a naming convention.
3. **Zero in-repo precedent for an unscoped marker on the wire.** `grep -rn "AllScopes\|allScopes\|serverWide\|server_wide" apps/ openspec/ docs/ README.md` → 0 hits, re-verified on current `main`. The repo's existing discipline for unscoped reads is a **source-level grep gate** that deliberately stops before the wire — `openspec/specs/data-access/spec.md:41`: "There is no third, unprefixed category. An aggregate-count method is NOT exempt from the prefixes: the grep gate matches call sites by method-name prefix, so an unscoped read carrying neither prefix is invisible to it". Option A would be inventing a wire convention with one instance.
4. **A rename would be under-covered.** `sessions.active` has **no runtime assertion anywhere** — re-verified: the only three hits in `apps/server/src` are a docstring (`observability-tools.ts:88`) and two comments (`db/repositories/agent-sessions-repository.ts:259`, `services/agent-sessions.ts:595`); `apps/server/src/test/mcp-integration.test.ts:1193` names it in a type cast only. Two doctor stubs are typed as `DoctorReport` and would be caught by `tsc` (`observability-tools.test.ts:196-197`, `unresolvable-slug.test.ts:51-59`), but `session-deleted.test.ts:84-90` is not, and is already missing `entities` and `review`.

Recorded so it is not re-litigated: A and C are not mutually exclusive, and the repo has ruled on the mirror-image case before. `openspec/changes/archive/2026-07-25-fix-audited-defects/design.md:37` treated naming as insufficient on its own — "Renaming it is necessary but not sufficient: the durable fix is that the scoped variant _requires_ a `Scope` argument". No type can carry "this number is server-wide" onto the wire, which is precisely why this change is about the label and not the name.

### D3 — A `scope: 'server-wide'` discriminator is rejected

Rejected: adding `scope: 'server-wide'` to the doctor payload (issue #306 option B).

It is additive and breaks no consumer, which is its only merit. Against it, on #306's own strongest argument: `scope` already exists on three MCP payloads — `memory.stats` (`observability-tools.ts:112`), `memory.context` (`apps/server/src/mcp/memory-tools.ts:449`), `memory.search_prompts` (`apps/server/src/mcp/prompt-tools.ts:70`) — and in all three it means "the scope that resolved for this call", drawing from `global | project:<id>`. A fourth value meaning "this payload ignores scope" overloads an established field name across the whole surface to fix one tool. It also does not help the reader who never inspects the raw payload, which is the reader the description serves.

### D4 — `memory.stats`' description gains the two totals and the inverse pointer

Chosen: also rewrite `server.ts:400`, measured at **242 characters**:

> Read-only counters: `memoriesByStatus`, `memoriesByType`, `sessionsByStatus`, `needsReviewTotal`, `pendingJudgmentsTotal` — all scoped to the active project (or global). `memory.doctor` reports same-named counters server-wide, so its numbers will differ.

This is not cosmetic symmetry, and it is not scope creep. Two concrete reasons:

1. **Doctor's new cross-reference must resolve.** D1's description tells the model "`memory.stats` carries the scoped equivalents (`needsReviewTotal`, `pendingJudgmentsTotal`)". Today `memory.stats`' description enumerates only `memoriesByStatus, memoriesByType, sessionsByStatus`, so a model that follows the pointer finds a tool whose own description never mentions the fields it was sent for. A pointer into silence is worse than no pointer.
2. **Stats' description is independently incomplete.** `statsOutput` (`observability-tools.ts:111-119`) returns six fields; the description names three. That is the same class of defect as doctor's omission of `entities`/`sessions`/`review`, on the tool immediately below it in the same file.

Alternative considered and rejected: leave `memory.stats` alone, on the ground that its description already says "scoped to the active project (or global)" and so is not _wrong_. Rejected because "not wrong" is not the bar when the fix's whole mechanism is a cross-reference between the two descriptions.

Alternative considered and rejected: add a full inverse paragraph mirroring doctor's. Rejected as tail-cut surface for no gain — one clause carries the divergence warning, and the scoped half is the half that already reads correctly.

### D5 — One new `mcp-api` requirement, not a modification of the existing observability requirement

Chosen: add `### Requirement: The observability tool descriptions MUST disclose which population their counters cover` to `openspec/specs/mcp-api/spec.md`, leaving "The MCP server MUST expose two observability tools" (`:762`) untouched.

Rationale: the existing requirement governs the **output contract** ("Both output contracts SHALL enumerate exactly the fields the tools return", `:764`). A description obligation is orthogonal, and the repo already keeps the two apart for `memory.archive`: registration at `:361`, description steer at `:385`. Every other description obligation in the repo also lives in `mcp-api` (`:387`, `:413`, `:667`, `:902`, `:1315`, `:1938`), so this is the consistent home. Modifying `:762` would also require restating its full content for the archive sync, for no benefit.

### D6 — Three capabilities checked and deliberately given no delta

Each was read whole, not grepped:

- **`memory/spec.md:985`** — states the doctor field SHALL be server-wide. Still true and unchanged by this change; the disclosure obligation is about an MCP tool description, whose home is `mcp-api` per D5. No delta.
- **`memory/spec.md:1420-1424`** — the two-axis scenario pinning `scoped 1 / server-wide 4`. This change alters no computed value, so the scenario stays exactly true. No delta. (It is also the evidence for D2's reason 2, so weakening it would be self-defeating.)
- **`data-access/spec.md:46`** — describes the boot closure, its `admin*` prefixes and why the report is server-wide. This change touches neither the closure nor any read. No delta.
- **`mcp-api/spec.md:766-771`, the doctor output scenario** — checked specifically for a stale `llm` reference, since the code's description has one. It does **not**: `:769` already requires "the report SHALL NOT contain an `llm` block". The spec was right and the description drifted away from it, which is the whole shape of this defect. No delta.

## Risks / Trade-offs

- [Risk] A description-content assertion is trivially gameable — a test asserting `desc.length > 0` or a single substring can pass while the disclosure is absent or mangled. → Mitigation: the test asserts each obligation separately (no `llm` anywhere in the string; the server-wide semantics; the literal `memory.stats`; the omitted block names), and `tasks.md` requires a `node scripts/mutate.mjs` run proving the test goes red when each obligation is removed from the description one at a time. A test green on both sides of the change is the default outcome here, not the exception.
- [Trade-off] The description grows from 142 to 391 characters, and every tool description competes for the same model attention budget. → Accepted because it remains 20% of the 1900-character cap, and the alternative — a model that cannot tell a whole-process number from a project one — already cost two readers a wrong conclusion, one of them inside a shipped change's own measurements.
- [Trade-off] The label now carries a guarantee that only prose and a test enforce; nothing in the type system stops the payload and the description from drifting apart again, exactly as they did for `llm`. → Accepted because no type can express "this number is server-wide" on the wire (D2 reason 3), and this is why the obligation is spec-pinned rather than left as a code comment. The test is the enforcement mechanism; the spec requirement is what stops it being deleted as noise.
- [Risk] A future edit trims the description for length and drops the scope clause, reintroducing the defect silently. → Mitigation: the spec delta cross-references `mcp-api`'s truncation requirement with the same instruction that requirement's existing sibling uses at `:668` — "if the clause does not fit, prose SHALL be cut from the description rather than the constant raised" — and the content test fails before the cap test would.
- [Trade-off] `memory.stats` is edited even though it is not the tool #306 reports as defective. → Accepted for the two reasons in D4; the change stays inside the two string literals either way.

## Migration Plan

There is nothing to migrate. No schema change, no migration file, no derived-index invalidation — `memory_fts`, `memory_vec` and the three entity tables are untouched, and no `admin*` or scoped read is modified.

On a populated install (hundreds of memories), the first boot after upgrade does no extra work; clients see the new text on their next `tools/list`. MCP clients cache tool listings per connection, so an already-connected agent keeps the old description until it reconnects — harmless, since the old text is a subset of the truth rather than a contradiction of the new payload.

Rollback is a revert of two string literals with no data consequence in either direction.

## Open Questions

1. **Should `sessions.active` gain a runtime assertion while we are here?** D2 reason 4 established it has none. Adding one is a two-line test and would remove the coverage gap that partly motivates rejecting option A. Left open rather than defaulted because it is coverage work orthogonal to the disclosure obligation, and folding it in muddies what the mutation run proves. If the implementer wants it, it belongs beside the existing `review.*` assertions at `mcp-integration.test.ts:1195-1196` — not in the new description test.
2. **Does any spec requirement need to state that a tool description MUST NOT assert a field the output contract forbids?** The `llm` drift is an instance of a general class: `mcp-api/spec.md:764` governs the output contract's completeness in both directions, but nothing obliges the _description_ to agree with it. A general requirement would catch the next instance rather than this one. Deliberately left open — writing it now would widen a labelling fix into a surface-wide audit, and the audit is the thing that should decide the requirement's wording.

Settled by default rather than parked, so they are not mistaken for open: the dashboard's `collectStats` struct stays as it is (Non-Goals); the exact description wording is the implementer's within the pinned obligations (D1); and `memory.stats` is in scope (D4).
