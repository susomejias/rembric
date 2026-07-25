## ADDED Requirements

### Requirement: `memory.context` MUST offer a relevance channel alongside recency

`memory.context` is the tool the protocol directs agents to when starting or resuming work, and it currently returns memories ordered only by access recency — nothing about the work at hand influences the response. Because the access timestamp advances on every read, that ordering drifts from "recently learned" toward "recently retrieved", which is not what a resuming agent needs.

`memory.context` SHALL accept an optional `focus` string and SHALL return a `relevantMemories[]` channel produced by the same scoped hybrid search that backs `memory.search`. The existing recency channel SHALL be unchanged and the two SHALL be separately labelled in the response, so the model can tell which rows were selected for relevance and which for recency.

When `focus` is absent, the server SHALL derive a seed from signals it already holds for the connection — the active project, the session's working directory, and the most recent curated prompts — so an agent that does not know to pass `focus` still receives relevance. When no seed can be derived, the relevance channel SHALL be empty rather than absent, and the recency channel SHALL still be returned.

#### Scenario: An explicit focus drives the relevance channel

- **WHEN** `memory.context` is called with a `focus` describing the task at hand
- **THEN** `relevantMemories[]` SHALL contain scoped hybrid-search results for that text
- **AND** `recentMemories[]` SHALL be unchanged from what the same call returns without `focus`

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

### Requirement: An abstaining search response MUST tell the agent not to invent context

When the text-query branch abstains, the response SHALL carry an explicit flag and a reason, and the tool description SHALL instruct the agent that an abstaining response means no relevant memory exists — not that it should proceed on assumption. An empty result that the model interprets as "search is broken" or fills in from its own priors is worse than a populated one.

#### Scenario: An abstaining response is distinguishable from an error

- **WHEN** `memory.search` abstains
- **THEN** the call SHALL succeed with an explicit abstention flag and reason, and SHALL NOT return an error code

#### Scenario: The description steers against confabulation

- **WHEN** the `memory.search` tool description is inspected
- **THEN** it SHALL state that an abstaining response means no relevant memory exists and that the agent SHALL NOT substitute assumed context
