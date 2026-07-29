## ADDED Requirements

### Requirement: Every derived table MUST be reproducible from source tables by a pinned recipe

Every table in the schema SHALL be classified as either **source** or **derived**. A table is **derived** if and only if its full contents are recomputable from other tables in the same database — dropping it loses no information. Every other table is **source**: it is the sole record of something supplied by an agent, by an operator, or by the process's own history.

A derived table's contents SHALL be determined by exactly two inputs:

- **(a)** the current rows of the source tables it derives from, and
- **(b)** a recipe pinned in the shipped image.

It SHALL admit no third input. In particular, a derived table SHALL NOT depend on a network call, an external service, an operator-supplied value, a value that is not reproducible from (a) and (b), or state accumulated from the derived table's own history.

Where the recipe can change between releases, the derived table SHALL carry a version marker on disk naming the recipe in force, and a mismatch against the compiled-in recipe SHALL invalidate and re-derive the table — `EMBEDDING_INPUT_VERSION` (with the model identity) for `memory_vec`, `EXTRACTOR_VERSION` for the entity tables. Where the recipe is SQL triggers on the source table, no marker is required: the trigger IS the recipe and cannot drift from it. Every derived table SHALL have a reproduction path executable with no input beyond the database and the shipped image.

**Boundary.** This requirement reaches derived tables only. It places no constraint on what an agent may write into a source table. `memory.title`/`memory.content`, `sessions.summary`, `confirmations.reason` and `memory_relations.reason` are agent-authored, irreproducible, and therefore source — the agent-written `reason` on a judged relation is the densest signal in the judgment graph and exists nowhere else. `consolidation_ops` and `consolidation_runs` record the process's own history, which cannot be recomputed from the state it produced; that irreversibility is the point of a reversible journal. A reading of this requirement that forbids any of those is a misreading.

**What is asserted about the embedder, and what is not.** The in-process embedder satisfies (b): its model id, pinned revision, dtype, dimension and text recipe are all constants in the shipped image, and its identity is recorded on disk, which makes a stored vector a fixed function of the memory row. This requirement asserts nothing about bit-identical output — a quantised model may differ in the low bits of a float across hosts. What it constrains is which **inputs** a recipe may consume. A component whose output is not reproducible from (a) and (b), or whose weights are not in the shipped artifact, does not satisfy (b) however it is invoked.

**How this is checked, including the part that cannot be.** The classification, the presence of every named reproduction path, and the presence of every named version marker SHALL be asserted by the invariants suite against a freshly migrated schema, with completeness taken from `sqlite_master` rather than from a hand-maintained expected list: an assertion that tolerates unlisted tables is structurally incapable of detecting an unclassified one. Whether a *proposed* table's contents depend on an input outside (a) and (b) is a property of a proposal, not of a schema, and is therefore a **review gate**, not a test: a change introducing such a table SHALL amend this requirement in the same change folder as the evidence justifying it, so the amendment is visible in the diff. The suite SHALL NOT claim to check that clause.

**Why the property is load-bearing.** It is what makes the append-only corpus the only thing that must survive a restore, what makes index drift detectable rather than silent, and what makes a bad derivation retroactively correctable over an established corpus. It generalises the per-table derived-data rules already published for `memory_fts`, `memory_vec`, `memory_replaces` and the three entity tables, and it is the storage-layer counterpart of the derived-never-stored rule governing review state.

#### Scenario: An unclassified table fails the suite

- **GIVEN** the source/derived classification asserted by the invariants suite
- **WHEN** a migration adds a table that the classification does not name
- **THEN** the suite SHALL fail, naming the table
- **AND** completeness SHALL be taken from `sqlite_master`, so an assertion that merely tolerates unlisted tables SHALL NOT be relied on for this check

#### Scenario: Every derived table names a reproduction path that still exists

- **WHEN** the classification is read
- **THEN** each derived entry SHALL name its reproduction mechanism — a trigger set on its source table, or an exported rebuild entry point
- **AND** the suite SHALL fail when a named trigger is absent from `sqlite_master`, or a named entry point is no longer exported by the module the entry names

#### Scenario: Every release-variable recipe names an exported version marker

- **WHEN** the classification is read
- **THEN** each derived entry whose recipe can change between releases SHALL name its version-marker constant
- **AND** the suite SHALL fail when that constant is no longer exported

#### Scenario: Dropping every derived table loses no irreproducible information

- **WHEN** all derived tables are dropped
- **THEN** every memory's `title`, `content`, `tags`, `topic_key`, `status` and `replaces`, every `sessions.summary`, and every `confirmations.reason` and `memory_relations.reason` SHALL be unaffected
- **AND** each dropped table SHALL be reconstructible by its named reproduction path with no input beyond the database and the shipped image

#### Scenario: A recipe change re-derives the whole table rather than only new rows

- **GIVEN** a populated derived table whose recipe can change between releases
- **WHEN** the compiled-in recipe no longer matches the version marker on disk
- **THEN** the table SHALL be invalidated and re-derived from its source tables
- **AND** no row of any source table SHALL be modified by that re-derivation

#### Scenario: An index requiring a third input is a review gate, not a test

- **WHEN** a change proposes a derived table whose contents depend on a network call, an external service, an operator-supplied value, or any value not reproducible from the current source rows and the recipe pinned in the image
- **THEN** it SHALL NOT be introduced unless that same change folder amends this requirement and records the evidence justifying the amendment
- **AND** the obligation SHALL be documented as a review gate, because no test can decide it
