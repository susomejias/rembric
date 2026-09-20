# @rembric/db

The SQLite data layer: Drizzle schema, one repository per aggregate, the
migration runner, DB-level diagnostics, and `migrations/*.sql`.

**This package is the SQL-confinement boundary.** Every SQL-executing file in
the repository lives under `src/`; the guard in
`apps/server/src/test/invariants.test.ts` fails the suite on SQL anywhere else.

## Migrations are immutable

`src/migrations/*.sql` filenames are primary keys in the `_migrations` table —
the runner records the **filename**, so renaming a file makes it re-apply.
Never rename, renumber or edit an applied migration. New schema changes are a
new numbered file.

The build copies `src/migrations/` → `dist/migrations/` byte-for-byte (the
second half of the `build` script), because `defaultMigrationsDir()` resolves
the directory next to the loaded `client.js`. The DS2 test in
`invariants.test.ts` asserts both sets are identical and that every filename
matches the numbered pattern.

## Commands

| Command                                     | What it does                                                     |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm --filter @rembric/db run build`       | `tsc -p tsconfig.build.json`, then copies the migrations to dist |
| `pnpm --filter @rembric/db run typecheck`   | `tsc --noEmit`                                                   |
| `pnpm --filter @rembric/db run db:generate` | `drizzle-kit generate` **writes** a new migration file           |
| `pnpm --filter @rembric/db run db:check`    | `drizzle-kit check`                                              |

`db:generate` / `db:check` read `drizzle.config.ts` from this package — that is
why they moved out of `apps/server`.

## Consumers

Consumers import the package root (`@rembric/db`), which maps to the built
`dist/` through the `exports` map. `apps/server` type-checks and runs tests
against `src/` (tsconfig `paths` + the vitest alias) and compiles and runs
against `dist/`, so a cold checkout needs `pnpm --filter @rembric/db run build`
before the server's own `build`.
