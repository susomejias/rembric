## ADDED Requirements

### Requirement: The MCP server MUST expose `memory.pin`

The server SHALL register an MCP tool `memory.pin` that pins or unpins a single memory. The tool SHALL accept `{ id: string, pinned: boolean }` (validated by zod, strict; `id` non-empty, `pinned` required) and SHALL NOT accept a `scope` argument. It SHALL resolve the effective scope through `resolveEffectiveScope`, require write authorization, and delegate to `MemoryService.setPinned` (see the `memory` capability, "An active memory MAY be pinned, with pin state derived from an append-only journal"), so pinning is confined to the connection's one project.

A successful call SHALL return `{ ok: true, id, pinned, changed, pinnedCount, pinnedMax }`, where `pinned` is the derived state after the call, `changed` is false when the call appended nothing, `pinnedCount` is the project's pinned count after the call and `pinnedMax` is `PIN_MAX_PER_PROJECT`. A cross-scope or unknown `id` SHALL return `not_found`; a non-`active` memory SHALL return `conflict`; pinning past `PIN_MAX_PER_PROJECT` SHALL return the error code `pin_limit_reached` whose structured details carry `limit` and `pinned: [{ id, title }]` naming every current pin, so the agent can ask the user which one to unpin. The tool SHALL carry `readOnlyHint: false`, `idempotentHint: true` (a repeated call appends nothing), `destructiveHint: false` and `openWorldHint: false`.

#### Scenario: Pinning an active memory in scope

- **GIVEN** a `/mcp/<slug>` connection scoped to project `P` and an unpinned `active` memory `M` in `P`
- **WHEN** a client calls `memory.pin` with `{ id: 'M', pinned: true }`
- **THEN** the response SHALL carry `pinned: true`, `changed: true` and `pinnedCount` one higher than before
- **AND** a following `memory.context` on the same connection SHALL list `M` in `pinnedMemories[]`

#### Scenario: Repeating a pin changes nothing

- **GIVEN** a pinned memory `M`
- **WHEN** a client calls `memory.pin` with `{ id: 'M', pinned: true }`
- **THEN** the response SHALL carry `pinned: true` and `changed: false`, and no pin event SHALL be appended

#### Scenario: Pinning past the bound names the current pins

- **GIVEN** a project holding `PIN_MAX_PER_PROJECT` pinned memories
- **WHEN** a client calls `memory.pin` with `{ id, pinned: true }` for another active memory of that project
- **THEN** the call SHALL fail with code `pin_limit_reached` and its details SHALL list the id and title of every current pin

#### Scenario: Pinning a memory of another project is not found

- **GIVEN** a connection scoped to project `P` and a memory `X` in project `Q`
- **WHEN** a client calls `memory.pin` with `{ id: 'X', pinned: true }`
- **THEN** the call SHALL fail with `not_found` and `X` SHALL NOT be pinned

#### Scenario: A read-only token cannot pin

- **WHEN** a token whose scope is `read:*` calls `memory.pin`
- **THEN** the call SHALL fail with `forbidden` and nothing SHALL be appended

### Requirement: The `memory.pin` description MUST steer against autonomous pinning

Because a pin puts a memory in front of every future session of the project, the tool description is load-bearing. The description SHALL instruct the model to call `memory.pin` ONLY when the user has explicitly asked to pin, always load, or stop always loading a specific memory, and SHALL forbid pinning on the model's own judgement or as housekeeping during recall or save. It SHALL state that pinned memories lead every `memory.context`, that the count per project is bounded and a refusal names the current pins, that pinning does not suspend `needs_review`, and that the operator can pin and unpin from the dashboard. These constraints SHALL be expressed in the top-level description text, not only in a per-argument `describe()`, and the description SHALL satisfy `DESCRIPTION_MAX_LENGTH`.

#### Scenario: The description carries the explicit-request guard

- **WHEN** a client retrieves the `memory.pin` description via `tools/list`
- **THEN** it SHALL convey that the tool is called ONLY at the user's explicit request
- **AND** it SHALL convey that the model MUST NOT pin on its own judgement or as housekeeping
- **AND** it SHALL convey that pinned memories lead `memory.context`, that the count is bounded, and that pinning does not suspend `needs_review`

### Requirement: `memory.context` MUST lead with a bounded pinned section outside the ranked channels

`memory.context` SHALL return `pinnedMemories[]` as the first field of its response: every pinned memory of the connection's project, in pin order (oldest pin first), each carrying `id`, `type`, `title`, `content`, `truncated`, `createdAt`, `topicKey` and `pinnedAt`. The section SHALL be emitted on every call, independent of `focus`, `memories` and every other argument, and SHALL be empty, not absent, when nothing is pinned.

Content SHALL be bounded by `PINNED_CONTEXT_CHAR_BUDGET`: walking the pins in order, an entry whose full content fits in the budget still remaining SHALL be emitted whole with `truncated: false`; every other entry SHALL be emitted through the existing context snippet bound (`CONTEXT_SNIPPET_CHARS`) with `truncated: true`, and the `memory.context` description SHALL point the agent at `memory.get_batch` for the full text of a truncated entry.

