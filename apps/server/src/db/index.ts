/**
 * Database barrel. Importers use only this entrypoint so the underlying
 * driver / migration mechanics stay encapsulated.
 */

export { createDb } from './client.js';
export type { Db, DbHandle, CreateDbOptions } from './client.js';
export { migrate } from './migrate.js';
export type { MigrateOptions, MigrateResult } from './migrate.js';
export * as schema from './schema/index.js';
export * from './repositories/index.js';
export * as diagnostics from './diagnostics.js';
