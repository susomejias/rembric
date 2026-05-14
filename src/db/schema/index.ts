/**
 * Drizzle schema barrel. drizzle-kit reads this entry to discover all
 * tables. Per-table files own their indexes and exported types.
 */

export * from './memory.js';
export * from './projects.js';
export * from './confirmations.js';
export * from './consolidation.js';
export * from './tokens.js';
export * from './sessions.js';
export * from './agent-sessions.js';
export * from './prompts.js';
export * from './memory-relations.js';
