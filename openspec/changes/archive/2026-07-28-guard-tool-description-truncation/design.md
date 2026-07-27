## Context

### The verified mechanism

Claude Code 2.1.220 wraps each `tools/list` entry before exposing it to the model. Extracted verbatim from the installed binary — `<claude-home>/versions/2.1.220`, where `<claude-home>` is the per-user Claude Code install directory; ELF, not stripped, so the bundled JS is greppable. Locate the wrapper with `grep -abo 'async prompt(){return U.length>LB' <binary>` and dump ~1,300 bytes preceding the offset (253,553,400 in this build; the offset is build-specific, the pattern is not):

```js
U = R?.tools?.[L.name] ?? L.description ?? "",
W = R?.search_hints?.[L.name] ?? (typeof L._meta?.["anthropic/searchHint"] === "string" ? L._meta["anthropic/searchHint"] : void 0),
q = { ...zar,
  searchHint: W?.replace(/\s+/g," ").trim() || void 0,
  alwaysLoad: e.config.alwaysLoad === !0 || L._meta?.["anthropic/alwaysLoad"] === !0,
  async description(){ return U },
  async prompt(){ return U.length > LB ? ma(U, LB) + "… [truncated]" : U },
  …
  inputJSONSchema: U_o(L.inputSchema, R?.param_descriptions?.[L.name]),
```

with `LB = 2048`. Four facts follow, each load-bearing for a decision below:

1. **The ceiling is 2,048 compared against `String.length`** — UTF-16 code units, not bytes.
2. **`description()` returns `U` untruncated; only `prompt()` truncates.** So a test that reads `tool.description` off a `listTools()` response — which is what `mcp-integration.test.ts` already does for every substring assertion — cannot observe truncation. The existing content assertions would keep passing on a description the model receives cut.
3. **The wrapper has `inputJSONSchema` and no `outputSchema`.** Claude Code drops `outputSchema` entirely, so the 18,388 bytes Rembric spends on it are invisible to the model in this client.
4. **`_meta["anthropic/alwaysLoad"]` and `_meta["anthropic/searchHint"]` are both real levers.** Relevant to the rejected alternatives, not to this change.

`LB` is the same constant the client applies to `InitializeResult.instructions` (`if(p && p.length > LB) f = ma(p,LB) + "… [truncated]"`). So instructions have a real 2,048-char ceiling too, well above the self-imposed 1,000-char cap. That makes two statements in the repo false: the comment at `instructions.ts:39` ("none of the four clients truncates it") and — more seriously — a clause in the **live** requirement at `mcp-api/spec.md:719`: "no consuming client enforces one." See D7: the cap value is right and still binds first, but the factual clause has to be corrected, because this change's own verification is what disproves it.

### Measurements

Reproduced against the live server via `createMcpServer` + an in-memory MCP client issuing `tools/list`:

| Quantity                                          |        Value | Note                                                   |
| ------------------------------------------------- | -----------: | ------------------------------------------------------ |
| Tools registered                                  |           23 | all in `apps/server/src/mcp/server.ts`                 |
| `result.tools` array, wire bytes                  |     48,623 B | full JSON payload                                      |
| `outputSchema`                                    |     18,388 B | **37.8%** — a minority, and dropped by Claude Code     |
| `inputSchema`                                     |     11,363 B |                                                        |
| `annotations`                                     |      2,624 B |                                                        |
| Model-visible `{name, description, input_schema}` |     26,001 B | 53.5% of the wire payload                              |
| Tool-level prose                                  | 13,103 chars |                                                        |
| Per-argument `describe()` prose                   |  4,019 chars |                                                        |
| Prose share of model-visible                      |        66.4% | 17,252 prose bytes / 26,001 B                          |
| Resident under deferral                           |      ~0.7 KB | 23 `mcp__rembric__*` names, newline-joined             |
| Server `instructions` (unscoped)                  |    993 chars | against the self-imposed 1,000 cap — **7 chars spare** |

