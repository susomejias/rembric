/**
 * MCP module barrel. The HTTP layer wires these together.
 */

export { createMcpServer } from './server.js';
export type { CreateMcpServerOptions } from './server.js';
export { McpTransportManager } from './transport.js';
export { mcpError } from './errors.js';
export { buildMemoryHandlers } from './memory-tools.js';
