## REMOVED Requirements

### Requirement: `memory.session_get` returns a session's full summary by id
**Reason**: Replaced by a paginated batch read with direct period selection.
**Migration**: Use `memory.session_get_batch({ ids: [sessionId] })` and `sessions[0]`, or select a period with `from`/optional `to`.

## ADDED Requirements

### Requirement: Batch session retrieval returns full summaries without mutating sessions

`memory.session_get_batch` SHALL accept exactly one selector: a nonempty array of nonempty `ids`, or ISO timestamps with offsets `from` and optional `to` (default server now). `from < to` SHALL be required. Singular `sessionId`, mixed selectors and unknown properties SHALL be refused. Reads SHALL resolve and authorize the effective project through the shared resolver; no implicit cross-project widening SHALL occur.

Both modes SHALL accept `limit` (default20, integer1–20) and `offset` (default0, nonnegative integer). ID mode SHALL deduplicate before paging, preserve order and report associated `not_found` errors for missing/foreign/deleted IDs. Period mode SHALL select non-deleted sessions with persisted content whose activity span overlaps `[from,to)`: `startedAt < to` and `coalesce(lastActivityAt,startedAt) >= from`. Stored fallback summaries SHALL qualify. Results SHALL be ordered by startedAt DESC then id DESC. Pages are live reads, not frozen snapshots.

The response SHALL be `{ sessions, errors, total, nextOffset }`, with at most20 data/error outcomes. ID-mode total SHALL count distinct requested IDs; period-mode total SHALL count matching in-scope sessions. Offset continuation SHALL preserve complete summaries without a new byte limit or fragmentation. Empty selections/pages SHALL succeed. An attempted page whose every item fails SHALL return MCP `isError: true` with all associated errors.

Entries SHALL preserve id, agent, status, startedAt, endedAt, title and the full persisted summary, and expose lastActivityAt and summaryFinal to distinguish scope of activity and curated versus fallback content. Null summaries SHALL remain null. The current stored summary SHALL NOT be presented as a historical snapshot or proof that all described work occurred within the selected interval. No versions or recovery of displaced text SHALL be promised. No session row SHALL be mutated; context snippets remain unchanged.

#### Scenario: A period query answers without an ID-discovery round trip
- **WHEN** an authenticated caller requests a week as `from`/ `to`
- **THEN** the first call SHALL return full matching session entries directly, with continuation for more than20 outcomes
- **AND** an older-started session with activity spanning that week SHALL be eligible, while foreign/deleted/outside sessions SHALL not

#### Scenario: Mixed IDs and failed pages remain explicit
- **WHEN** a page includes valid, absent, foreign and deleted IDs
- **THEN** valid full summaries SHALL be returned alongside indistinguishable associated errors
- **AND** a one-item missing page or entirely failed multi-item page SHALL set MCP isError

#### Scenario: Strict limits have a passing control
- **WHEN** IDs or a valid period are requested with `limit: 20` and `offset: 0`
- **THEN** the call SHALL succeed
- **AND** `limit: 21`, negative offset, reversed dates, mixed selectors or a singular sessionId SHALL fail

#### Scenario: Large summaries remain complete
- **WHEN** a page contains20 large stored summaries
- **THEN** each SHALL be returned intact even when the combined byte size is large
- **AND** no session SHALL be touched and no fragment or byte-budget error SHALL appear
