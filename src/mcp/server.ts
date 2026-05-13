import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { MemoryService } from '../services/memory.js';

import {
  buildHandlers,
  memoryConfirmSchema,
  memoryGetSchema,
  memorySaveSchema,
  memorySearchSchema,
} from './tools.js';

/**
 * Construct the MCP server and register the four memory tools. The server
 * is request-stateless: per-request data (token, project) is carried in
 * AsyncLocalStorage by the HTTP layer.
 */

export interface CreateMcpServerOptions {
  memory: MemoryService;
  /** Reported as the MCP server name and version on handshake. */
  name?: string;
  version?: string;
}

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer({
    name: opts.name ?? 'rembric',
    version: opts.version ?? '0.0.0',
  });

  const handlers = buildHandlers({ memory: opts.memory });

  server.tool(
    'memory.save',
    'Save a new memory. Scope defaults to project; set scope=global for a user-wide memory.',
    memorySaveSchema,
    handlers.save,
  );

  server.tool(
    'memory.search',
    'Search memories by FTS5 keyword query and/or filters. Scoped to the project carried in X-Rembric-Project (plus globals by default).',
    memorySearchSchema,
    handlers.search,
  );

  server.tool(
    'memory.get',
    'Retrieve a memory by id, including its predecessor chain (replaces) and confirmation count.',
    memoryGetSchema,
    handlers.get,
  );

  server.tool(
    'memory.confirm',
    'Record a confirmation event for the head of the supersedes chain reachable from this id.',
    memoryConfirmSchema,
    handlers.confirm,
  );

  return server;
}
