/**
 * `@rembric/db` barrel — the package's public entry point, and the only import
 * surface consumers use (`apps/server` compiles and runs against `dist/`, and
 * type-checks and tests against `src/` — see the package README).
 *
 * The named `export *` list below is deliberate: consumers used to reach into
 * `db/schema/<table>.js`, `db/repositories/<aggregate>-repository.js` and
 * `db/diagnostics.js` directly, so every symbol those modules export is part of
 * the contract this move has to keep. Keep it that way — an ambiguity here
 * fails loudly as TS2308 rather than silently dropping an export.
 */

export { createDb, defaultMigrationsDir } from './client.js';
export type { Db, DbHandle, CreateDbOptions, TransactionRunner } from './client.js';
export { migrate, splitStatements } from './migrate.js';
export type { MigrateOptions, MigrateResult } from './migrate.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
export * from './repositories/index.js';
export * from './repositories/scope-clause.js';
export type { QueryTermFrequencies } from './repositories/term-statistics-repository.js';
export * from './diagnostics.js';
export * as diagnostics from './diagnostics.js';
export * from './data-loss-guard.js';
export * from './query-tokenizer.js';
export * from './scope.js';
