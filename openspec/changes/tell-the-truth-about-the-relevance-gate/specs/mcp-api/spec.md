# mcp-api — delta

## MODIFIED Requirements

### Requirement: An abstaining search response MUST tell the agent not to invent context

When the text-query branch abstains, the response SHALL carry an explicit flag and a reason, and the tool description SHALL instruct the agent that an abstaining response means no relevant memory exists — not that it should proceed on assumption. An empty result that the model interprets as "search is broken" or fills in from its own priors is worse than a populated one.

Abstention has two causes (see the `memory` capability, "Recall MUST be able to return nothing") and the response SHALL distinguish them: the reason accompanying an abstention caused by an empty fused pool SHALL differ from the reason accompanying the relevance floor's verdict. A single reason string covering both would attribute the verdict to whichever mechanism the string happens to name, and on the shipped configuration that is a mechanism that never ran.

A response that returns no results SHALL NOT be treated as sufficient evidence of abstention, and no tool description SHALL teach that equivalence. An `offset` past the end of a non-empty pool returns an empty page with `abstained: false`, and that is specified behaviour rather than an inconsistency.

Because a page may be shortened by the enabled relevance filter rather than exhausted by the corpus, and because those two states are otherwise byte-identical in the response, `memory.search` SHALL carry an additional flag — `gateShortened` — under the exact condition the `memory` capability defines for it. It SHALL be declared in the tool's `outputSchema` as an OPTIONAL boolean, SHALL be present and `true` only when that condition holds, and SHALL be OMITTED otherwise rather than emitted as `false`, matching the existing conditional fields on the same response (`abstainReason`, `viaEntity`, `entityIndexDraining`). Being additive and optional, it SHALL NOT change the `text` content block's meaning for a client that ignores it, and SHALL NOT be required by any existing client.

The `memory.search` description SHALL state what an abstaining response means and what the shortening flag means, in terms of the OBSERVABLE outcome rather than by naming the mechanism that produced it, so that the description stays true when a gate's enabled state changes. In particular, while the abstention floor is disabled the description SHALL NOT attribute abstention to that floor. This content obligation is bounded by "Tool descriptions MUST stay below the client truncation ceiling" and SHALL be satisfied within the existing cap by replacing text rather than appending it; the cap SHALL NOT be raised to accommodate it.

#### Scenario: An abstaining response is distinguishable from an error

- **WHEN** `memory.search` abstains
- **THEN** the call SHALL succeed with an explicit abstention flag and reason, and SHALL NOT return an error code

#### Scenario: The two abstention causes carry different reasons

- **WHEN** `memory.search` abstains because the fused pool was empty, and the same tool abstains because no pool row reached the floor
- **THEN** the two responses SHALL carry different reason strings, and the floor's string SHALL be unchanged from the one already shipped

#### Scenario: A gate-shortened page is marked as such over the MCP boundary

- **GIVEN** a scope in which the relevance filter removes candidates from the fused pool for a given query
- **WHEN** an MCP client calls `memory.search` with a `limit` larger than the number of surviving rows
- **THEN** the response SHALL carry `gateShortened: true` alongside `abstained: false`
- **AND** the same client calling with an `offset` past the end of a non-empty pool SHALL receive `abstained: false` with no `gateShortened` field

#### Scenario: The shortening flag is absent rather than false

- **WHEN** `memory.search` returns a page the relevance filter did not shorten
- **THEN** the response object SHALL NOT contain a `gateShortened` key
- **AND** the response SHALL still validate against the tool's declared `outputSchema`

#### Scenario: The description steers against confabulation

- **WHEN** the `memory.search` tool description is inspected
- **THEN** it SHALL state that an abstaining response means no relevant memory exists and that the agent SHALL NOT substitute assumed context

#### Scenario: The description does not name a disabled mechanism

- **GIVEN** the abstention floor ships disabled
- **WHEN** a CI test inspects the `memory.search` description obtained from a real `tools/list` response
- **THEN** the description SHALL NOT attribute abstention to the relevance floor
- **AND** the test SHALL fail if that attribution is reintroduced

