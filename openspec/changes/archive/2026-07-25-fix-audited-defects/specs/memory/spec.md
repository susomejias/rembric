## ADDED Requirements

### Requirement: Supersedes-chain reads MUST be bounded and content-free

A memory's predecessor ancestry is a DAG, not a chain: `replaces[]` is extended both by `saveWithTopicKey` (one immediate predecessor) and by `applySupersedesSideEffect` (an additional predecessor per judged `supersedes` verdict). Any read that walks that ancestry SHALL bound the traversal by a compile-time depth/count limit and SHALL project each predecessor to identity and lifecycle fields only — `{id, title, status, createdAt}` — never its `content`.

The response SHALL carry `predecessorCount` (the number of predecessors reached) and `truncated` (whether the bound was hit), so a caller can tell that more ancestry exists and page into it with the existing batch read. Because `title` is fixed at insert and never updated, the projected title is a faithful immutable label for the omitted content.

#### Scenario: A deep topic_key chain is read

- **GIVEN** a memory whose `topic_key` has been saved 52 times, producing 51 reachable predecessors
- **WHEN** `memory.get` is called on the current head
- **THEN** the response SHALL contain at most the bounded number of predecessors, each without `content`
- **AND** `truncated` SHALL be `true` and `predecessorCount` SHALL report the bound that was applied

#### Scenario: A short chain is read in full

- **GIVEN** a memory with three reachable predecessors
- **WHEN** `memory.get` is called on it
- **THEN** all three SHALL be returned as `{id, title, status, createdAt}` projections
- **AND** `truncated` SHALL be `false`

#### Scenario: Head resolution exceeding its hop cap is signalled

- **GIVEN** a `replaces` graph whose forward walk from the requested id exceeds the head-resolution hop cap
- **WHEN** the head is resolved (e.g. by `memory.confirm`)
- **THEN** the caller SHALL receive an explicit signal that the head was not reached, rather than a silently-returned non-active row

### Requirement: Reactivating a decayed memory MUST survive the next sweep

Undoing a decay operation SHALL restore the affected rows to `active` **and** stamp their `last_seen_at` to the undo instant, because an operator reviving a memory is an access event. Without the stamp all three decay-candidate predicates (`status='active'`, `last_seen_at` older than the per-type window, confirmation count below the floor) still hold and the next sweep re-archives the same rows, making undo appear to work and then silently revert itself.

The undo SHALL NOT record a confirmation and SHALL NOT advance the review baseline, so the decay axis and the review axis stay orthogonal.

#### Scenario: A decayed memory is restored and the sweep runs again

- **GIVEN** a memory archived by a decay op, whose op is then undone
- **WHEN** the consolidation sweep runs again with no intervening writes
- **THEN** the memory SHALL still be `active` and SHALL NOT appear in the new run's decay candidates

#### Scenario: Reactivation does not affirm the memory

- **GIVEN** a memory archived by decay and then restored by undo
- **WHEN** its derived review state is computed
- **THEN** the review baseline SHALL be unchanged by the reactivation, and no confirmation row SHALL have been inserted

### Requirement: Text inputs MUST reject NUL bytes at the service boundary

SQLite's `length()` terminates at the first NUL byte, so a value whose JavaScript `.length` satisfies a bound can still violate the database-level `CHECK` on the same column — a `title` beginning with a NUL byte has JS length ≥ 1 but SQLite length 0 and is rejected by the `CHECK(length(title) BETWEEN 1 AND 100)` constraint, surfacing as an opaque `internal_error` with the memory never written. Every agent-supplied text field SHALL be rejected with `invalid_input`, naming the offending field, when it contains a NUL byte: `title`, `content`, each element of `tags`, and the session `title` and `summary`. This generalises the guard that already exists for `topic_key`.

#### Scenario: A title containing a leading NUL byte is rejected

- **WHEN** `memory.save` is called with a `title` whose first character is a NUL byte
- **THEN** the call SHALL be rejected with `invalid_input` naming `title`, and SHALL NOT reach the database

#### Scenario: Content containing an embedded NUL byte is rejected

- **WHEN** `memory.save` is called with a `content` containing a NUL byte at any position
- **THEN** the call SHALL be rejected with `invalid_input` naming `content`

### Requirement: Derived titles MUST NOT split a surrogate pair

`deriveTitle` truncates to the title bound with a raw UTF-16 slice, so content whose boundary character is astral (an emoji, some CJK extensions) yields a title ending in a lone surrogate, which becomes U+FFFD when encoded and then feeds the FTS index and every list view. Title derivation SHALL use the same surrogate-safe slice helper already used for session summary truncation.

#### Scenario: Content whose truncation boundary falls inside an emoji

- **WHEN** `memory.capture_passive` derives a title from content whose character at the truncation boundary is an astral-plane codepoint
- **THEN** the derived title SHALL end at the preceding whole codepoint and SHALL NOT contain an unpaired surrogate
