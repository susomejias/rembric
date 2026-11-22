## ADDED Requirements

### Requirement: The save-time lexical index MUST be one derived FTS5 table per project

Each project SHALL have its own derived full-text index, used only by save-time candidate detection. The global `memory_fts` SHALL remain the index for interactive search, the relevance level's term statistics and the dashboard.

- **Shape:** the index is an external-content FTS5 table named `memory_fts_p_<hex>`. `<hex>` is the lowercase hexadecimal encoding of the project id's UTF-8 bytes, so every distinct id has a distinct, safe identifier, and the id can be recovered from the name. The content table SHALL be a view named `memory_fts_p_<hex>_src` that selects that project's `memory` rows. The table's columns, and the tokenizer arguments it carries, SHALL be those of `memory_fts`.
- **Maintenance:** three triggers on `memory` SHALL maintain the index: one for insert, one for delete, and one for an update of `content`, `tags` or `title`. Each trigger SHALL be routed by a `WHEN` clause on the row's `project_id`. It SHALL write the same flattened tags that `memory_fts`'s triggers write. A row SHALL be indexed in its project's table before the inserting transaction commits.
- **Population:** building an index SHALL insert the project's existing rows with those same flattened tags, so that a built index equals one maintained by its triggers.
- **Creation:** inserting a project through the projects repository SHALL create its view, table and triggers in the caller's transaction. A save-time read for a project that has no index SHALL build the index before reading it.
- **Reproduction path:** a reconciler SHALL run after migrations and before the server serves. It SHALL:
  - build every project's index that is missing;
  - drop and rebuild every index whose stored DDL differs from the compiled recipe;
  - drop every object whose project no longer exists.

  The DDL is the recipe, so no version marker is required.
- **Classification:** these objects are derived. The source/derived classification SHALL classify them by the `memory_fts_p_` name pattern rather than by listing each one.

#### Scenario: A saved memory is indexed in its project's table only

- **GIVEN** two projects, each with its own save-time lexical index
- **WHEN** a memory is inserted into the first project
- **THEN** the first project's table SHALL match the memory's terms before the transaction commits
- **AND** the second project's table SHALL NOT match them

#### Scenario: A purge leaves no dangling posting in the project table

- **GIVEN** a memory indexed in its project's table
- **WHEN** the memory row is physically deleted by an allow-listed purge
- **THEN** the project's table SHALL NOT match any of that memory's terms, including its tag terms

#### Scenario: A project created outside the repository is indexed at boot

- **GIVEN** a project that has no save-time lexical index, such as the default project created by a SQL migration
- **WHEN** the server starts
- **THEN** the reconciler SHALL build that project's index from its existing rows before the first request is served

#### Scenario: A drifted recipe is re-derived

- **GIVEN** a project whose stored trigger DDL differs from the compiled recipe
- **WHEN** the server starts
- **THEN** the reconciler SHALL drop and recreate that project's objects and rebuild its table from `memory`

#### Scenario: A deleted project's objects are dropped

- **GIVEN** per-project index objects whose project row no longer exists
- **WHEN** the server starts
- **THEN** the reconciler SHALL drop every one of those objects

#### Scenario: An aborted project creation leaves no index behind

- **GIVEN** a transaction that inserts a project through the repository and then aborts
- **WHEN** the transaction rolls back
- **THEN** neither the project nor any of its index objects SHALL exist
- **AND** inserting the same project again SHALL create a working index
