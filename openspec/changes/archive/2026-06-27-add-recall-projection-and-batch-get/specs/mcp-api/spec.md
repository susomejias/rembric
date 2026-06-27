# mcp-api delta — search projection and batch get

## MODIFIED Requirements

### Requirement: memory.search response MUST include relation annotations

The `memory.search` response SHALL include a `relations` array on each result row, populated in a single JOIN over `memory_relations`. Annotation kinds: `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped`, `pending_conflict`. Each annotation SHALL include the target id and (when judged) a short snippet of the target's content.

Each result row SHALL additionally carry the derived review metadata for the memory (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) for `active` rows, and `reviewAfter` when non-null. These fields are informational metadata only — they SHALL NOT change result ordering, scope isolation, or which rows are returned. Rows that are not `active` SHALL omit `reviewState`.

`memory.search` SHALL accept two OPTIONAL projection parameters that shape the returned rows WITHOUT changing which rows are returned or their order: `snippet` (a positive integer) and `fields` (a list of row field names). When `snippet` is supplied, each returned row's `content` SHALL be truncated to at most that many characters using the same truncation semantics as `memory.context` (the snippet helper: slice and append an ellipsis when the content exceeds the cap). When `fields` is supplied, the response SHALL return only the named fields PLUS the always-present identity fields `id`, `type`, and `title` (so every projected row remains identifiable). The two parameters compose: requesting `content` in `fields` together with a `snippet` cap yields a truncated `content`. When NEITHER `snippet` NOR `fields` is supplied, the response SHALL be the unchanged full-content row shape (byte-for-byte back-compatible). Projection SHALL be applied AFTER selection, ranking, scope enforcement, and the `last_seen_at` touch — it SHALL NOT alter any of them.

#### Scenario: A search result row reports its relations

- **WHEN** `memory.search` returns memory N which has a judged `supersedes` relation to memory M and a pending relation to memory Q
- **THEN** the result row SHALL include `relations: [{ kind: 'supersedes', targetId: 'M', snippet }, { kind: 'pending_conflict', targetId: 'Q', judgmentId }]`

#### Scenario: The annotation set respects the cap

- **GIVEN** memory N has 25 rows in `memory_relations`
- **WHEN** the cap is 10
- **THEN** the response SHALL include the 10 most recent annotations; the rest are accessible via the dashboard

#### Scenario: A search result row reports its review state

- **GIVEN** an `active` memory N whose derived `reviewState` is `'needs_review'`
- **WHEN** `memory.search` returns N
- **THEN** the result row SHALL include `reviewState: 'needs_review'` and a non-null `reviewAfter`
- **AND** the presence of `reviewState` SHALL NOT alter N's position in the result ordering

#### Scenario: A search with no projection returns full content unchanged

- **GIVEN** `memory.search` is called WITHOUT `snippet` and WITHOUT `fields`
- **WHEN** the response is returned
- **THEN** each row SHALL carry its full untruncated `content` and the same field set as before this change

#### Scenario: A search with a snippet cap truncates content

- **GIVEN** a result row whose `content` is longer than `N` characters
- **WHEN** `memory.search` is called with `snippet: N`
- **THEN** that row's returned `content` SHALL be the content truncated to at most `N` characters using the `memory.context` snippet truncation semantics
- **AND** the set of rows returned and their order SHALL be identical to the same query without `snippet`

#### Scenario: A search with field selection keeps identity fields

- **GIVEN** `memory.search` is called with `fields: ['status']`
- **WHEN** the response is returned
- **THEN** each row SHALL include `status` and the always-present identity fields `id`, `type`, and `title`, and MAY omit fields not requested (e.g. `tags`, `relations`)
- **AND** the set of rows returned and their order SHALL be identical to the same query without `fields`

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, source, and the full chain of predecessors derived from `replaces`, plus the confirmation count for the current head.

For an `active` memory, the response SHALL additionally include the derived review metadata (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) and `reviewAfter` when non-null. For non-`active` memories these fields SHALL be omitted.

`memory.get` SHALL additionally accept an OPTIONAL `ids` array as a back-compatible batch form. Exactly one of `id` or `ids` SHALL be supplied; supplying both, or neither, SHALL be an `invalid_input` error. When `id` is supplied, the response shape SHALL be unchanged from the single-memory form above. When `ids` is supplied, the response SHALL contain an ordered `memories` array — one per id that resolves to an in-scope, token-authorized memory, in the same order the ids were requested, each entry carrying the same per-memory shape as the single-`id` form — plus a `notFound` array listing the requested ids that did not resolve. The batch form SHALL be scope-enforced via a scoped service read: an id outside the connection's effective scope SHALL be reported in `notFound` and SHALL NOT leak the memory's content or existence, identically to how the single-`id` form treats an out-of-scope id as not found. The `ids` array SHALL be bounded by a maximum length; a request exceeding it SHALL be an `invalid_input` error.

#### Scenario: Retrieve a merged memory

- **WHEN** an authenticated client calls `memory.get` with the id of a merged memory M
- **THEN** the response SHALL include M's content, M's predecessor ids, their content snapshots, and the confirmation count against M

#### Scenario: memory.get reports review state for an active memory

- **GIVEN** an `active` memory M whose derived `reviewState` is `'fresh'`
- **WHEN** an authenticated client calls `memory.get('M')`
- **THEN** the response SHALL include `reviewState: 'fresh'` and `reviewAfter` (the non-null derived timestamp for M's type)

#### Scenario: memory.get with a single id is unchanged

- **WHEN** an authenticated client calls `memory.get({ id: 'M' })` (no `ids`)
- **THEN** the response SHALL be the single-memory shape (memory, head, predecessors, confirmationCount, relations, and review metadata when active), identical to the behavior before the batch form was added

#### Scenario: memory.get with ids returns an ordered batch

- **GIVEN** in-scope memories M1, M2, M3 all readable by the calling token
- **WHEN** an authenticated client calls `memory.get({ ids: ['M2', 'M1', 'M3'] })`
- **THEN** the response SHALL include `memories` ordered `[M2, M1, M3]`, each carrying the single-`id` per-memory shape, and `notFound: []`

#### Scenario: memory.get batch never leaks a cross-scope id

- **GIVEN** memory X exists in a DIFFERENT project than the connection's effective scope, and in-scope memory M1
- **WHEN** an authenticated client calls `memory.get({ ids: ['M1', 'X'] })`
- **THEN** the response `memories` SHALL contain only M1, and `X` SHALL appear in `notFound`
- **AND** the response SHALL NOT include X's content, title, or any field distinguishing "out of scope" from "does not exist"

#### Scenario: memory.get rejects ambiguous id arguments

- **WHEN** an authenticated client calls `memory.get` with BOTH `id` and `ids` set, or with NEITHER set
- **THEN** the server SHALL return an `invalid_input` error and SHALL NOT return any memory
