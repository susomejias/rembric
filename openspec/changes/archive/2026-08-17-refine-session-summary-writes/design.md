## Context

`memory.session_summary` stores what it is given. The six canonical `##` headings are instructional text with no parser behind them: the only content preconditions on the write path are non-empty, no `NUL`, and `assertSummaryWithinCap` (`apps/server/src/services/agent-sessions.ts:75`, called at `:339` and `:386`). Everything that mutates `sessions.summary` reaches the column through `precedenceSet` (`:792-804`) and `updateAndVersion` (`:298-321`).

That is enough to lose a session. The measurement in `proposal.md` — 16 curated versions, five non-cumulative `## Goal` lines across v12–v16, five concrete anchors present in v14 and absent from v15 — is what a full-document rewrite from a compacted context window produces. The model is not misbehaving: it is being asked to retype a document it cannot see, and omission is punished with deletion.

The constraint that shapes the whole design is that this must be fixed **without** parsing for the six canonical names, without new storage, and without moving any of the three published text budgets that are already within 3% of their caps (`summary` nudge 374/400 bytes, `postCompact` 675/700, `initialize.instructions` 978/1000 — all measured on this tree).

## Goals / Non-Goals

**Goals:**

- An absent `##` section means "unchanged", so a curated write can be partial.
- No input can silently delete a stored section: the one unmatched shape is refused, and an over-cap merge is refused rather than truncated.
- The cap remains exactly enforced now that the stored value is no longer the argument.
- The model-facing text asks for a refinement, discourages `title`, and fits inside the caps that already exist.

**Non-Goals:**

- Format enforcement. The server still never requires the six canonical headings, and a session with no sectioned summary can still store free-form text.
- Nudge text, nudge cadence, and every published nudge byte budget.
- `session_summary_versions`. A later change retires it; nothing here touches the table, and no argument below rests on its existence.
- Any client-side change: no protocol field, no HTTP contract change, no per-client behaviour.
- Any LLM, any similarity check, any accumulation metric.

## Decisions

### D1. The merge is computed at `precedenceSet`, the single existing precedence site

`precedenceSet` already decides the exact value that enters the update `set`, and `sessions` publishes that single-site property normatively ("**One site.** The append SHALL be emitted from the same single place that folds per-field `final` precedence into an update `set`"). Putting the merge anywhere else creates a second place where the three write paths can disagree about what was stored.

Consequence: `precedenceSet` gains the ability to throw `DomainError('invalid_input', …)`, which it cannot do today. That is acceptable at the service layer and is cheaper than the alternatives — computing the merge in `writeSummary` and `end` separately (two sites, the defect the published requirement forbids), or in `updateAndVersion` (too late: the cap check must precede the update, and the transaction is not where a validation verdict belongs).

The section parse and merge themselves are a **pure function in a dedicated module** (`apps/server/src/services/summary-sections.ts`, co-located test), not a method on the service. No SQL, no row access, no clock.

### D2. Only a curated write against a curated stored value merges

The merge applies when **all three** hold:

1. the incoming write carries `final: true` and a `summary`,
2. the stored row has `summary_final = 1` and a non-null `summary`,
3. precedence says the incoming value will actually be stored.

Anything else replaces, exactly as today. Each condition earns its place:

- **(1)** excludes the per-turn raw transcript sync every client performs (`final: false` — verified: `apps/plugin/bin/rembric-plugin-core.mjs:277`, `apps/plugin/.hermes-plugin/__init__.py:572,613,640-643`, and `final:false` in `scripts/{stop-sync,session-end,pre-compact,post-compaction}.sh`; no shipped client sends `final: true` over HTTP). Merging transcript chunks would be nonsense.
- **(2)** means the FIRST curated write over a raw transcript still replaces it outright. A raw body is not a handoff, and a transcript that happens to contain a `## ` line must not become a section a curated write then has to maintain forever.
- **(3)** keeps the terminal-row path behaviourally unchanged. `writeTerminalFields` (`:257-278`) discards an incoming summary when `existing.summaryFinal` is already true — first-curated-value-stands on a closed row. If the merge ran before that discard, a late heading-less or over-cap write would start throwing `invalid_input` where today it is a silent no-op. The merge is therefore attempted only for a value that will be stored.

### D3. A section is a level-2 ATX heading; the key is case-folded; fences are respected

A section starts at a line matching `^##[ \t]+(.+?)[ \t]*$` — exactly two `#`. `###` and deeper are body text belonging to the enclosing section, which is what a model writing `### Sub-decision` under `## Decisions+why` means. The match key is the captured text trimmed and lower-cased, so `## files` updates `## Files` instead of appending a near-duplicate the model then has to reconcile; the heading LINE written to the merged document is the one from whichever side supplied that section, so the model's own capitalisation survives when it supplies the section.

Lines inside a fenced code block (a triple-backtick or `~~~` fence, CommonMark open/close) are never headings. Summaries carry diffs and shell snippets under `## Files`, and a heading-shaped line inside a fence would otherwise split a code block into two sections and let a later partial write rearrange its halves. Line splitting recognises `\n` and `\r\n`; the merged output reuses the source lines verbatim and reflows nothing.

