import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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

  /** Whether a session id is a transport this manager already holds. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  close(): void {
    for (const { transport, server } of this.sessions.values()) {
      void transport.close();
      void server.close();
    }
    this.sessions.clear();
  }
}
