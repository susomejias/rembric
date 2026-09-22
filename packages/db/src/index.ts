/**
 * `@rembric/db` barrel — the package's public entry point.
 *
 * The named `export *` list below is deliberate: every symbol those modules
 * export is part of the contract, and an ambiguity fails loudly as TS2308
 * rather than silently dropping an export.
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
