/**
 * `@rembric/mcp` barrel — the package's public entry point, and the only import
 * surface consumers use (`apps/server` compiles and runs against `dist/`,
 * type-checks against `src/` via `paths`, and its tests against `src/` via the
 * vitest alias).
 *
 * Every non-test module is re-exported rather than a curated subset: the tool
 * modules, their handler factories and the schema/output shapes they export were
 * reachable by relative path before the move, so every one of them is part of
 * the contract this extraction has to keep. Module export names are unique
 * (asserted by the MCP tool-handler layout invariant), so an ambiguity would
 * fail loudly as TS2308 rather than silently drop an export.
 */

export * from './_shared.js';
export * from './about-tool.js';
export * from './errors.js';
export * from './instructions.js';
export * from './memory-tools.js';
export * from './observability-tools.js';
export * from './project-tools.js';
export * from './prompt-tools.js';
export * from './relations-tools.js';
export * from './result.js';
export * from './roots-discovery.js';
export * from './server.js';
export * from './session-tools.js';
export * from './topic-key.js';
export * from './transport.js';
