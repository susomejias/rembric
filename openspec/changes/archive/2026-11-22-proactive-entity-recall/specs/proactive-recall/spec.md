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

### Requirement: Entity recall lines MUST be filtered to active-learning memory types, and filtered before the row limit

The server SHALL filter entity-matched memories to `type IN ('project', 'feedback', 'procedural')` before composing recall lines. Reference-type memories SHALL NOT be surfaced as proactive recall.

**The filter SHALL be applied as a query predicate, not to an already-bounded page.** The entity lookup bounds its result with a row limit, so filtering afterwards makes the limit mean "the newest N rows of any type, minus the ineligible ones" — which returns nothing whenever the newest N happen to be ineligible, even though the entity has an eligible memory immediately behind them. The admitted type set SHALL therefore reach the query, so the limit bounds rows that already passed the filter.

The server SHALL additionally read only `status = 'active'` rows on this path. The entity lookup's own default admits `superseded`, which is correct where a topic's history is the point and wrong for a hint: a `topic_key` supersede exists to make exactly one row the current take, so surfacing a superseded row beside its successor gives the model two answers and no way to tell which is live.

#### Scenario: A file entity matches both a project memory and a reference memory

- **GIVEN** entity `src/auth/handler.ts` linked to one `project` memory and one `reference` memory
- **WHEN** the recall-hints endpoint extracts that entity
- **THEN** the recall line SHALL include the `project` memory's title
- **AND** the recall line SHALL NOT include the `reference` memory's title

#### Scenario: An eligible memory older than the newest matches still surfaces

- **GIVEN** entity `config/deploy.yaml` linked to one `project` memory and to two `reference` memories, both created AFTER the project memory
- **WHEN** the recall-hints endpoint extracts that entity
- **THEN** the response SHALL contain a line naming the `project` memory's title
- **AND** the eligible memory SHALL NOT be displaced by the newer ineligible ones, because the type filter ran before the row limit rather than after it

#### Scenario: A superseded take is not surfaced beside its successor

- **GIVEN** two memories saved under the same `topic_key`, both linked to entity `config/deploy.yaml`, so the earlier is `superseded` and the later is `active`
- **WHEN** the recall-hints endpoint extracts that entity
- **THEN** the recall line SHALL name the `active` memory's title
- **AND** it SHALL NOT name the `superseded` memory's title

### Requirement: Entity recall lines MUST be deduped per session

Each entity SHALL be surfaced at most once per session. The server SHALL maintain a per-session set of entities already recalled; an entity in that set SHALL be skipped on subsequent turns even if the prompt mentions it again.

Sessions without prior dedupe state SHALL get no lines from dedup — the first mention of any entity is surfaced normally.

**The set SHALL be keyed on the entity's `(kind, value)` pair, not on the value alone.** The extractor admits the same literal under more than one kind, and suppressing every kind on the strength of one match hides a memory the prompt legitimately addressed.

**The state is process-local and transient, and this change owns both of its bounds.** It SHALL NOT be stored on the session row: unlike the nudge clocks, which are columns because a cadence must survive a restart to stay honest, a lost dedupe set costs one repeated hint, which does not justify a migration on an append-only table. Being process-local means nothing reclaims it automatically, so the server SHALL release a session's set when that session ends or is soft-deleted, and SHALL bound the number of sessions retained, evicting the least recently used beyond that bound. A restart clears the state and each entity surfaces once more, which is accepted.

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

#### Scenario: The same literal under two kinds is deduped independently

- **GIVEN** a session in which a literal was recalled under one entity kind
- **WHEN** a later prompt admits that same literal under a different kind, with an eligible memory behind it
- **THEN** the second kind's first appearance SHALL still be surfaced
- **AND** suppressing it SHALL fail an assertion, because the key is the `(kind, value)` pair rather than the value

#### Scenario: Dedupe state does not outlive its session

- **GIVEN** a session that has recalled at least one entity
- **WHEN** that session ends or is soft-deleted
- **THEN** its dedupe set SHALL be released
- **AND** a subsequent request naming the same entity under a NEW session SHALL surface it, since dedupe is per session

#### Scenario: Retained dedupe state is bounded

- **GIVEN** more distinct sessions have used recall than the retention bound admits
- **WHEN** the bound is exceeded
- **THEN** the least recently used session's set SHALL be evicted
- **AND** the number of retained sets SHALL NOT exceed the bound, so a long-lived process cannot accumulate dedupe state without limit

### Requirement: Per-turn entity recall MUST be bounded

The server SHALL return at most 3 entity recall lines per turn. Each line SHALL carry the inline titles of the top-2 matched memories for that entity. The total token cost of all entity recall lines SHALL NOT exceed approximately 200 tokens.

**The line cap bounds the response; the lookup work behind it SHALL carry its own bound.** Extraction admits up to 250 entities from one text, and a prompt naming many indexed identifiers that all resolve to ineligible memories performs one indexed lookup per entity and produces no line at all, so the line cap never engages. The server SHALL therefore probe at most a fixed ceiling of distinct entities per request, in extraction order, and SHALL stop probing as soon as the line cap is reached.

#### Scenario: A prompt mentions five entities

- **WHEN** the recall-hints endpoint receives a prompt mentioning five entities each with multiple matched memories
- **THEN** the response SHALL contain at most 3 entity recall lines
- **AND** each line SHALL carry at most 2 memory titles
- **AND** entities beyond the first 3 SHALL be silently dropped (they will surface on a later turn if the entity set shifts)

#### Scenario: A prompt naming many indexed identifiers bounds the work, not only the answer

- **WHEN** a prompt names more distinct indexed entities than the probe ceiling admits, and none of them has an eligible memory behind it
- **THEN** the server SHALL perform at most the ceiling's worth of entity lookups
- **AND** the response SHALL be an empty `lines` array
- **AND** raising the number of named entities beyond the ceiling SHALL NOT raise the number of lookups performed

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

### Requirement: The recall path MUST count its own firing

The server SHALL count, per token, the recall-hints requests it served, how many of those returned at least one line, and how many lines it served in total. These SHALL be reported on the same admin-authorized debug surface as the tool-call counters, under the same authorization.

Tool-call counters alone cannot answer the question this change exists to answer. They count what the model did, so a session in which recall never fired and one in which it fired on every turn produce the same numbers, and a flat `memory.search` count is then unreadable: it could mean the hints do not help, or it could mean they never appeared. The three recall numbers supply the missing denominator — exposure, the hit rate the entity approach actually achieves on real prompts, and the token cost being paid for it.

#### Scenario: A prompt with no entities counts as a request that served nothing

- **WHEN** the recall-hints endpoint answers a prompt from which no entity is extracted
- **THEN** the request counter for that token SHALL increment
- **AND** the non-empty-response counter SHALL NOT increment
- **AND** the lines-served counter SHALL be unchanged

#### Scenario: A request that returns lines counts all three

- **WHEN** the recall-hints endpoint answers a prompt with two eligible matched entities
- **THEN** the request counter SHALL increment by one
- **AND** the non-empty-response counter SHALL increment by one
- **AND** the lines-served counter SHALL increase by the number of lines actually returned

#### Scenario: The recall counters are admin-only, like the tool counters

- **WHEN** a non-admin token requests the debug surface
- **THEN** the request SHALL be refused
- **AND** no recall counter value SHALL appear in the response

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