The pinned section SHALL sit outside the ranked channels. A pinned memory SHALL NOT appear in `recentMemories[]` or `relevantMemories[]`, and SHALL NOT take a slot from either: the recency channel SHALL still return up to `memories` unpinned rows, and the relevance channel up to `RELEVANCE_LIMIT` unpinned rows. When the project holds no pins, `recentMemories[]` and `relevantMemories[]` SHALL be exactly what they were before this requirement. `needsReview[]` is an action queue rather than a recall channel and SHALL NOT be deduped against the pinned section.

#### Scenario: A pinned memory older than the recency window is loaded

- **GIVEN** a project whose `memories` most recent memories are all newer than memory `M`
- **WHEN** `M` is pinned and a fresh session calls `memory.context` with default arguments
- **THEN** `pinnedMemories[]` SHALL contain `M` with its full content
- **AND** with `M` unpinned, the same call SHALL contain `M` in neither `pinnedMemories[]` nor `recentMemories[]`

#### Scenario: A pinned memory is not shown twice and costs no slot

- **GIVEN** a pinned memory that is also among the `memories` most recent and ranks for the `focus`
- **WHEN** `memory.context` is called with that `focus`
- **THEN** it SHALL appear in `pinnedMemories[]` only
- **AND** `recentMemories[]` SHALL still hold `memories` rows when the project has that many unpinned active memories

#### Scenario: Content past the budget is truncated and flagged

- **GIVEN** pinned memories whose combined content exceeds `PINNED_CONTEXT_CHAR_BUDGET`
- **WHEN** `memory.context` is called
- **THEN** the entries that fit SHALL carry their full content with `truncated: false`
- **AND** every later entry SHALL carry content no longer than `CONTEXT_SNIPPET_CHARS` with `truncated: true`

#### Scenario: Pins of another project are not loaded

- **GIVEN** a pinned memory in project `Q`
- **WHEN** a connection scoped to project `P` calls `memory.context`
- **THEN** that memory SHALL NOT appear in `pinnedMemories[]`

#### Scenario: A stale pinned memory still surfaces for review

- **GIVEN** a pinned memory whose derived `reviewState` is `needs_review`
- **WHEN** `memory.context` is called
- **THEN** it SHALL appear in `pinnedMemories[]` and in `needsReview[]`

### Requirement: Memory-returning MCP reads MUST expose pin state

Every `memory.search` row and every `memory.get_batch` row SHALL carry `pinned: boolean`, the derived pin state of that memory (see the `memory` capability). `memory.get_batch` SHALL declare the field required. `memory.search`'s `fields` projection SHALL treat `pinned` like any other optional field. Exposing the state SHALL NOT change which rows `memory.search` returns or their order.

#### Scenario: A pinned memory reads as pinned

- **GIVEN** a pinned memory `M`
- **WHEN** `memory.search` returns `M` or `memory.get_batch` is called with `ids: ['M']`
- **THEN** the row for `M` SHALL carry `pinned: true`
- **AND** an unpinned memory in the same response SHALL carry `pinned: false`

## MODIFIED Requirements

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`. Both output contracts SHALL enumerate exactly the fields the tools return: a documented field the tool does not return misleads a client into treating its absence as a fault, and a returned field the contract omits is undocumented surface (the two counters added for queue-depth observability were both in the second category).

The `db` block SHALL NOT carry an `open` flag. Producing the report requires a database read to authenticate the request, so a report that exists is proof the database was open, and the flag's `false` value is reachable only in a state where the tool returns no report at all — the unreachable-state defect (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). Database trouble that does NOT prevent the call SHALL continue to be reported where it varies: `integrity` from the integrity check, and `warnings` for a pragma read that failed. **BREAKING** on the published output contract, accepted because a field with one reachable value cannot be depended upon for anything.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { journalMode, integrity, sizeBytes }, embeddings: { model, backlog }, entities: { backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, review: { needsReview, pendingJudgments }, warnings: string[] }` — the report SHALL NOT contain an `llm` block, and the `embeddings` block SHALL NOT contain `enabled` (embeddings are always on); `model` SHALL identify the compiled-in embedding model
- **AND** `entities.backlog` and `review` SHALL be server-wide, matching `sessions.active`

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ scope, memoriesByStatus, memoriesByType, sessionsByStatus, needsReviewTotal, pendingJudgmentsTotal, pinnedTotal }`, where `scope` is the resolved scope label, the three `*By*` values are each a `Record<string, number>`, and the three totals are numbers — every one of them computed against the request context
- **AND** `pinnedTotal` SHALL be the number of memories of the resolved project that derive as pinned; `memory.doctor` SHALL NOT report a pinned counter

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*`, or is `read:project:<id>` and the connection's effective scope resolves to that same project
- **THEN** both tools SHALL succeed (they are read-only by design)
- **WHEN** the caller's scope is `read:project:<id>` and the connection's effective scope resolves to a different project
- **THEN** the call SHALL be rejected with code `forbidden`

#### Scenario: The report carries no `db.open` flag

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the `db` block SHALL contain `journalMode`, `integrity` and `sizeBytes` and SHALL NOT contain `open`
- **AND** the declared `outputSchema` SHALL NOT mark `open` required, nor declare it at all

#### Scenario: A database fault that still permits the call is reported where it varies

- **GIVEN** a database whose pragma reads fail while the connection still authenticates the request
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the call SHALL succeed, `warnings` SHALL name the failed pragma read, and `integrity` SHALL report `unknown` rather than `ok`
- **AND** no field SHALL claim the database is healthy

