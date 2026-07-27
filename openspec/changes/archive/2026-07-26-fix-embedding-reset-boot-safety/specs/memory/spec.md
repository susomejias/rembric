## ADDED Requirements

### Requirement: The embedding-identity reset MUST be crash-safe and MUST NOT be able to abort the boot

The reset that follows an embedding-identity mismatch has two effects that live in different storage systems — the vectors are removed from SQLite, the new identity is recorded in a file under the data dir — and there is no transaction spanning both. The recipe marker SHALL therefore be maintained in two phases: it SHALL record an **in-progress** reset for the compiled-in identity BEFORE any vector is removed, and it SHALL assert that identity as **settled** only AFTER the wipe has committed. An in-progress marker SHALL be treated as an identity mismatch, so an interrupted reset is retried on a later boot.

Three properties follow, and each SHALL hold for every reachable interleaving:

1. **The index SHALL NOT be observed empty under a settled marker asserting the current identity.** That combination is the unrecoverable one: the vectors are gone and nothing will ever conclude they need rebuilding.
2. **A reset that fails at any point SHALL leave the corpus visible to the background drain as needing a rebuild**, and SHALL leave the marker NOT asserting the compiled-in identity as settled. Visibility is a property of the corpus, not of a flag: a memory row with no `memory_vec` row is already what the drain selects, so a committed wipe is self-announcing and a marker still recording an in-progress reset is what forces the wipe to be retried.
3. **Recording the in-progress marker SHALL precede the wipe on EVERY boot that detects a mismatch**, including a boot whose marker already carries the compiled-in identity but records the reset as in progress. This is what bounds the failure: when the data dir is unwritable, the in-progress write fails before any vector is removed, so a persistently unwritable data dir SHALL perform zero wipes rather than one per boot.

Marker maintenance SHALL NOT abort the boot. A failure to read, write, or flip the marker, and a failure of the wipe itself, SHALL degrade to "leave the index as it is and re-check on the next boot", SHALL be logged with the marker's path, and SHALL NOT prevent the HTTP listener from binding. This SHALL NOT be read as relaxing the model-load rule: an embedding model that cannot load still aborts the boot with a non-zero exit. The distinction is deliberate — a server without a warm model cannot serve its core function, whereas a server whose derived vector index is stale or mid-rebuild serves every request with the documented lexical degradation.

A wipe that commits and a marker that fails to settle SHALL be reported as two separate facts, because their operator consequences differ: the first announces a rebuild that is now under way, the second announces that the rebuild may be repeated on the next boot.

A marker written by a build that predates the two-phase scheme carries no in-progress field, and its absence SHALL be read as "settled". An upgrade SHALL therefore perform no reset that the previous build would not have performed.

#### Scenario: The marker cannot be written and no vector is lost

- **GIVEN** an identity mismatch and a data dir where writing the marker fails (full or read-only)
- **WHEN** the server starts
- **THEN** no row SHALL be removed from `memory_vec`, the boot SHALL proceed to bind the listener, and the failure SHALL be logged with the marker path

#### Scenario: The wipe commits but the marker cannot be settled

- **GIVEN** an identity mismatch where the in-progress marker persists, the wipe commits, and settling the marker then fails
- **WHEN** the server starts
- **THEN** the boot SHALL proceed, the wipe and the marker failure SHALL be logged as separate facts, and the marker SHALL NOT assert the compiled-in identity as settled
- **AND** the background drain SHALL re-embed the corpus, because every non-archived memory now lacks a `memory_vec` row

#### Scenario: An interrupted reset converges on the next boot

- **GIVEN** a marker left recording an in-progress reset for the compiled-in identity
- **WHEN** the server starts again with a writable data dir
- **THEN** the marker SHALL be treated as a mismatch, the reset SHALL be retried, and the marker SHALL end settled on the compiled-in identity

#### Scenario: A persistently unwritable data dir performs no wipes at all

- **GIVEN** an identity mismatch and a data dir that stays unwritable across restarts
- **WHEN** the server is started repeatedly
- **THEN** the number of wipes performed SHALL be zero, because each boot re-attempts the in-progress write before the wipe and fails there
- **AND** every one of those boots SHALL still bind the listener

#### Scenario: An in-progress marker is not mistaken for a completed reset

- **GIVEN** a marker recording an in-progress reset whose model id and input version already equal the compiled-in identity
- **WHEN** the server starts
- **THEN** the reset SHALL run rather than short-circuit, so an index still holding pre-change vectors cannot be left mixing embedding spaces

#### Scenario: Upgrading over a marker from an earlier build resets nothing

- **GIVEN** a populated install whose marker records the compiled-in model id and input version and has no in-progress field
- **WHEN** the server starts on a build that implements the two-phase marker
- **THEN** the marker SHALL be read as settled, no vector SHALL be removed, and no write to the marker SHALL be attempted

#### Scenario: A model that cannot load still fails the boot

- **WHEN** the embedding model fails to load and the marker is perfectly healthy
- **THEN** the boot SHALL still abort with a non-zero exit — the non-fatal treatment applies to identity-marker maintenance only