Per-tool description lengths, descending:

| Tool                     | chars | to 2,048 | to 1,900 |
| ------------------------ | ----: | -------: | -------: |
| `memory.search`          | 1,817 |      231 |   **83** |
| `memory.save`            | 1,172 |      876 |      728 |
| `memory.confirm`         | 1,099 |      949 |      801 |
| `memory.save_prompt`     |   991 |    1,057 |      909 |
| `memory.capture_passive` |   904 |    1,144 |      996 |
| `memory.archive`         |   865 |    1,183 |    1,035 |
| `memory.context`         |   834 |    1,214 |    1,066 |
| … 16 more                | ≤ 673 |   ≥1,375 |   ≥1,227 |

`memory.search`'s tail, measured: the `reviewState`/`needs_review` guidance occupies the last 384 chars, and the `abstained:true` warning the last 142. Growth of **+232 chars** begins cutting the abstention sentence; **+373** removes it whole.

### Current state of enforcement

None. `grep -rn "2048\|DESCRIPTION_MAX\|description.length" apps/server/src/mcp/ apps/server/src/test/` returns nothing. The only comparable pattern is `instructions.test.ts`, which asserts `INSTRUCTIONS_MAX_LENGTH = 1000` over both instruction variants, with the constant's docstring recording that the cap is self-imposed rather than a client limit — half right, and corrected in D7.

## Goals / Non-Goals

**Goals:**

- Fail CI when any tool description exceeds a character cap set below Claude Code's verified 2,048 truncation ceiling.
- Make the cap's _provenance_ legible: derived from an external verified ceiling, unlike the `instructions` cap, which is set for token cost at well under half its own ceiling.
- Force the next change that mandates more description content to make an explicit decision — fit, or raise the cap — instead of discovering the collision in CI without context.

**Non-Goals:**

- **Not a token-budget change.** Rejected outright (D4). No prose is cut, no description shortened, no `outputSchema` trimmed.
- Not a tool-count or tool-clustering change. `mcp-api/spec.md:1553` forbids adding a tool; this adds none and removes none.
- Not a fix for the other three clients' behaviour, which is unverified (Q1).
- **Not a rewrite of the `instructions` cap.** D7 corrects one false factual clause in its requirement and adds one scenario. The cap value, the instruction text, and `instructions.test.ts` are untouched.
- Not a correction of the three wrong "~31 KB" citations in the spec sense — all three sit in archived changes and are corrected here as documentation only (D6).

## Decisions

**D1 — The cap is 1,900 characters.** 2,048 minus a 148-char (7.2%) margin.

A cap set at 2,048 exactly is a cap that gives no warning: it passes at 2,048 and loses content at 2,049. The margin exists so the guard fires on the edit that _approaches_ the ceiling, while the author still has the description open, rather than on the edit that crosses it. 148 chars is roughly one sentence of this codebase's description prose — enough that a normal edit lands inside the warning band instead of jumping it.

The number also has to bind on the tool that matters. At 1,900, `memory.search` has **83 chars (4.4%)** of room. That is deliberately tight. The alternative caps considered:

- **2,048 (the ceiling itself)** — rejected: zero margin, no early warning, and it encodes the ceiling as the target rather than the limit.
- **1,950** — rejected: 133 chars on `memory.search`, enough for the abstention rework to slip through without a decision. The guard would exist but not bind.
- **1,817 (the current maximum, a ratchet)** — rejected: it forbids _any_ growth of `memory.search`, including growth that is well inside the real ceiling and mandated by a spec requirement. A ratchet turns every legitimate description edit into a cap negotiation, which trains people to bump the number reflexively — the exact behaviour that would make the guard worthless.
- **1,900** — chosen. Real margin, and tight enough on the one description that is close to the ceiling.