### Requirement: The four existing memory tools MUST advertise protocol-teaching descriptions

The descriptions of `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` SHALL begin with a "Call this WHEN …" trigger list before documenting the request/response shape. The request and response shapes themselves are unchanged. In addition, the `memory.search` description SHALL advertise that results are ranked by hybrid semantic + keyword relevance (vector similarity combined with FTS5) — so the agent knows paraphrases and cross-lingual queries match, not only exact keywords — and SHALL advertise the result-page affordance: results are a small default page that can be widened by passing a larger `limit` or paged with `offset` when more relevant results are needed. These additions SHALL NOT remove or weaken the recall trigger.

The `memory.search` description SHALL additionally name the shortening flag and say what a short page does and does not imply: that the corpus is not necessarily exhausted. Ranked retrieval returns the best available rows whether or not any of them is relevant, so the description SHALL also state that a full page is not evidence that its rows are relevant. That sentence is the only mitigation available at the description layer for a ranked branch with no absolute relevance threshold, and it is required for the same reason the anti-confabulation instruction is.

Every content obligation in this requirement SHALL be satisfied within `DESCRIPTION_MAX_LENGTH`. Where a new obligation cannot fit, text SHALL be reclaimed from clauses no requirement mandates, and the reclaimed clause SHALL be named in the change that removes it — not appended past the cap, and not paid for by raising the cap.

#### Scenario: `memory.save` description teaches the trigger list

- **WHEN** an MCP client retrieves the tool description for `memory.save` via `tools/list`
- **THEN** the description SHALL contain the substring `Call this IMMEDIATELY after` followed by a list including at least: bug fix, decision, discovery, configuration change, pattern, user preference

#### Scenario: `memory.search` description teaches when to call

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it whenever the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: `memory.search` description advertises hybrid ranking and the widen affordance

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL convey that ranking is hybrid semantic + keyword (so paraphrases / cross-lingual queries match), and SHALL convey that the default result page is small and can be widened via `limit` or paged via `offset`
- **AND** the description SHALL still contain the recall trigger wording from the prior scenario

#### Scenario: `memory.search` description explains a short page and a full one

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL name the shortening flag, SHALL state that a short page does not mean the corpus is exhausted, and SHALL state that a full page is not proof that its rows are relevant

#### Scenario: A reworded description is still within the cap

- **WHEN** the `memory.search` description is changed to satisfy a new content obligation
- **THEN** its `String.length` measured from a real `tools/list` response SHALL remain at or below `DESCRIPTION_MAX_LENGTH`, and the change SHALL record the measured length and the remaining headroom

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected

### Requirement: `memory.context` MUST offer a relevance channel alongside recency

`memory.context` is the tool the protocol directs agents to when starting or resuming work, and its recency channel is ordered by activity alone — nothing about the work at hand influences it. Recency answers "what happened lately", which is not the same question as "what bears on this task", and on a corpus spanning several projects the two answers diverge quickly.

`memory.context` SHALL accept an optional `focus` string and SHALL return a `relevantMemories[]` channel. The existing recency channel SHALL be unchanged and the two SHALL be separately labelled in the response, so the model can tell which rows were selected for relevance and which for recency.

The relevance channel is filled in two passes, in this order. First, an **entity pre-pass**: identifiers recognised in the seed text by the deterministic extractor are looked up as exact addresses, and their linked in-scope memories are admitted first, because an exact identifier match is stronger evidence than any ranked score. Second, if the channel is still under its cap, the scoped hybrid search that backs `memory.search` fills the remainder. Rows are deduped by id across both passes, and each row SHALL carry a `via` field (`'entity'` | `'ranked'`) naming the pass that found it, so the two populations stay distinguishable in the response — the same observability `memory.search`'s entity flag provides.

