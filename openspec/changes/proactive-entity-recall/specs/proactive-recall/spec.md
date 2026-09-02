## ADDED Requirements

### Requirement: The server MUST extract entities from the prompt and return proactive recall lines via a dedicated hints endpoint

A new lightweight endpoint `POST /api/<slug>/sessions/:id/recall-hints` SHALL accept `{prompt: string}`, extract entities from the first 500 characters of the prompt using the existing `extractEntities()` function, match each entity against the entity index via `repos.entities.findMemoriesByEntity()`, and compose recall lines to return as `{lines: string[]}`.

The endpoint SHALL be synchronous and read-only with respect to persistence: the prompt SHALL NOT be written to any table, index, or log at `info` level or above (debug-level tracing MAY include it for diagnostics). Entity extraction SHALL be scoped to the connection's project via `projectScope()`. This preserves the append-only invariant.

Clients SHALL call this endpoint at turn START, before the model responds, and merge the returned lines into the model's context (via system prompt, nudge parts, or echo, depending on client transport). The model SHALL see entity recall hints from its first token on the topic.

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

#### Scenario: Recall hints are visible from the model's first token

- **GIVEN** a client that calls the recall-hints endpoint with a prompt mentioning entity X
- **WHEN** the model begins generating its response
- **THEN** the entity recall hints for X SHALL be present in the model's context
- **AND** they SHALL NOT appear only after the model's first response token (no one-turn delay)

### Requirement: Entity recall lines MUST be filtered to active-learning memory types

The server SHALL filter entity-matched memories to `type IN ('project', 'feedback', 'procedural')` before composing recall lines. Reference-type memories SHALL NOT be surfaced as proactive recall.

#### Scenario: A file entity matches both a project memory and a reference memory

- **GIVEN** entity `src/auth/handler.ts` linked to one `project` memory and one `reference` memory
- **WHEN** the recall-hints endpoint extracts that entity
- **THEN** the recall line SHALL include the `project` memory's title
- **AND** the recall line SHALL NOT include the `reference` memory's title

### Requirement: Entity recall lines MUST be deduped per session

Each entity SHALL be surfaced at most once per session. The server SHALL maintain a per-session set of entities already recalled (transient, in-memory, same spirit as the session-nudges state); an entity in that set SHALL be skipped on subsequent turns even if the prompt mentions it again.

Sessions without prior dedupe state SHALL get no lines from dedup — the first mention of any entity is surfaced normally.

#### Scenario: The same entity mentioned in two consecutive turns

- **GIVEN** a session where entity `src/auth/handler.ts` was already recalled in turn 3
- **WHEN** turn 7's prompt also mentions `src/auth/handler.ts`
- **THEN** turn 7's response SHALL NOT contain a recall line for that entity
- **AND** turn 7's response SHALL still contain recall lines for any NEW entities in the prompt

#### Scenario: Different entities in the same turn are deduped independently

- **GIVEN** entity `src/auth/handler.ts` was recalled in turn 3
- **WHEN** turn 5's prompt mentions both `src/auth/handler.ts` and `src/utils/cache.ts`
- **THEN** turn 5's response SHALL contain a recall line for `src/utils/cache.ts` only
- **AND** `src/auth/handler.ts` SHALL be skipped

### Requirement: Per-turn entity recall MUST be bounded

The server SHALL return at most 3 entity recall lines per turn. Each line SHALL carry the inline titles of the top-2 matched memories for that entity. The total token cost of all entity recall lines SHALL NOT exceed approximately 200 tokens.

#### Scenario: A prompt mentions five entities

- **WHEN** the recall-hints endpoint receives a prompt mentioning five entities each with multiple matched memories
- **THEN** the response SHALL contain at most 3 entity recall lines
- **AND** each line SHALL carry at most 2 memory titles
- **AND** entities beyond the first 3 SHALL be silently dropped (they will surface on a later turn if the entity set shifts)

### Requirement: Server-side usage counters MUST track tool-call frequency

The server SHALL maintain in-memory counters of tool calls per token for at least `memory.search`, `memory.context`, and `memory.save`. Counters SHALL be incremented on each successful tool invocation and SHALL reset on server restart.

Counters SHALL be exposed on an internal debug surface (e.g. `GET /api/:slug/debug/counters`) requiring admin authorization, or logged at shutdown. They SHALL NOT be exposed on any public or unauthenticated endpoint.

#### Scenario: A session calls memory.search three times

- **WHEN** three successful `memory.search` calls are made by the same token
- **THEN** the counter for that token's `memory.search` calls SHALL be 3

#### Scenario: Counters survive across turns within a session

- **GIVEN** a token whose `memory.search` counter is 2
- **WHEN** the server processes another turn and the same token calls `memory.search` once more
- **THEN** the counter SHALL be 3

#### Scenario: Counters reset on restart

- **GIVEN** a token whose `memory.search` counter is 10
- **WHEN** the server restarts
- **THEN** the counter SHALL be 0

### Requirement: The recall-hints endpoint SHALL be resilient to failure

When the recall-hints endpoint is unreachable, returns an error, or times out, the client SHALL continue normally — the model responds without entity recall hints. Proactive recall is best-effort and SHALL NOT block or delay the model's response.

#### Scenario: Server unreachable

- **GIVEN** a client whose server is unreachable
- **WHEN** the client calls the recall-hints endpoint at turn start
- **THEN** the client SHALL proceed with the model's response (no entity recall hints, no error surfaced to the user)

#### Scenario: Server returns an error

- **GIVEN** a client whose server returns 500 from the recall-hints endpoint
- **WHEN** the client calls the recall-hints endpoint at turn start
- **THEN** the client SHALL proceed with the model's response (no entity recall hints)
