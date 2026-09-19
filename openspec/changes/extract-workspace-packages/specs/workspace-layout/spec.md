## ADDED Requirements

### Requirement: Workspace package inventory

The workspace SHALL expose extracted code as pnpm workspace members under `packages/`, each declaring its own `package.json` and `tsconfig.json` and owning exactly one surface: `packages/db` owns the SQL confinement boundary (schema, migrations, migration runner, client, diagnostics, query tokenizer and repositories); `packages/core` owns the services, consolidation and embeddings layers; `packages/mcp` owns the MCP tools, server factory and transport manager; `packages/ui` owns shared React components and is scaffold-only in this change, with no dependents until the view port. `apps/server` SHALL retain the dashboard and HTTP surfaces it owns today and SHALL consume the extracted packages through their public entry points. No file SHALL live in a package without belonging to that package's stated surface.

#### Scenario: Extracted code exists as a workspace member

- **WHEN** `pnpm-workspace.yaml` and the root lockfile are inspected after this change
- **THEN** `packages/db`, `packages/core`, `packages/mcp` and `packages/ui` SHALL each be a declared workspace member carrying its own `package.json` and `tsconfig.json`

#### Scenario: A package owns only its stated surface

- **WHEN** a file is placed under `packages/core/src/`
- **THEN** it SHALL be a service, consolidation or embedding module, and SHALL NOT be a repository, a migration or an MCP tool definition

### Requirement: Tooling configuration package

Shared build and lint configuration SHALL live in `packages/config` as a development-only workspace member: a base TypeScript configuration and a shared ESLint configuration consumed by every other package and by `apps/server`. `packages/config` SHALL emit no build output and SHALL NOT be imported at runtime by any package or application.

#### Scenario: Packages extend the shared base configuration

- **WHEN** a package's `tsconfig.json` is inspected
- **THEN** it SHALL extend the base configuration from `packages/config` rather than restating compiler options

#### Scenario: The configuration package has no runtime consumers

- **WHEN** the dependency graph is inspected
- **THEN** no package or application SHALL declare `packages/config` as a runtime dependency, and `packages/config` SHALL produce no `dist` output

### Requirement: SQL confinement holds for any number of packages

Exactly one package, `packages/db`, SHALL execute SQL. No other package, and no application file outside `packages/db/src/`, SHALL contain SQL execution — Drizzle query-builder calls, the drizzle-orm `sql` template tag, or raw better-sqlite3 statement APIs. This requirement SHALL hold regardless of how many workspace packages exist: package extraction SHALL NOT relax the confinement boundary by making it plural or path-shaped, and a new package SHALL NOT become a second SQL boundary by virtue of existing.

#### Scenario: A second SQL boundary is rejected

- **WHEN** any non-test file outside `packages/db/src/` contains a SQL-execution pattern
- **THEN** the invariants suite SHALL fail naming the offending file, even when that file lives in a package other than `packages/db`

#### Scenario: Package count does not change the boundary

- **WHEN** the workspace contains more than one package
- **THEN** the confinement guard SHALL still name exactly `packages/db` as the single permitted SQL location, and SHALL NOT accept a list of permitted locations

### Requirement: Packages import only public entry points

A workspace package SHALL import another package only through that package's declared public entry point, as resolved by its `exports` map. A package SHALL NOT import another package's internal modules by relative or deep path, and SHALL NOT reach into another package's `src/`, `dist/` or configuration files directly.

#### Scenario: Deep import across a package boundary is rejected

- **WHEN** a file in one package imports a module path that reaches past another package's public entry point into its internals
- **THEN** the change is invalid and the import SHALL be rewritten to the consumer-facing entry point

#### Scenario: Public entry points resolve from a consumer

- **WHEN** `apps/server` imports `@rembric/db`
- **THEN** the import SHALL resolve through `packages/db`'s declared `exports` map to built output, without naming an internal file

### Requirement: Consumers build after their dependencies

Each package SHALL own a build script emitting its own output, and the workspace task graph SHALL enforce that a consumer's build runs after its dependencies' builds. Build order SHALL be declared in configuration and SHALL NOT rely on incidental script ordering.

#### Scenario: Dependency build precedes the consumer build

- **WHEN** the workspace build task runs from the repository root
- **THEN** the builds of `packages/db`, `packages/core` and `packages/mcp` SHALL complete before the `apps/server` build starts, as declared by the task graph

#### Scenario: A stale dependency output blocks its consumer

- **WHEN** a dependency package has no build output and its consumer's build is requested
- **THEN** the dependency SHALL be built first, and the consumer SHALL NOT typecheck or compile against missing or stale output

### Requirement: Every package typechecks independently

Each package SHALL declare its own `tsconfig.json` and expose a typecheck script that runs a no-emit typecheck over that package's own files. Typechecking a package SHALL NOT depend on `apps/server/tsconfig.json`, and SHALL NOT require the application's `rootDir` to cover files outside its own directory.

#### Scenario: A single package typechecks in isolation

- **WHEN** the typecheck script for one extracted package is run on its own
- **THEN** it SHALL exit successfully without typechecking files belonging to another package or to `apps/server`

