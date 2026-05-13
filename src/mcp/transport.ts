import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Session-scoped MCP transport manager.
 *
 * The Streamable HTTP transport supports session resumption via the
 * `mcp-session-id` request header. The MCP SDK requires a fresh
 * `McpServer` per connected transport (a server cannot be re-connected
 * once attached), so we keep `(server, transport)` pairs keyed by
 * session id and instantiate a new pair on first contact.
 */

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export class McpTransportManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly serverFactory: () => McpServer) {}

  async getOrCreate(sessionId: string | undefined): Promise<StreamableHTTPServerTransport> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) return existing.transport;
    }

    const server = this.serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { server, transport });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    return transport;
  }

  close(): void {
    for (const { transport, server } of this.sessions.values()) {
      void transport.close();
      void server.close();
    }
    this.sessions.clear();
  }
}
