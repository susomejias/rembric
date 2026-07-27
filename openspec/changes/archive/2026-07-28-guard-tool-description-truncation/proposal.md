## Why

Claude Code truncates every MCP tool description at **2,048 characters**. Verified verbatim in the installed binary (`<claude-home>/versions/2.1.220`, where `<claude-home>` is the per-user Claude Code install directory), in the wrapper that turns a `tools/list` entry into a model-visible tool:

```js
U = R?.tools?.[L.name] ?? L.description ?? ""
async prompt(){ return U.length > LB ? ma(U, LB) + "… [truncated]" : U }   // LB = 2048
```

The comparison is against `String.length` — UTF-16 units, not bytes — and it is a hard tail cut. There is currently **no length enforcement of any kind** on tool descriptions: no `2048`, no `DESCRIPTION_MAX`, no `.description.length` anywhere under `apps/server/src/mcp/` or `apps/server/src/test/`.

Today nothing is at risk. `memory.search` is the longest description at **1,817 chars — 231 chars (11.3%) of headroom**; every other tool has ≥876. Truncation is also not silent: the client appends `… [truncated]`, so the model sees a marker.

The reason to guard anyway is **what sits in the last 231 characters of `memory.search`**. The tail is, in order, the `reviewState`/`needs_review` guidance (last 384 chars) and then the `abstained:true` warning **last** (last 142 chars). So the first thing a tail cut destroys is the spec-mandated abstention instruction — and `mcp-api/spec.md:191` _requires_ that instruction to live in the description:

> the tool description SHALL instruct the agent that an abstaining response means no relevant memory exists — not that it should proceed on assumption. An empty result that the model interprets as "search is broken" or fills in from its own priors is worse than a populated one.

That is not a hypothetical. The active change `openspec/changes/rescore-relevance-abstention/` reworks abstention semantics — adding an over-abstention axis, replacing the two `null` gates with calibrated ones — against a description with 231 chars of headroom. A **+232-char** edit starts eating the abstention sentence; **+373** removes it entirely, and the requirement at `:191` silently stops holding while every substring assertion in `mcp-integration.test.ts` still passes, because those assertions read `tool.description` (which the client returns untruncated) rather than what `prompt()` renders. The failure mode is: the spec says the model is told not to invent context, the model is not told, and nothing goes red.

This change converts that latent path into a CI failure at the exact moment the next change would trip it. It should land before or alongside `rescore-relevance-abstention`.

## What Changes

- **Add a per-tool description character-length guard**, `DESCRIPTION_MAX_LENGTH = 1900`, asserted over every tool returned by `tools/list` — not over the five `*_DESCRIPTION` constants in `server.ts`, because 18 of the 23 descriptions are inline at their registration site and one is a template literal. Asserting on the wire payload catches all 23 and cannot drift from what a client actually receives.
- **Frame it as a truncation guard against a verified external client ceiling, not a token budget.** The existing `INSTRUCTIONS_MAX_LENGTH = 1000` (`apps/server/src/mcp/instructions.ts:46`) is documented as _self-imposed_ — "NOT a client or protocol limit" — and is set for token cost at under half its own ceiling. This cap is derived from the ceiling instead, and the code comment and the spec must say so, or a future reader will treat 1,900 as negotiable doc-creep policy and raise it to make room.
- **Cap at 1,900, not 2,048** — 2,048 minus a 148-char (7.2%) margin. A cap set at the ceiling passes at exactly 2,048 and loses content at 2,049, giving zero warning; the margin makes the guard fire on the edit that _approaches_ the limit. 1,900 leaves `memory.search` 83 chars, which is deliberately tight: the abstention rework has to either fit or raise the cap consciously. That collision is the point, not a side effect.
- **Measure in characters (`String.length`), matching the client.** Not bytes. The two differ here — the same 17,122 chars of prose is 17,252 bytes, because `·`, `⊕`, `—` and `≤` are multi-byte. A byte-based guard would be wrong in the conservative direction and would mislead anyone reasoning about the real limit.
- **Cut no prose.** Rejected, and recorded in `design.md` as the most useful thing this change documents: the recoverable duplication is ~420 chars strict / ~1,500 chars generous (2.5–8.9% of prose, 0.4–1.6% of the model-visible payload), the one structurally redundant bloc is redundant _by spec design_, and cutting would mean amending seven requirements in `mcp-api/spec.md` plus one in `sessions/spec.md`.
- **Do not use `_meta["anthropic/alwaysLoad"]`.** Rejected: it exists in the wrapper (verified), but pinning moves prose _into_ resident context, so it costs tokens rather than saving them. Its only justification is better tool selection, which this repo cannot measure.
- **Correct a wrong figure carried by three archived changes** as a documentary note, not a spec amendment: the "~31 KB of `tools/list` resident every turn, of which `outputSchema` is the larger half" claim at `archive/2026-07-25-improve-recall-relevance/design.md:14`, `archive/2026-07-25-add-entity-index/proposal.md:21` and `.../design.md:31`. All three are archived and none is in a live spec, so nothing needs amending — the risk is a future change re-citing the number as established.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: one ADDED requirement — tool descriptions are bounded by a character cap that guards a verified client truncation ceiling, and a future requirement mandating more description content must fit within the cap or raise it deliberately.
- `mcp-api`: one MODIFIED requirement — "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block" currently asserts that "no consuming client enforces" a length limit on `InitializeResult.instructions`. Verifying the description ceiling disproved that: Claude Code applies the **same** `LB = 2048` truncation to `instructions`. The 1,000-char cap is unchanged and still binds first, but the factual clause is corrected and a scenario added requiring any future raise to stay below the verified ceiling. Correcting it is in scope because leaving it means this change's own design contradicts a live requirement.

## Impact

**Affected specs:** `mcp-api` (one added requirement, one one-clause factual correction). No change to `memory`, `sessions`, or any retrieval spec.

**Affected code:**

- `apps/server/src/mcp/server.ts` — export `DESCRIPTION_MAX_LENGTH = 1900` with a one-line comment recording that 2,048 is the verified client ceiling. No description text changes.
- `apps/server/src/test/mcp-integration.test.ts` — the guard, added to the suite that already calls `client.listTools()` and asserts on description substrings.
- `apps/server/src/mcp/instructions.ts` — the `INSTRUCTIONS_MAX_LENGTH` docstring says "none of the four clients truncates it", which is false for the same reason the spec clause is. One-clause comment fix; the cap value is unchanged.

**No invariant touched.** No new MCP tool (`mcp-api/spec.md:1553` forbids adding one; this adds none). No migration, no schema change, no data touched. Zero runtime behaviour change: the constant is read only by a test.

**Existing installations:** nothing to do. No migration, no first-boot work, no derived data to invalidate (`memory_fts`, `memory_vec`, the three entity tables are untouched). Rollback is deleting a test and a constant. A deployed server on an older build serves byte-identical descriptions.

**Four-client implications: none.** Confirmed by grep — no file under `apps/plugin/` contains any description prose. Plugin files reference tool _names_ only; descriptions are server-side and single-copy in `apps/server/src/mcp/server.ts`. The truncation ceiling verified here is Claude Code's; whether the other three clients truncate is unverified and recorded as an open question, but the guard is client-agnostic and correct regardless (see `design.md` Q1).
