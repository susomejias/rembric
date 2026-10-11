# explicit-batch-tools Specification

## Purpose

Defines batch-only memory and session retrieval, atomic confirmations, independent judgments, bounded pagination and coordinated client migration.

## Requirements

### Requirement: Exactly four batch tools replace the original MCP operations

The server SHALL register `memory.get_batch`, `memory.session_get_batch`, `memory.confirm_batch` and `memory.judge_batch`, and SHALL NOT register `memory.get`, `memory.session_get`, `memory.confirm` or `memory.judge` or aliases. Every former operation use case SHALL be supported with a one-element array. All existing scope, authorization, append-only, topic-convergence, confirmation-attribution and judgment-freshness requirements SHALL continue to apply to the replacements. References to the former names in unaffected capability requirements SHALL denote the corresponding batch operation, with one-element array arguments and per-element outcomes; they SHALL NOT authorize an old registration or singular input.

#### Scenario: Discovery exposes only replacements

- **WHEN** a real MCP client calls tools/list
- **THEN** the four new names SHALL be present and the four old names SHALL be absent
- **AND** calls to old names SHALL fail rather than route through an alias

### Requirement: Reads report every distinct requested ID without scope leakage

Explicit-ID reads SHALL accept a nonempty `ids` array of nonempty strings, with optional `relations_limit` for memory reads. Both reads SHALL alternatively accept `from` and optional `to` as ISO timestamps with offsets, mutually exclusive with IDs. Both reads SHALL accept `limit` (default/max20) and `offset` (default0). IDs SHALL be deduplicated before paging. A page SHALL contain at most20 outcomes, counting both data entries and failed-item errors; its envelope SHALL also include `total` and nullable `nextOffset`. Only this page's targets SHALL be read or touched; remaining targets SHALL be available through the next offset. No new byte/token limit or fragmentation SHALL be introduced. They SHALL deduplicate in first-occurrence order and return `{ memories, errors, total, nextOffset }` or `{ sessions, errors, total, nextOffset }`. Each failed distinct ID SHALL have an associated `{ id, code, message }` error; every successful distinct ID SHALL have a data entry. Successful entries and errors SHALL each retain input order. Missing and out-of-project IDs, and soft-deleted session IDs, SHALL produce the same `not_found` code and generic message; no existence distinction SHALL be exposed. An item-local failure SHALL NOT discard successful data from other items. Unexpected item-local errors SHALL be logged and sanitized as `internal_error`; raw exceptions SHALL NOT be exposed. A batch with at least one successful item SHALL NOT set MCP `isError`, even when other items fail. A page with attempted items but no successful item SHALL set MCP `isError: true`, including a one-item batch, and SHALL carry the empty successful collection, per-item errors and a top-level code/message: `not_found` when every item is not found, otherwise `batch_failed`. There SHALL NOT be a redundant `notFound` array. Schema, authorization and scope-resolution failures SHALL remain top-level failures before item processing. Empty ID arrays, out-of-range pagination, singular inputs and unknown fields SHALL be refused at the strict MCP boundary. ID selections MAY exceed one page; only the served outcomes SHALL be capped at20.

#### Scenario: Mixed IDs and duplicates

- **WHEN** a scoped read requests `[B, missing, foreign, A, B, missing]`
- **THEN** the successful array SHALL contain `[B, A]` and `errors` SHALL contain one error each for `missing` and `foreign`, with identical `not_found` codes and generic messages
- **AND** no foreign content or existence marker SHALL be exposed, and MCP `isError` SHALL NOT be true

#### Scenario: A single failed item is a real MCP error

- **WHEN** a scoped read requests `ids: [missing]`
- **THEN** it SHALL return MCP `isError: true`, top-level `not_found`, an empty successful collection and an associated error for `missing`
- **AND** the same read with one existing in-scope ID SHALL succeed, proving the failure is item-driven rather than a broken one-item path

#### Scenario: An entirely failed multi-item batch is also an error

- **WHEN** a scoped read requests two or more distinct IDs and none can be returned
- **THEN** it SHALL return MCP `isError: true` and one associated error for every distinct requested ID

#### Scenario: An item-local failure preserves the remaining data

- **WHEN** one ID's retrieval fails unexpectedly while another ID can be returned
- **THEN** valid data SHALL still be returned with an associated sanitized `internal_error` for the failed ID
- **AND** MCP `isError` SHALL NOT be true

#### Scenario: One item and old scalar inputs

- **WHEN** an existing in-scope ID is requested as `ids: [id]`
- **THEN** one entry SHALL be returned using the same envelope as a multi-item request
- **AND** requests carrying only `id` or `sessionId` SHALL be refused

#### Scenario: Pagination bounds outcomes without truncating content

- **WHEN** a read requests more than20 distinct IDs, including missing IDs, or a period matches more than20 records
- **THEN** each page SHALL contain at most20 data/error outcomes with `total` and `nextOffset` identifying continuation
- **AND** following offsets SHALL account for every requested target once in a stable dataset
- **AND** large returned summaries/content SHALL remain complete, not silently truncated or split

#### Scenario: An empty selection is not an item failure

- **WHEN** a period matches no records or offset is beyond the end
- **THEN** the page SHALL succeed with empty data/errors and `nextOffset: null`

### Requirement: Memory periods retrieve complete records by creation time