### D4. Shared headings keep the STORED order; write-only headings are appended

The merged document is: every heading present in the stored value, in stored order, each taking the write's body when the write supplied it; then every heading only the write carries, in the write's order. When nothing is stored, the write's own order is the document.

Rejected: ordering by the write. A two-section partial write would hoist those two sections to the top of the document, and the head of the summary is exactly the part `memory.context` shows (`CONTEXT_SNIPPET_CHARS = 350`, `apps/server/src/mcp/memory-tools.ts:1225`, applied head-keeping). Stable order is what makes "current first" survive a partial write.

Accepted consequence: a full rewrite cannot REORDER an existing document — the stored order wins for headings present on both sides. Since the canonical order is fixed by `sessions` and never varies, there is no legitimate reorder to lose.

### D5. A document that repeats a heading has those sections concatenated, in document order, at the first occurrence

Needed for determinism, because either side may already be malformed. Concatenation never discards text; "last occurrence wins" would, and rejecting the write would punish the model for the stored value's shape. The normalisation is observable only on a document that already violates the canonical structure.

### D6. Text before the first heading is a section with an empty key

Uniform rule, no special case: a write that carries a preamble replaces the stored preamble; a write that carries none keeps it. Combined with D7, the only write that is _nothing but_ preamble is the rejected one.

### D7. A heading-less curated write against a sectioned stored value is refused

Zero `##` headings in the write and at least one in the stored value is the single input the matching rule cannot interpret. Accepting it means replacing a six-section handoff with one paragraph — the exact deletion this change exists to stop. Treating it as a preamble-only merge (D6 taken literally) is worse: it would leave a fresh paragraph sitting above six sections the model no longer believes exist, and nothing would ever tell it.

This is a _matching_ rule, not a format validator: it never names `Goal`, never counts to six, and never fires on a session whose stored summary has no headings. That it also closes the flat-paragraph regression path is a side effect worth having, not the justification.

### D8. An empty section body is stored as an empty section; there is no delete verb

`## Unfinished+why` with nothing under it stores an empty section — the heading stays. The alternative (empty body removes the heading) is a hidden second verb reachable by accident: a truncated or malformed write would start deleting. The model empties a section by writing an explicit short value (`none`), which is also the honest artefact for a reader: "nothing unfinished" is information, an absent heading is not.

### D9. Two cap checks, and the merged one refuses rather than truncates

- **Check 1 — the argument**, unchanged, at `assertSummaryWithinCap` in `writeSummary`/`end`, before the row is read. `sessions` publishes this position normatively (before the `summary_final` precedence rule and before `status` is consulted), and it also keeps a pathological argument from being parsed at all.
- **Check 2 — the merged document**, immediately before it enters the update `set`. Same constant, same `invalid_input` code. This is the one that binds now, because after D1 the stored value is a function of two inputs.

`2026-08-13-session-summary-full-rewrite` chose one check on purpose and said what it would take to change that (`proposal.md:15`): _"Once the stored value is not the argument, one cap check stops being enough"_ — with the measurement, 10 350 characters stored against a 10 000 cap, `ok: true`. This change accepts that bill knowingly, and pays it with a second check rather than by weakening the cap.

**Refuse, never truncate.** `truncateSummary` (`:52-68`) keeps the TAIL and prefixes a marker — correct for a raw transcript, catastrophic for a sectioned document, where it would eat `## Goal` first. The error message names the merged length, the cap, and the two actions that resolve it: read the stored summary (`memory.session_get`) and resend condensed sections. **No wedge exists**: a write carrying all six headings replaces the entire document, so a condensed full rewrite always fits under the cap regardless of how large the stored value is.

The HTTP layer's truncate-instead-of-reject behaviour (hook scripts cannot retry) is untouched: it truncates the incoming body before the service call, and no shipped client sends `final: true` over HTTP, so no hook can reach a merged-overflow rejection.

### D10. The refinement rule is a SECOND constant; `SUMMARY_SECTIONS` does not move

`SUMMARY_SECTIONS` (196 chars) is interpolated or byte-copied into all eight surfaces pinned by `invariants.test.ts::"the session-summary rubric has one source"`, three of which are within 26 bytes of a published cap. Growing it would force a bash/Python/Markdown edit per surface plus a re-measurement of the per-line and per-firing-turn budgets in `claude-code-plugin` — for a rule two surfaces need.

So `summary-rubric.ts` exports a second constant carrying one canonical sentence ("the `##` sections you send replace; the ones you omit stay", or wording of that length), consumed by `instructions.ts::BASE` and by the `memory.session_summary` description, with a test asserting both carry it. The rubric file stays the one source; it now defines two things.

Measured budget, on this tree:

