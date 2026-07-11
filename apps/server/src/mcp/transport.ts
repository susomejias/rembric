import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Session-scoped MCP transport manager.
 *
 * The Streamable HTTP transport supports session resumption via the
 * `mcp-session-id` request header. The MCP SDK requires a fresh
 * `McpServer` per connected transport, so we keep `(server, transport)`
 * pairs keyed by session id and instantiate a new pair on first contact.
 *
 * The factory receives the URL path slug (or null) for the connection so
 * the emitted `initialize.instructions` block matches the scope.
 */

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface ServerFactoryContext {
  requestedSlug: string | null;
}

export type ServerFactory = (ctx: ServerFactoryContext) => McpServer;

export interface McpTransportOptions {
  /** DNS-rebinding Host allow-list (opt-in; empty disables the Host check). */
  allowedHosts?: string[];
  /** DNS-rebinding Origin allow-list (opt-in; empty disables the Origin check). */
  allowedOrigins?: string[];
}

export class McpTransportManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly serverFactory: ServerFactory,
    private readonly options: McpTransportOptions = {},
  ) {}

  async getOrCreate(
    sessionId: string | undefined,
    factoryCtx: ServerFactoryContext,
  ): Promise<StreamableHTTPServerTransport> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) return existing.transport;
    }

    const server = this.serverFactory(factoryCtx);
    const allowedHosts = this.options.allowedHosts ?? [];
    const allowedOrigins = this.options.allowedOrigins ?? [];
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Defense-in-depth over the mandatory bearer: only engaged when an
      // allow-list is configured (opt-in), so non-browser MCP clients that
      // send no Origin/Host are unaffected by default.
      enableDnsRebindingProtection: allowedHosts.length > 0 || allowedOrigins.length > 0,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
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