The ranked pass's verdict SHALL NOT be discarded. Withholding it makes an empty or short relevance channel indistinguishable from a channel the search deliberately declined to fill, which is the same defect on this surface as it is on `memory.search`. The response SHALL therefore carry the ranked pass's abstention flag, its reason when abstaining, and its shortening flag, grouped under a single OPTIONAL response field so that one presence check answers "did the ranked pass run at all". Inside that field the flag names SHALL match `memory.search`'s, so the two surfaces read identically.

That field SHALL be present ONLY when the ranked pass actually executed. Two paths skip it — no derivable seed, and an entity pre-pass that already filled the channel to its cap — and reporting `abstained: false` for a search that never ran would assert a verdict the server never measured. Its shortening flag describes the ranked pass's own page against the limit THAT PASS requested, not the channel's cap: the channel MAY therefore be full while the shortening flag is set, and the requirement is that this be stated rather than that the pass's limit be changed.

When `focus` is absent, the server SHALL derive a seed from signals it already holds for the connection — the active project, the session's working directory, and the most recent curated prompts — so an agent that does not know to pass `focus` still receives relevance. When no seed can be derived, the relevance channel SHALL be empty rather than absent, and the recency channel SHALL still be returned.

#### Scenario: An explicit focus drives the relevance channel

- **WHEN** `memory.context` is called with a `focus` describing the task at hand
- **THEN** `relevantMemories[]` SHALL contain scoped results for that text
- **AND** `recentMemories[]` SHALL be unchanged from what the same call returns without `focus`

#### Scenario: An entity in the seed outranks the ranked pass

- **GIVEN** a memory linked to a file path named in the `focus`, and other memories that rank well for the same text
- **WHEN** `memory.context` is called
- **THEN** the linked memory SHALL be admitted, carrying `via: 'entity'`, before any row carrying `via: 'ranked'`

#### Scenario: The ranked pass fills the remainder

- **GIVEN** a `focus` naming one identifier linked to a single memory, and a cap larger than one
- **WHEN** `memory.context` is called
- **THEN** the remaining slots SHALL be filled by the hybrid search, each row carrying `via: 'ranked'`, with no row repeated across the two passes

#### Scenario: A seed with no identifier still returns relevance

- **GIVEN** a `focus` containing no extractable identifier
- **WHEN** `memory.context` is called
- **THEN** `relevantMemories[]` SHALL be filled entirely by the ranked pass

#### Scenario: The ranked pass reports an empty pool

- **GIVEN** a `focus` for which both retrieval branches return no candidate in scope
- **WHEN** `memory.context` is called
- **THEN** `relevantMemories[]` SHALL be empty and the response SHALL report the ranked pass as abstaining, with the empty-pool reason

#### Scenario: The ranked pass reports a gate-shortened page

- **GIVEN** a `focus` for which the relevance filter removes candidates and leaves fewer rows than the ranked pass requested
- **WHEN** `memory.context` is called
- **THEN** the response SHALL report the ranked pass's shortening flag alongside `abstained: false`

#### Scenario: A skipped ranked pass reports nothing

- **GIVEN** an entity pre-pass that fills the relevance channel to its cap
- **WHEN** `memory.context` is called
- **THEN** the ranked-pass field SHALL be absent from the response, rather than reporting `abstained: false`
- **AND** the same SHALL hold when no seed can be derived

#### Scenario: A seed is derived when focus is omitted

- **GIVEN** a connection with an active project, a session carrying a working directory, and at least one recent curated prompt
- **WHEN** `memory.context` is called with no `focus`
- **THEN** the server SHALL derive a seed from those signals and populate `relevantMemories[]`

#### Scenario: No derivable seed still returns recency

- **GIVEN** a connection with no active session and no recent prompts
- **WHEN** `memory.context` is called with no `focus`
- **THEN** `relevantMemories[]` SHALL be present and empty, and `recentMemories[]` SHALL be returned as today

#### Scenario: The relevance channel respects scope

- **WHEN** `memory.context` is called on a connection scoped to one project and another project contains a strongly-matching memory
- **THEN** that memory SHALL NOT appear in `relevantMemories[]`