#### Scenario: No package depends on the application tsconfig

- **WHEN** a package's `tsconfig.json` is inspected
- **THEN** it SHALL extend the shared base configuration and SHALL NOT extend or include `apps/server/tsconfig.json`

### Requirement: Database path resolution is unchanged and logged at startup

This change SHALL NOT alter how `REMBRIC_DATA_DIR` or the `data.db` filename resolve. The resolved absolute database path and whether the database file already existed SHALL be logged at startup, converting a silent empty-database failure into a visible signal. The log emission SHALL occur for both the fresh-file and the pre-existing-file cases, and SHALL be visible in container logs.

#### Scenario: Resolution is byte-identical to the pre-change behaviour

- **WHEN** the server starts with `REMBRIC_DATA_DIR` set to a given value
- **THEN** the resolved absolute database path SHALL be the same path the pre-change code would have opened for that value, and the filename SHALL remain `data.db`

#### Scenario: Startup reports the resolved path and file provenance

- **WHEN** the server starts, whether or not the database file already exists
- **THEN** it SHALL log the resolved absolute database path together with whether the file pre-existed, and a test SHALL assert both the fresh and pre-existing cases

### Requirement: Migration discovery is proven equivalent and filenames are immutable

Migration discovery SHALL be proven equivalent across the move: a test SHALL assert that the set of discovered `*.sql` migration files — count, filenames and content hashes — is identical before and after the relocation. Migration filenames SHALL NOT change, because the `_migrations` table records the filename only and a renamed file is re-applied. Only a migration file's directory MAY change.

#### Scenario: Discovery equivalence is asserted

- **WHEN** the migration-discovery equivalence test compares the discovered `*.sql` set across the move
- **THEN** the count, every filename and every content hash SHALL match, and a mismatch SHALL fail the test

#### Scenario: A renamed migration is rejected

- **WHEN** any migration file under `packages/db/src/migrations/` has a filename differing from its pre-move name
- **THEN** the equivalence test SHALL fail, because `_migrations` keys on filename and a rename causes re-application

### Requirement: Production image preserves the data volume contract

The production image SHALL preserve `ENV REMBRIC_DATA_DIR=/data` and `VOLUME ["/data"]`, and the runtime user SHALL retain read and write access to that path. The container SHALL NOT create an empty database in its ephemeral layer when a volume is mounted at the expected path. The image SHALL be verified by an operator-only smoke that mounts a seeded volume and reads a known row back through the running container.

#### Scenario: The image keeps the volume environment and mount

- **WHEN** the produced image's configuration is inspected
- **THEN** it SHALL declare `ENV REMBRIC_DATA_DIR=/data` and `VOLUME ["/data"]`, and the runtime user SHALL be able to read and write that path

#### Scenario: Seeded volume smoke returns a known row

- **WHEN** an operator runs the seeded-volume smoke against the image, mounting a volume seeded with a known row
- **THEN** the running container SHALL read that known row back, and SHALL NOT report or serve an empty database

### Requirement: apps/web and apps/server never share a data directory

`apps/web` and `apps/server` SHALL NEVER point at the same `REMBRIC_DATA_DIR` simultaneously. They SHALL use separate directories and separate ports, and every local smoke that exercises either application SHALL run against a copy of the database, never the live data directory.

#### Scenario: Two running applications use distinct directories

- **WHEN** `apps/web` and `apps/server` are running at the same time
- **THEN** their resolved `REMBRIC_DATA_DIR` values SHALL differ

#### Scenario: Smokes run against a copy

- **WHEN** a local smoke exercises an application's database
- **THEN** it SHALL point at a copy of the data directory and SHALL NOT open the live data directory

### Requirement: Snapshot before migrating a real data directory

Before any migration runs against a real data directory, a `VACUUM INTO` snapshot SHALL be taken. The snapshot SHALL use the `VACUUM INTO` primitive and SHALL NEVER be a plain file copy, because the connection runs in WAL mode and committed transactions live in the write-ahead log alongside the database file.

#### Scenario: Snapshot precedes migration

- **WHEN** the new code is about to apply migrations against a real data directory
- **THEN** a `VACUUM INTO` snapshot SHALL have been taken first, and its path SHALL be recorded

#### Scenario: A file copy is not an acceptable snapshot

- **WHEN** a snapshot of the WAL-mode database is produced
- **THEN** it SHALL be produced by `VACUUM INTO`, and copying only the database file SHALL be treated as an incomplete snapshot that omits committed transactions

### Requirement: No destructive migration and no migration file edits

This change SHALL introduce no destructive migration and SHALL NOT edit, renumber or rename any migration file. Migration content SHALL be byte-identical before and after the change; only the directory holding the files MAY differ. No migration SHALL drop or rewrite data.

#### Scenario: Migration files are untouched

- **WHEN** the migration directory and its contents are compared before and after this change
- **THEN** every file SHALL be byte-identical, with no file added, removed, edited, renumbered or renamed

#### Scenario: No destructive statement is introduced

- **WHEN** this change's diff is reviewed for data-affecting SQL
- **THEN** it SHALL contain no table drop, no destructive delete and no data-rewriting statement
