import type { McpTransportManager } from '../mcp/transport.js';
import { TRANSPORT_STALENESS_MS, type AgentSessionsService } from '../services/agent-sessions.js';

import type { SessionRouter } from './session-router.js';

export interface TransportStateReaperDeps {
  router: SessionRouter;
  mcpTransport: McpTransportManager;
  agentSessions: AgentSessionsService;
  now?: () => Date;
}

export interface TransportStateReaperResult {
  routerEvicted: number;
  transportsEvicted: number;
}

/**
 * The single predicate and pass for both per-transport registries (`sessions`
 * capability: "Per-transport in-process state MUST be evicted once its
 * transport is stale"). Router state and transport state are evicted
 * together or not at all — a lone router eviction would misscope a still-
 * live connection, since `resolveEffectiveScope` falls back to the default
 * project on a missing entry rather than refusing.
 */
export function runTransportStateReaperPass(
  deps: TransportStateReaperDeps,
): TransportStateReaperResult {
  const { router, mcpTransport, agentSessions } = deps;
  const now = deps.now ?? (() => new Date());
  let routerEvicted = 0;
  let transportsEvicted = 0;

  // Orphan clause, no window: a router entry whose transport is already gone
  // cannot influence any future resolution.
  for (const entry of router.entriesForEviction()) {
    if (!mcpTransport.has(entry.mcpSessionId)) {
      routerEvicted += router.evictTransport(entry.mcpSessionId);
    }
  }

  for (const transport of mcpTransport.entries()) {
    const requestClockStale = now().getTime() - transport.lastSeenAt >= TRANSPORT_STALENESS_MS;
    if (!requestClockStale) continue;

    const ownEntries = [...router.entriesForEviction()].filter(
      (entry) => entry.mcpSessionId === transport.mcpSessionId,
    );
    const protectedByLiveSession = ownEntries.some((entry) =>
      agentSessions.hasLiveSessionForTransport({
        tokenId: entry.tokenId,
        projectId: entry.projectId,
      }),
    );
    if (protectedByLiveSession) continue;

    routerEvicted += router.evictTransport(transport.mcpSessionId);
    if (mcpTransport.evict(transport.mcpSessionId)) transportsEvicted++;
  }

  return { routerEvicted, transportsEvicted };
}
