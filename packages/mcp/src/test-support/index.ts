/**
 * Test fixtures barrel. Imported as `from './test-support/index.js'` by the
 * co-located `*.test.ts` suites in this package. Carries only the fixtures the
 * MCP suites reach for; add an export here when a suite newly needs one.
 */

export { createTestDb } from './db.js';
export type { TestDb } from './db.js';
export { defaultProject, defaultProjectScope, seedProject } from './default-project.js';
export { mintTestToken } from './tokens.js';
export { logInternalError } from './test-logger.js';