`memory.get_batch` SHALL accept either explicit IDs or `from` and optional `to` ISO timestamps with offsets, never both. The interval SHALL be `[from,to)`, with `to` defaulting to server now; invalid or reversed intervals SHALL fail before retrieval. The selection SHALL filter requested rows by `createdAt` in the resolved scope, include active, superseded and archived rows, and order `createdAt DESC, id DESC`. It SHALL return complete current records and history through the same paginated envelope. It SHALL NOT select by `lastSeenAt`, change which rows match merely because a read touches access, or claim to return historical content snapshots. Confirmation and judgment tools SHALL NOT accept temporal selectors.

#### Scenario: Creation, boundaries and access are distinct

- **GIVEN** in-scope rows created at the interval start, inside it and at its end, and an older row accessed inside it
- **WHEN** the period is read and then read again without inserted rows
- **THEN** only the start and inside rows SHALL be selected in stable createdAt/id order
- **AND** access updates SHALL not change their membership, and foreign rows SHALL remain excluded

#### Scenario: All lifecycle states remain readable

- **WHEN** a period includes active, superseded and archived in-scope rows
- **THEN** all SHALL be returned with their current status and bounded history
- **AND** an active head may be newer than the requested row without being a historical snapshot

### Requirement: Batch memory reads preserve bounded deep-read metadata

Each memory entry SHALL carry the existing batch row fields, annotations and entities, plus `head`, content-free `predecessors`, `predecessorCount`, `truncated`, `headTruncated` and affirming `confirmationCount`. Existing predecessor and head-walk bounds SHALL apply per entry. Internal provenance SHALL remain hidden. Requested-row review metadata SHALL be derived in one batched lookup and omitted for non-active memories. Every successfully returned memory batch record SHALL advance the resolved head's access signal, whether the batch contains one or many IDs. Failed, missing and foreign targets SHALL NOT be touched; projected predecessors SHALL NOT count as independently accessed unless explicitly requested and successfully read. Reading SHALL NOT count as affirmation or clear `needs_review`. Annotation defaults SHALL be 10, maximum 50, aggregate maximum 4000. One-item reads SHALL retain verbatim annotation reasons; multi-item reasons SHALL remain bounded.

#### Scenario: A chain survives the migration

- **WHEN** a batch reads a superseded ID and its confirmed active head
- **THEN** both entries SHALL expose their correct head, bounded predecessor projection and head confirmation count
- **AND** only the active requested row SHALL carry review metadata
- **AND** the successfully read targets' resolved-head access timestamps SHALL advance, without clearing `needs_review`

#### Scenario: All successful batch targets count as access

- **GIVEN** two in-scope targets with old access timestamps, an unrelated predecessor, a foreign target and a missing ID
- **WHEN** the batch successfully reads the two in-scope targets and reports errors for the others
- **THEN** each successful target's resolved head SHALL have an advanced access timestamp
- **AND** the foreign target and merely projected unrelated predecessor SHALL remain untouched
- **AND** the same access behavior SHALL apply to a one-item successful batch

### Requirement: Mutating batch semantics remain explicit

Confirmations SHALL accept 1–20 IDs and one shared verdict, optional reason and optional sessionId. IDs SHALL be deduplicated; the transaction SHALL record every chain-head event or roll back all events on any failure. Refutation SHALL require a nonempty reason and SHALL NOT advance access signals. Success SHALL include `confirmed` and the existing optional `headTruncated`.

Judgments SHALL accept only 1–20 strict `judgments` entries and return one result per entry in input order. Each judgment SHALL use its own transaction; domain errors SHALL be per-item results with scope-masked codes. Duplicates SHALL NOT be removed. With at least one successful judgment, the response SHALL be `{ ok: true, results }` and MCP `isError` SHALL NOT be true, preserving successful judgments beside failed-item errors. If all judgments fail, including a one-item batch, the tool SHALL return MCP `isError: true` and `{ ok: false, code, message, results }`, retaining all per-item failure results. The top-level code SHALL be `not_found` when all failure codes are `not_found`, otherwise `batch_failed`. A malformed entry SHALL refuse the whole request before any mutation.

#### Scenario: Confirm rolls back and judge does not

- **WHEN** a confirmation batch contains a valid and missing ID
- **THEN** no confirmation SHALL persist
- **AND** a judgment batch containing valid, missing and valid entries SHALL preserve both successful judgments

#### Scenario: One failed judgment is a real MCP error

- **WHEN** a one-item judgment batch targets an unknown or already-judged row
- **THEN** the response SHALL carry MCP `isError: true` and its one associated failure result
- **AND** a one-item batch targeting a valid pending row SHALL succeed without MCP `isError`

#### Scenario: An entirely failed judgment batch retains every error

- **WHEN** a multi-item judgment batch has no successful judgment
- **THEN** MCP `isError` SHALL be true and every submitted item SHALL retain its associated failure result in input order
- **AND** no transaction boundary or successful judgment SHALL be undone by this signaling rule

### Requirement: Every shipped client teaches the batch-only contract

Shared JS, shell and Python instructions, plugin commands and examples SHALL teach the new names and array arguments across Claude Code, Codex, Hermes, opencode and Pi. Session recovery SHALL read `memory.session_get_batch({ ids: [sessionId] })` and its full session entry before rewriting a summary. HTTP session lifecycle endpoints SHALL remain unchanged. Server descriptions and instructions SHALL NOT recommend removed names or singular forms.

#### Scenario: Recovery reminders remain aligned

- **WHEN** shared reminder fixtures and all five plugin instructions are tested
- **THEN** emitted reminders SHALL name the batch session read with the current session ID inside an array
- **AND** dynamic discovery adapters SHALL forward the batch arrays unchanged
