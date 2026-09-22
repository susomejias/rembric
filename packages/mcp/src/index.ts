/**
 * `@rembric/mcp` barrel — the package's public entry point.
 *
 * Every non-test module is re-exported rather than a curated subset: the tool
 * modules, their handler factories and the schema/output shapes they export are
 * all part of the contract. Module export names are unique (asserted by the MCP
 * tool-handler layout invariant), so an ambiguity would fail loudly as TS2308
 * rather than silently drop an export.
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