**D2 — Measure `String.length`, not bytes.** The client compares `U.length`, so the guard must too. The units genuinely differ here: 17,122 chars of prose is 17,252 bytes, because the descriptions use `·`, `⊕`, `—`, `≤` and `∈`. A byte-based guard errs conservatively (it would fire early), but it would be measuring the wrong thing, and anyone reasoning from its output about the real limit would be wrong by whatever the current multi-byte density happens to be. A prior exploration of this area produced figures labelled as bytes that were in fact char counts; chars is the correct unit and the label must match.

**D3 — Assert over `tools/list`, not over the `*_DESCRIPTION` constants.** Only five descriptions are named constants (`SAVE`, `SEARCH`, `GET`, `CONFIRM`, `ARCHIVE`); the other 18 are inline object literals at their `registerTool` call site, one of them a template literal interpolating `SUMMARY_MAX_CHARS`. A constant-based guard would cover 5 of 23 and would silently stop covering a tool the moment someone inlines a description.

`mcp-integration.test.ts` already stands up a real server, connects an MCP client, and calls `client.listTools()` — and already asserts on `description` substrings for `memory.search`, `memory.archive` and `memory.session_summary`. The guard belongs there, iterating every returned tool. This also means the assertion is made against the same string the client's `U` binds to, which is the only thing the 2,048 comparison is applied to.

