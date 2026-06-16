## MODIFIED Requirements

### Requirement: The four existing memory tools MUST advertise protocol-teaching descriptions

The descriptions of `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` SHALL begin with a "Call this WHEN …" trigger list before documenting the request/response shape. The request and response shapes themselves are unchanged. In addition, the `memory.search` description SHALL advertise that results are ranked by hybrid semantic + keyword relevance (vector similarity combined with FTS5) — so the agent knows paraphrases and cross-lingual queries match, not only exact keywords — and SHALL advertise the result-page affordance: results are a small default page that can be widened by passing a larger `limit` or paged with `offset` when more relevant results are needed. These additions SHALL NOT remove or weaken the recall trigger.

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

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected
