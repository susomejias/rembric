import type { Memory } from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { projectScope, SCOPE_GLOBAL, type Scope } from '../services/scope.js';

/**
 * Cross-cutting helpers shared by the MCP tool-handler modules. Defined once
 * here so the per-domain modules (`memory-tools`, `session-tools`,
 * `prompt-tools`, `observability-tools`) import rather than copy them.
 */

/**
 * Resolve the effective scope for a tool call from the request context.
 *
 * Precedence:
 *   1. `ctx.project` — set when the connection is path-scoped (`/mcp/<slug>`).
 *   2. For path-less `/mcp` connections (`ctx.requestedSlug === null`), the
 *      `SessionRouter` entry populated by a prior `project.use` or roots-based
 *      discovery.
 *   3. Global scope when neither source resolves a project.
 *
 * This is the synchronous resolver used by read/observability tools. The
 * memory write/CRUD path uses the async `resolveEffectiveProject`
 * (`memory-tools`), which additionally awaits roots discovery.
 */
export function scopeFromContext(deps: { router: SessionRouter }): Scope {
  const ctx = getRequestContext();
  if (ctx.project) return projectScope(ctx.project.id);
  if (ctx.requestedSlug !== null) return SCOPE_GLOBAL;
  if (ctx.mcpSessionId) {
    const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
    if (entry?.projectId) return projectScope(entry.projectId);
  }
  return SCOPE_GLOBAL;
}

export function routerKey(): { tokenId: string; mcpSessionId: string } | null {
  const ctx = getRequestContext();
  if (!ctx.mcpSessionId) return null;
  return { tokenId: ctx.token.id, mcpSessionId: ctx.mcpSessionId };
}

/**
 * Resolve the active Rembric session id for a write, in precedence order:
 *   1. an explicit `sessionId` arg,
 *   2. the `SessionRouter` entry for this transport (set by `memory.session_start`),
 *   3. the most recently-active session for `(tokenId, projectId)` — captures
 *      sessions created out-of-band by the plugin's HTTP hooks.
 * Returns null when none resolve. Shared by session_end/summary, save_prompt,
 * and capture_passive.
 */
export function resolveSessionId(
  deps: { router: SessionRouter; agentSessions: AgentSessionsService },
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit;
  const ctx = getRequestContext();
  const key = routerKey();
  if (key) {
    const routerHit = deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId;
    if (routerHit) return routerHit;
  }
  const scope = scopeFromContext(deps);
  const projectId = scope.kind === 'project' ? scope.projectId : null;
  const active = deps.agentSessions.findActiveForTransport({
    tokenId: ctx.token.id,
    projectId,
  });
  return active?.id ?? null;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}

export function serializeMemory(m: Memory) {
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    content: m.content,
    status: m.status,
    createdAt: m.createdAt,
    sessionId: m.sessionId,
  };
}
