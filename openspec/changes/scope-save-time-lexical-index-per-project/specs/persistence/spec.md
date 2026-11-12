## ADDED Requirements

### Requirement: The save-time lexical index MUST be one derived FTS5 table per project

Each project SHALL have its own derived full-text index, used only by save-time candidate detection. The global `memory_fts` SHALL remain the index for interactive search, the relevance level's term statistics and the dashboard.

> Draft (Phase 1). This change proposes it and has measured it, but it is not yet approved for implementation. See the change's design D1 and D3–D5.

- **Shape:** an external-content FTS5 table named `memory_fts_p_<id>`, where `<id>` is the project id lowercased. The id SHALL match `^[0-9a-z]{26}$` after lowercasing, or the table SHALL NOT be created. Its content table SHALL be a view `memory_fts_p_<id>_src` selecting that project's `memory` rows. Its columns and tokenizer arguments SHALL be those of `memory_fts`.
- **Maintenance:** three triggers on `memory` SHALL maintain it, one each for insert, delete and update of `content`, `tags` or `title`. Each trigger SHALL be routed by a `WHEN` clause on the row's `project_id`, and SHALL pass the same flattened tags `memory_fts`'s triggers pass. A row SHALL be indexed in its project's table before the inserting transaction commits.
- **Creation:** creating a project SHALL create its view, table and triggers in the same transaction as the project row.
- **Reproduction path:** a reconciler SHALL run after migrations and before the server serves. It SHALL recreate and rebuild any project's objects that are missing, or whose stored DDL differs from the compiled recipe. The DDL is the recipe, so no version marker is required.
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

#### Scenario: A creation path that misses the project is repaired at boot

- **GIVEN** a project that has no save-time lexical index, such as the default project created by a SQL migration
- **WHEN** the server starts
- **THEN** the reconciler SHALL create and rebuild that project's index before the first request is served

#### Scenario: A drifted recipe is re-derived

- **GIVEN** a project whose stored trigger DDL differs from the compiled recipe
- **WHEN** the server starts
- **THEN** the reconciler SHALL drop and recreate that project's objects and rebuild its table from `memory`