| surface                              | today       | with the change                           |
| ------------------------------------ | ----------- | ----------------------------------------- |
| `memory.session_summary` description | 1295 / 1900 | 1683 / 1900 (drafted)                     |
| `initialize.instructions`, unscoped  | 978 / 1000  | 978 / 1000 (56-char rule, preamble 67→38) |
| `initialize.instructions`, scoped    | 961 / 1000  | tracks the unscoped variant               |

The instructions cap is **not** raised. `mcp-api` already forbids raising it for the canonical directive and requires reclaiming prose instead; the reclaim here is the block's opening line, which carries no published obligation (the five obligations are the SAVE flow, the RECALL flow, the session-close flow, the `memory.about` pointer and the `sessionId` clause — all retained). Recorded so the applier does not rediscover it: the title guidance does NOT fit in the instructions block (measured 1039/1000 with it) and therefore lives in the tool description alone.

### D11. `title` gets text, not a lock

The failure is that `title` sits in the tool's signature, so a model supplies one on every write unless told not to; that is how a 16-hour session came to be called `Release-generated MCP manifest CI fixed`. The remedy is the tool description saying to send it on the first write or on a real change of direction and to omit it otherwise. No code: `title` is already optional and `precedenceSet` already preserves it when absent — the mechanism this change extends to the body.

Rejected: locking `title` after the first curated write. A session that genuinely changes direction must be able to retitle, and a first-write lock would freeze the placeholder title (`computePlaceholderTitle`, `:813`) on any session whose first curated write omits one.

### D12. The nudge and command surfaces are not rewritten in this change

They tell the model to send the session's CURRENT COMPLETE state. Under section-wise merge a complete document replaces every section, so the outcome they describe is the outcome they produce — they under-teach, they do not mislead about what they ask for. Rewriting them means moving `postCompact` (675/700 bytes), `endOfTurnRubric`, `commands/summary.md` and the opencode handler that is byte-identical to `postCompactCore`, i.e. four of the surfaces the nudge change owns, plus their published budgets. Deferred to that change, and named here so it is not lost.

Two published sentences go imprecise as a result, and they are named rather than left to be discovered: `openspec/specs/plugin-session-protocol/spec.md:720` justifies its obligation with "so sending the window alone stores the window alone", which after this change is true only of a window that carries no `##` heading; and `opencode-plugin/spec.md:309` argues from the same fixture text. Neither obligation is contradicted — both require a surface to SAY something, and the surfaces still say it — so neither requirement is modified here. Their rationales are the nudge change's to correct when it rewrites the text they describe.

## Risks / Trade-offs

- **[Risk] Omission now preserves STALENESS.** A section the model stops maintaining survives forever instead of disappearing. → Mitigation: "condense, never delete" plus the explicit `none` escape hatch are contract text in the tool description, not style advice; and a stale section is visible, which a deleted one never was. Accepted as strictly better than the current failure, where the same model behaviour destroys the section instead.
- **[Trade-off] Two cap checks where the archive published exactly one.** → Accepted because the property that justified one check (stored value == argument) is precisely what this change spends; the alternative is the measured 10 350-against-10 000 outcome.
- **[Risk] A model that never reads the tool description keeps sending whole documents.** → No regression: identical stored result, plus protection against the sections it forgets. The change is fail-safe by construction, which is why D12's deferral is tolerable.
- **[Risk] The merged-overflow rejection could loop a model that cannot see the stored text.** → Mitigation: the error names `memory.session_get` and the condense action, and a full six-heading rewrite always fits (D9). Verified by a scenario, not by assumption.
- **[Risk] A `## ` line inside a fenced code block is read as a heading, splitting a code block.** → Mitigation: fence-aware parsing (D3) with a test that puts `## Goal` inside a fence in the `## Files` section and asserts it stays body text.
- **[Risk] `precedenceSet` becomes throwing, and a caller that treats it as total breaks.** → Mitigation: it has exactly three call sites (`:260`, `:369`, `:420`), all inside `writeSummary`/`end`/`writeTerminalFields`, all of which already propagate `DomainError`; D2(3) keeps the terminal path from ever reaching the throw.
- **[Risk] The Hermes byte-identity mirror is missed when `BASE` changes.** → Mitigation: `apps/plugin/.hermes-plugin/tests/test_system_prompt_block.py` fails on drift; running the Python test is an explicit task, because a TypeScript-only test run will not catch it.

## Migration Plan

No schema change, no migration, no backfill, no derived-data invalidation. The first boot after upgrade behaves as before for every session whose stored summary has no `##` headings, and merges for the rest. Rollback to a pre-change image restores whole-document replacement; every stored value stays ordinary Markdown in the same column, so nothing becomes unreadable in either direction.

## Open Questions

- **Should the merged-overflow error report per-section character counts?** Default taken: no — the message names the total, the cap and the action, and a model that needs the breakdown can read the stored summary. Revisit only if a real session is observed failing the retry.
- **Should the six canonical headings become mandatory on the FIRST curated write?** Now that a heading means something to the server, format enforcement is finally cheap to justify — but it would reject free-form storage, which `sessions` currently guarantees. Deliberately left to a later change with its own evidence.
