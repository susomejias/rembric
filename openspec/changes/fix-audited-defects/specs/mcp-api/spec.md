## ADDED Requirements

### Requirement: Memory-returning MCP reads MUST expose `topic_key`

`topic_key` is the identity of a convergent topic: saving with the same key atomically supersedes the previously-active row in the same `(scope, project_id, topic_key)`. That convergence requires the agent to reproduce a byte-identical key across sessions, so the key SHALL be observable. Every memory-returning read — `memory.get`, `memory.search`, `memory.context.recentMemories`, and `memory.save` candidates — SHALL include the memory's `topicKey` (null when unset). `memory.search` SHALL additionally accept a `topic_key` filter that returns only rows carrying that exact key.

#### Scenario: A search result carries its topic key

- **GIVEN** an active memory saved with `topic_key = 'decision/deploy-runbook'`
- **WHEN** `memory.search` returns it
- **THEN** the returned row SHALL include `topicKey: 'decision/deploy-runbook'`

#### Scenario: Filtering by topic key

- **WHEN** `memory.search` is called with `topic_key = 'decision/deploy-runbook'` in a scope containing that key
- **THEN** the response SHALL contain only rows whose `topic_key` equals that value

### Requirement: `memory.suggest_topic_key` MUST report whether the suggested key is occupied

A key suggestion computed purely from `type` and `title` cannot tell the agent that an equivalent topic already exists under a differently-worded key, which is the exact failure that fragments a topic into two active rows. `memory.suggest_topic_key` SHALL consult the connection's effective scope and return, alongside the suggested key: `occupied` (whether an active row already holds it), `occupantId` and `occupantTitle` when occupied, and `nearby` — a bounded list of `{topic_key, title}` for active rows in scope whose keys share a prefix with the suggestion — so the agent can adopt an existing key instead of minting a synonym.

#### Scenario: The suggested key is already held

- **GIVEN** an active memory in scope with `topic_key = 'decision/dev-stack-permissions'`
- **WHEN** `memory.suggest_topic_key` produces that same key
- **THEN** the response SHALL report `occupied: true` with the occupant's id and title

#### Scenario: A near-miss key exists

- **GIVEN** an active memory in scope with `topic_key = 'decision/dev-stack-permissions'`
- **WHEN** `memory.suggest_topic_key` produces `decision/dev-stack-chown`
- **THEN** `occupied` SHALL be `false` and `nearby` SHALL include the existing `decision/dev-stack-permissions` entry

#### Scenario: Suggestion is scope-isolated

- **WHEN** `memory.suggest_topic_key` is called on a connection scoped to project A and the key is held only in project B
- **THEN** `occupied` SHALL be `false` and `nearby` SHALL NOT reference project B's row

### Requirement: `memory.capture_passive` MUST use the same curation path as `memory.save`

`memory.capture_passive` is the tool the protocol steers agents toward for bulk persistence, so it SHALL NOT be a weaker write path. Each extracted learning SHALL be saved through the same pipeline as `memory.save`: convergent-topic handling, inline embedding before candidate detection, and save-time candidate detection. The response SHALL aggregate the detected `candidates[]` so conflicts introduced by a bulk capture are surfaceable and judgeable, rather than silently accumulating unlinked rows that are additionally invisible to the dense search branch until a background drain reaches them.

#### Scenario: A bulk capture surfaces a conflict

- **GIVEN** an existing active memory that semantically conflicts with one of the extracted learnings
- **WHEN** `memory.capture_passive` saves that learning
- **THEN** the response SHALL include a candidate referencing the existing memory, and a pending relation SHALL have been recorded

#### Scenario: Captured rows are immediately searchable by the dense branch

- **WHEN** `memory.capture_passive` saves a learning
- **THEN** that row's embedding SHALL have been computed before the call returns, so a subsequent `memory.search` vector branch can surface it

### Requirement: `memory.capture_passive` MUST NOT report success when it extracted nothing

Returning `{saved: 0}` as a success response for text whose learnings header did not match causes the agent to report to the user that learnings were persisted when none were. A zero-match parse SHALL be an explicit, actionable signal naming the expected header form. The header match SHALL accept a case-insensitive level-2 or level-3 heading with an optional trailing colon, so ordinary formatting variation is not silently discarded.

#### Scenario: No learnings header is present

- **WHEN** `memory.capture_passive` is called with text containing no learnings heading
- **THEN** the response SHALL explicitly report that nothing was extracted and name the expected heading form

#### Scenario: A lower-cased heading without a colon is accepted

- **WHEN** `memory.capture_passive` is called with a `### key learnings` heading followed by three list items
- **THEN** three memories SHALL be saved

### Requirement: `memory.stats` counts MUST all be scoped to the request context

`memory.stats` is documented as returning counts scoped to the request context. Every counter it returns SHALL therefore be computed against the resolved `Scope`, including `sessionsByStatus`, which currently aggregates every non-soft-deleted session row on the server regardless of project. The scoped guarantee SHALL be enforced by the counting method **requiring** a `Scope` parameter rather than by a naming convention, so a future unscoped call cannot pass review by omission. The unscoped variant SHALL carry the `admin` prefix that confines it to the dashboard.

The documented output contract SHALL be corrected to enumerate exactly the counters the tool returns.

#### Scenario: A project-scoped token reads stats

- **WHEN** `memory.stats` is called on a connection whose effective scope is project A, and other projects have sessions
- **THEN** `sessionsByStatus` SHALL count only sessions belonging to project A

#### Scenario: The output contract matches the implementation

- **WHEN** the documented `memory.stats` output is compared against the returned structured content
- **THEN** every documented counter SHALL be present and no returned counter SHALL be undocumented
