## Why

`memory.doctor` returns three counters that are SERVER-WIDE (all projects + global) whose names collide with `memory.stats`' SCOPED equivalents — `sessions.active` vs `sessionsByStatus.active`, `review.needsReview` vs `needsReviewTotal`, `review.pendingJudgments` vs `pendingJudgmentsTotal`. Nothing the model can see distinguishes the two populations. The server-wide semantics are deliberate, specified in three places, and re-affirmed one day before issue #306 was filed; this change does **not** touch them. It fixes the label.

The knowledge is already in the repo — in the wrong channel. `apps/server/src/mcp/observability-tools.ts:88` carries exactly the right sentence:

```
/** Server-wide (unscoped) queue-depth signals — same precedent as `sessions.active`; `memory.stats` carries the scoped equivalents. */
```

That is a TypeScript docstring. It never reaches the wire, and the model's actual channel — the top-level tool description — says nothing about scope at all.

**Two independent readers, both familiar with the codebase, misread the number:**

1. The author of `surface-pending-judgment-inventory` read a cross-scope number as a scoped backlog _while writing the change_, recorded in that change's own measurements (`openspec/changes/archive/2026-07-28-surface-pending-judgment-inventory/measurements/before.md:23`, §0.2 heading verbatim: "`countPendingInScope` does NOT equal what the doctor reports"). It contaminated the bug report that motivated the change.
2. A judgment-queue drain on 2026-08-02: after closing every pending pair in the `rembric` scope, `memory.context` and `memory.stats` both read `pendingJudgmentsTotal: 0` while `memory.doctor` read `pendingJudgments: 60`. From a path-scoped MCP connection there is no way to attribute the 60, so the verification had to be abandoned as explicitly incomplete rather than concluded. The harm is not that the number is server-wide — it is that a reader **cannot tell which population it describes** without reading the source.

**The description is also factually wrong today.** It advertises `LLM` health (`apps/server/src/mcp/server.ts:378`):

> `'Read-only operational diagnostics. Returns DB/LLM/embeddings/consolidation health plus warnings. Use at session start when behavior seems off.'`

There is no `llm` block. `openspec/specs/mcp-api/spec.md:769` requires "the report SHALL NOT contain an `llm` block", `apps/server/src/test/mcp-integration.test.ts:1192` asserts `expect('llm' in payload).toBe(false)`, and the block was removed by `archive/2026-06-05-remove-llm-consolidation`. A model-visible description promising a field the tool cannot return is a defect worth fixing on its own merits. The same description omits `entities`, `sessions` and `review` — three of the seven blocks it returns.

Cost is near zero: the description is **142 characters** against `DESCRIPTION_MAX_LENGTH = 1900` (`apps/server/src/mcp/server.ts:124`).

## What Changes

- **`memory.doctor`'s top-level tool description is rewritten** to (a) drop the false `LLM` claim, (b) name the blocks it actually returns including `entities`, `sessions.active` and `review`, and (c) state that its counters are server-wide across all projects + global, that `memory.stats` carries the scoped equivalents, and that the two **will** differ. Measured at **391 characters** against the 1900 cap.
- **`memory.stats`' description gains the two totals it already returns and the inverse pointer.** Not cosmetic symmetry: `statsOutput` (`apps/server/src/mcp/observability-tools.ts:111-119`) returns `needsReviewTotal` and `pendingJudgmentsTotal`, but the description (`server.ts:400`) enumerates only `memoriesByStatus, memoriesByType, sessionsByStatus`. Without this, doctor's new "`memory.stats` carries the scoped equivalents" points at a tool whose own description never mentions them — a cross-reference that does not resolve. Measured at **242 characters**.
- **It lands in the top-level description, NOT a zod `.describe()`.** `openspec/specs/mcp-api/spec.md:387` verbatim: "These constraints SHALL NOT be expressed only in the per-argument zod `describe()` (which some clients do not surface to the model) but in the tool's top-level description text", and again at `:902`: "not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model". Consistent with the code: no `*Output` schema in `apps/server/src/mcp/` uses `.describe()` at all.
- **Renaming the payload fields is rejected, not deferred.** Issue #306's option A (`sessions.activeAllScopes` etc.) is out: `memory.doctor` has a declared `outputSchema` and there is no version negotiation, so a rename is wire-breaking for any external client for what is a labelling problem. See design D2 for the full argument, including the two-axis divergence that breaks the uniform suffix.
- **A `scope: 'server-wide'` discriminator is rejected.** Issue #306's option B is out on the issue's own strongest argument: `scope` already exists on three MCP payloads and everywhere means "the scope that resolved for this call". See design D3.
- **No computed value changes and no payload shape changes.** No field is added, removed or renamed; `DoctorReport` (`observability-tools.ts:81-91`) and `doctorOutput` (`:93-109`) keep their field names exactly. Not **BREAKING**.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: adds one requirement — the two observability tools' descriptions MUST disclose which population their counters cover. This is a new model-visible obligation, so it needs a requirement rather than only a code task. It sits beside the existing "The MCP server MUST expose two observability tools" (`openspec/specs/mcp-api/spec.md:762`) rather than modifying it, matching how `memory.archive` already carries a separate description requirement (`:385`) alongside its registration requirement (`:361`).

Three capabilities were checked and deliberately get **no** delta — see design D4 for each rejection:

- `memory` (`spec.md:985` and the scenario at `:1420-1424`)
- `data-access` (`spec.md:46`)
- the existing `mcp-api` doctor output scenario (`spec.md:766-771`)

## Impact

Durable invariants touched: **none**. Append-only is untouched (no row written), scope-at-service is untouched (no read changes — the boot closure at `apps/server/src/server/bootstrap.ts:555-563` and its `admin*` reads are left exactly as they are), `topic_key` convergence, derived-review-state and fresh-context judgment are all unaffected. No SQL changes, so the data-access confinement gate is not in play.

Code — two string literals:

- `apps/server/src/mcp/server.ts:378` — `memory.doctor`'s `description`.
- `apps/server/src/mcp/server.ts:400` — `memory.stats`' `description`.

Nothing else in `apps/server/src/` changes. `DoctorReport`, `doctorOutput`, `statsOutput`, `handleDoctor`, `handleStats` and `buildDoctorReportFactory` are all untouched.

Tests: a new description-content assertion in `apps/server/src/test/mcp-integration.test.ts`, alongside the four existing description-content tests that establish the pattern (`:175` search, `:193` archive, `:214` session_summary, `:230` context). The `DESCRIPTION_MAX_LENGTH` guard at `:307-329` already covers both new strings automatically, since it derives from a live `tools/list` response over every registered tool.

Migration: **none**. No schema change, no derived-index invalidation (`memory_fts`, `memory_vec` and the three entity tables are untouched), no first-boot work. A populated install sees new description text on its next `tools/list` and nothing else. Rollback is a string revert with no data consequence.

Blast radius, re-verified on current `main`:

- `apps/plugin/` (all four clients): **no client reads any doctor field.** Correcting issue #306, which claims "zero hits" — `grep -rn "pendingJudgments\|needsReview\|sessions\.active\|doctor\|DoctorReport" apps/plugin/` returns exactly one hit, `apps/plugin/commands/context.md:7`, and it names `needsReview[]` / `pendingJudgments[]` as `memory.context`'s **arrays**, not the doctor's counters. The conclusion holds; the count does not. No hook, bridge, opencode plugin, Hermes provider or install script is affected, so this is not a plugin change and does not touch the shared-resource-single-copy rule.
- `grep -rn "AllScopes\|allScopes\|serverWide\|server_wide" apps/ openspec/ docs/ README.md` → **0 hits**, re-verified. There is no in-repo precedent for an unscoped marker on a payload field, in either direction; option A would be establishing one.
- No HTTP `/api` route exposes the doctor report. The dashboard does not read it (it has a parallel struct, `collectStats`, `bootstrap.ts:580-599`), and the operator surface is always server-wide, so no dashboard or design-token change is implied.
- Docs name `memory.doctor` without naming these fields (`docs/backup.md`, `docs/troubleshooting.md`, `docs/embeddings.md`, `README.md`) — no doc edit needed for a description-only change.

Closes #306.
