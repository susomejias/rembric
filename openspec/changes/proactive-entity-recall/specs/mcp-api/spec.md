## MODIFIED Requirements

### Requirement: The four existing memory tools MUST advertise protocol-teaching descriptions

The descriptions of `memory.save`, `memory.search`, `memory.get`, and `memory.confirm` SHALL begin with a "Call this WHEN …" trigger list before documenting the request/response shape. The request and response shapes themselves are unchanged. In addition, the `memory.search` description SHALL advertise that results are ranked by hybrid semantic + keyword relevance (vector similarity combined with FTS5) — so the agent knows paraphrases and cross-lingual queries match, not only exact keywords — and SHALL advertise the result-page affordance: results are a small default page that can be widened by passing a larger `limit` or paged with `offset` when more relevant results are needed. These additions SHALL NOT remove or weaken the recall trigger.

The `memory.search` description's trigger list SHALL include proactive recall moments: before starting work in an area untouched this session, before diagnosing a possibly-known error, and before building something that may already exist. The trigger list SHALL ALSO include the existing reactive triggers (the user referencing past work or asking to recall). The two categories are complementary, not replacements.

The `memory.search` description SHALL additionally name the shortening flag and say what a short page does and does not imply: that the corpus is not necessarily exhausted. Ranked retrieval returns the best available rows whether or not any of them is relevant, so the description SHALL also state that a full page is not evidence that its rows are relevant. That sentence is the only mitigation available at the description layer for a ranked branch with no absolute relevance threshold, and it is required for the same reason the anti-confabulation instruction is.

Every content obligation in this requirement SHALL be satisfied within `DESCRIPTION_MAX_LENGTH`. Where a new obligation cannot fit, text SHALL be reclaimed from clauses no requirement mandates, and the reclaimed clause SHALL be named in the change that removes it — not appended past the cap, and not paid for by raising the cap.

#### Scenario: `memory.save` description teaches the trigger list

- **WHEN** an MCP client retrieves the tool description for `memory.save` via `tools/list`
- **THEN** the description SHALL contain the substring `Call this IMMEDIATELY after` followed by a list including at least: bug fix, decision, discovery, configuration change, pattern, user preference

#### Scenario: `memory.search` description teaches when to call

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it whenever the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: `memory.search` description teaches proactive recall moments

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL contain wording instructing the agent to call it before starting work in an area untouched this session, before diagnosing a possibly-known error, and before building something that may already exist
- **AND** the description SHALL ALSO contain wording instructing the agent to call it when the user references past work or asks to recall ("remember", "recall", "what did we do")

#### Scenario: `memory.search` description advertises hybrid ranking and the widen affordance

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL convey that ranking is hybrid semantic + keyword (so paraphrases / cross-lingual queries match), and SHALL convey that the default result page is small and can be widened via `limit` or paged via `offset`
- **AND** the description SHALL still contain both the proactive and reactive recall trigger wording from the prior scenario

#### Scenario: `memory.search` description explains a short page and a full one

- **WHEN** an MCP client retrieves the tool description for `memory.search`
- **THEN** the description SHALL name the shortening flag, SHALL state that a short page does not mean the corpus is exhausted, and SHALL state that a full page is not proof that its rows are relevant

#### Scenario: A reworded description is still within the cap

- **WHEN** the `memory.search` description is changed to satisfy a new content obligation
- **THEN** its `String.length` measured from a real `tools/list` response SHALL remain at or below `DESCRIPTION_MAX_LENGTH`, and the change SHALL record the measured length and the remaining headroom

#### Scenario: An accidental edit removes the protocol-teaching phrase

- **WHEN** a developer rewrites a tool description in a way that removes the `Call this …` trigger
- **THEN** a CI test SHALL fail asserting the presence of the trigger phrase, and the build SHALL be rejected

## ADDED Requirements

### Requirement: A dedicated recall-hints endpoint MUST extract entities from the prompt and return proactive recall lines synchronously

A new endpoint `POST /api/<slug>/sessions/:id/recall-hints` SHALL accept `{prompt: string}`, extract entities from the first 500 characters of the prompt using the existing `extractEntities()` function, match each entity against the entity index via `repos.entities.findMemoriesByEntity()`, and return `{lines: string[]}`.

The endpoint SHALL be read-only with respect to persistence: the prompt SHALL NOT be written to any table, index, or log at `info` level or above. Entity extraction SHALL be scoped to the connection's project via `projectScope()`.

The endpoint SHALL return an empty `lines` array when the prompt contains no extractable entities or when no matched memories pass the active-learning-type filter (`type IN ('project', 'feedback', 'procedural')`). The endpoint SHALL NOT fail when the session has no prior recall state; it SHALL simply return no lines.

#### Scenario: A prompt mentioning a file entity returns a recall line

- **GIVEN** a session with memories whose entities include the file path `src/auth/handler.ts`
- **WHEN** the recall-hints endpoint receives `prompt: "Fix the login flow in src/auth/handler.ts"`
- **THEN** the response SHALL contain `{lines: [...]}` with at least one line naming the matched memory's title

#### Scenario: A prompt with no entities returns empty lines

- **WHEN** the recall-hints endpoint receives `prompt: "Do it"`
- **THEN** the response SHALL contain `{lines: []}`

#### Scenario: The prompt is never persisted

- **WHEN** the recall-hints endpoint processes a request with a `prompt` field
- **THEN** no row SHALL be inserted into `memory`, `prompts`, `agent_sessions`, `consolidation_ops`, or any other table for the prompt text
- **AND** the prompt SHALL NOT appear in any log output at `info` level or above (debug-level tracing MAY include it for diagnostics)

#### Scenario: The endpoint is optional for clients

- **WHEN** a client does not call the recall-hints endpoint
- **THEN** the turn-report endpoint SHALL continue to function as before (no behavioral change to the turn channel)

#### Scenario: A missing session returns an error

- **WHEN** the recall-hints endpoint receives a session id that does not exist
- **THEN** the server SHALL return an appropriate error status (e.g. 404) and SHALL NOT compose any recall lines