**Alternative considered:** a unit test importing the constants (mirroring `instructions.test.ts`'s shape more closely). Rejected on coverage, per above. `instructions.test.ts` gets away with the unit shape because `buildInstructions` is a single pure function with two variants; there is no equivalent single entry point for descriptions short of `tools/list`.

**D4 — REJECTED: cut prose to buy headroom.** This is the decision worth recording in full, because it is the one a future reader will re-propose.

_The recoverable amount is small._ Strict duplication — text repeated near-verbatim across descriptions — measures **~420 chars**. Generous duplication, counting anything a determined editor could compress, measures **~1,500 chars**. Against the 17,122-char prose budget that is **2.5–8.9%**; against the 26,001-byte model-visible payload, **0.4–1.6%**; in tokens, roughly **115–410**. That is the entire prize.

_The largest apparent redundancy is redundant by spec design._ The `sessionId` boilerplate — "pass it if you know your current session id — never invent one — to guarantee correct attachment when multiple sessions could be active" — occupies **~1,440 chars** across five tool-level descriptions and their arg-level `describe()`s. It looks like the obvious cut. It is not: `mcp-api/spec.md:786` requires exactly this duplication, and states the reason:

> Each tool's description SHALL mention `sessionId` explicitly (**not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model**) with guidance to pass it only if genuinely known and never invent one.

The spec records that rationale **twice** — again at `:334` for `memory.archive`: "These constraints SHALL NOT be expressed only in the per-argument zod `describe()` (which some clients do not surface to the model) but in the tool's top-level description text." That rationale is sound. It means arg-level and tool-level prose are not two copies of one fact; they are one fact addressed to two client capabilities. Cutting either is a behaviour change for some client, not a compression.

_Cutting would mean amending eight requirements._ Every one of these mandates description **content**:

| Location                      | What it mandates                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `mcp-api/spec.md:191`         | abstention semantics in the description                                                           |
| `mcp-api/spec.md:334`         | `memory.archive` constraints, explicitly _not_ only in `describe()`                               |
| `mcp-api/spec.md:358–360`     | four-tool "Call this WHEN" trigger list + hybrid ranking + widen affordance                       |
| `mcp-api/spec.md:365/370/375` | the testable substring scenarios enforcing the above                                              |
| `mcp-api/spec.md:786`         | `sessionId` in five tools' descriptions, with the not-only-`describe()` rationale                 |
| `mcp-api/spec.md:1173`        | `memory.about` must contain `update` and `upgrade`                                                |
| `mcp-api/spec.md:1563`        | the `entity` argument's description must name the draining flag                                   |
| `mcp-api/spec.md:1653`        | `memory.confirm` must state the refutation channel, its `reason` requirement, and its non-effects |
| `sessions/spec.md:222`        | `memory.session_summary` must document the canonical structure                                    |

_And the claim a cut would rest on is unmeasurable here._ "Cutting prose does not degrade tool selection" is a behavioural claim. `apps/server/src/test/retrieval/` measures retrieval quality **given a query** — recall, nDCG, abstention rates over a fixed corpus. It does not measure whether an agent picks the right tool or fills its arguments correctly. Building that harness would be a larger change than the one it would justify, and the payoff being justified is 115–410 tokens.

So: 2.5–8.9% recoverable, the biggest bloc protected by spec with a sound reason, eight requirements to amend, and no way to verify the result did not make tool selection worse. The bar for cutting is high and correctly so.

**This change's own claim is arithmetic, not behavioural** — "this string is shorter than 1,900 characters" — which is why it needs nothing beyond vitest. That asymmetry is the reason this change is worth doing and the prose cut is not.

**D5 — REJECTED: `_meta["anthropic/alwaysLoad"]`.** The flag is real (verified in the wrapper above) and would pin chosen tools past the client's default deferral. But pinning moves prose **into** resident context: it increases per-turn tokens rather than reducing them. Its only benefit is improved tool selection — the same unmeasurable claim as D4. Rejected on both counts.

**D6 — Documentary correction, no spec amendment.** Three archived changes carry the claim "~31 KB of `tools/list` resident every turn, of which `outputSchema` is the larger half":

- `openspec/changes/archive/2026-07-25-improve-recall-relevance/design.md:14`
- `openspec/changes/archive/2026-07-25-add-entity-index/proposal.md:21`
- `openspec/changes/archive/2026-07-25-add-entity-index/design.md:31`

It is wrong three ways:

1. **31 KB matches neither measurement.** The wire payload is 48.6 KB; the model-visible shape is 26.0 KB.
2. **"of which `outputSchema` is the larger half" is self-contradictory** and false: `outputSchema` is 18,388 B — 37.8% of the wire payload, a minority. (Its _other_ claim, that it "contributes nothing to selection", is right, and stronger than stated: Claude Code drops `outputSchema` from the wrapper entirely.)
3. **"resident every turn" is false in Claude Code**, which defers tool schemas by default. `formatDeferredToolLine` is literally `function Xus(e){return e.name}` — only names are resident, ~0.7 KB for all 23 tools.

All three sit in archived changes, none in a live spec, so nothing needs amending. Recording the correction here is the mitigation: the risk is a future change citing 31 KB as an established repo measurement, and the table in **Context** is what it should cite instead.

**D7 — Correct the `instructions` requirement's factual clause; do not touch the cap.** `mcp-api/spec.md:719` states that the 1,000-char instructions cap "is a self-imposed token budget, NOT a client or protocol limit … and no consuming client enforces one." The first half is right; the last clause is false, by the same binary evidence this change rests on — `LB = 2048` is applied to `getInstructions()` exactly as it is to descriptions.

This is corrected rather than left alone because the alternative is worse than scope creep: the ADDED requirement in this change draws its whole framing from the contrast between an external ceiling and a self-imposed budget, so shipping it alongside an uncorrected `:719` would put two live requirements in direct factual disagreement — the failure mode where the contract silently diverges from reality, discovered by whoever next reads them together.

Scope is held to one clause plus one scenario:

- **The cap stays at 1,000.** It is less than half the ceiling and binds first, so no behaviour, no test and no instruction text changes.
- **A scenario is added** requiring any future raise to stay below the verified ceiling and to record the re-verification. Without it the correction is inert prose; with it, the same fit-or-raise-deliberately discipline the description cap gets applies to instructions. This matters more than it looks: the unscoped variant is at **993 of 1,000 chars**, so the next mandated instruction sentence forces a raise, and the person raising it should learn the real ceiling from the spec rather than assume there is none.
- **The `instructions.ts:39` docstring gets the same one-clause fix**, so code and spec agree.

**Alternatives considered:** (a) leave `:719` alone and note the discrepancy — rejected, per the disagreement above; (b) fold the two caps into one shared "client-limit" requirement — rejected as real scope creep: the two limits govern different fields with different provenance (one derived from the ceiling, one from token cost), and merging them would lose exactly the distinction D1 depends on.

## Risks / Trade-offs

[Trade-off] **83 chars of headroom on `memory.search` will block a legitimate edit.** → Accepted, because that is the mechanism, not a defect. The blocked author gets a red test naming the tool, the cap, and the ceiling it protects, and then makes a decision: reword within budget, or raise the cap with the same margin reasoning as D1. What they do not get is a silently truncated abstention instruction. The spec requirement (see the delta) says explicitly that raising the cap is a legitimate outcome, so the guard does not read as a prohibition.

[Trade-off] **The cap does not bound total prose across tools.** 23 tools at 1,899 chars each would pass. → Accepted: total prose is a token-budget concern, and the token-budget framing was rejected (D4). The per-tool cap is the only thing that maps to the client's per-tool comparison.

[Risk] **The 2,048 figure could change in a future Claude Code release.** → Mitigation: the margin absorbs a small tightening, and the spec requirement records _how_ the number was obtained (the `prompt()` wrapper, the `LB` constant), so re-verification is a targeted binary grep rather than a re-investigation. If a future release lowers `LB` below 1,900, the guard becomes wrong in the permissive direction — which is the same position as having no guard, so the change is never a regression.

[Risk] **The guard could be read as a self-imposed doc-creep policy and bumped reflexively**, the way a ratchet would be (D1). → Mitigation: this is precisely why the constant's comment and the spec requirement must state the provenance — external verified ceiling, not budget — and why the requirement makes the fit-or-raise-deliberately obligation explicit rather than implied.

[Risk] **Only Claude Code's ceiling is verified.** → Mitigation: see Q1. The guard is client-agnostic; nothing about it assumes only one client truncates.

## Migration Plan

Nothing to migrate. No schema change, no migration file, no data touched, no derived data (`memory_fts`, `memory_vec`, the three entity tables) invalidated. The new constant is read only by a test, so runtime behaviour is byte-identical: a `tools/list` response before and after this change is the same bytes.

**First boot after upgrade:** indistinguishable from before.

**Rollback:** delete the test block and the constant. No forward-only step, no state to unwind.

**Existing installations** carrying hundreds of memories are unaffected in every respect — this change does not read or write the database.

## Open Questions

**Q1 — Do Codex CLI, opencode and Hermes defer MCP tool schemas, and do they truncate descriptions?** Unverified, and not resolvable with the tools at hand: Codex CLI is a stripped Rust binary, Hermes is not installed on this box, and opencode's `tool_search` turned out to be its OpenAI Responses-API adapter rather than client-side deferral. If none of them defers, each pays roughly **26 KB / ~7.0k tokens resident every turn**, and the token-budget argument this change rejects becomes real for those clients.

Two things to note before anyone reopens D4 on the strength of that. First, even in that world a prose cut is the wrong lever: `_meta["anthropic/searchHint"]` — short per-tool selection metadata, verified present in the wrapper — would dominate a 115–410-token saving without touching a single spec-mandated sentence. Second, **this change is correct either way**, because a truncation guard is about a client ceiling, not about token cost. Q1 changes nothing about whether 1,900 is the right cap.

Resolving Q1 needs an instrumented proxy in front of `/mcp` capturing what each client actually sends and how it renders what it receives. That is its own change, and it would settle the token question for all four clients at once instead of one binary at a time.

**Q2 — Should the per-argument `describe()` strings be capped too?** They total 4,019 chars across 23 tools and are subject to no verified client ceiling; the client passes `L.inputSchema` through `U_o(…)` with no length comparison in sight. Default: **no cap**, on the grounds that a guard should protect a limit that exists. Revisit only if a client is found to truncate `inputJSONSchema`.
