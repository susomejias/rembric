import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Memory } from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import { projectScope, SCOPE_GLOBAL, type Scope } from '../services/scope.js';
import { sliceWithoutSplittingSurrogatePair } from '../services/strings.js';
import { isAuthorized } from '../services/tokens.js';

import { ensureRootsDiscoveryRun } from './roots-discovery.js';

/**
 * Cross-cutting helpers shared by the MCP tool-handler modules. Defined once
 * here so the per-domain modules (`memory-tools`, `session-tools`,
 * `prompt-tools`, `observability-tools`, `relations-tools`, `project-tools`)
 * import rather than copy them.
 */

export interface ScopeResolutionDeps {
  router?: SessionRouter;
  projects?: ProjectsService;
  getServer?: () => McpServer;
}

export interface EffectiveScope {
  scope: Scope;
  project: { id: string; slug: string } | null;
}

/**
 * Resolve the effective scope (and project) subsequent operations target.
 *
 * Sources, in order of precedence:
 *   1. `ctx.project` — set by the HTTP layer when the URL was `/mcp/<slug>`
 *      and the slug resolved to an existing project.
 *   2. `SessionRouter` entry — set by an explicit `project.use({slug})` or
 *      by roots-based discovery on a path-less `/mcp` connection.
 *   3. Global scope when neither source resolves a project.
 *
 * Before consulting source #2 on an unscoped connection, this helper
 * awaits any in-flight roots discovery (or triggers it lazily as a
 * fallback for clients that never emit `notifications/initialized`) so
 * the router is populated by the time we read it. Path-scoped
 * connections short-circuit on `ctx.requestedSlug`.
 */
export async function resolveEffectiveScope(deps: ScopeResolutionDeps): Promise<EffectiveScope> {
  const ctx = getRequestContext();
  if (ctx.project) return { scope: projectScope(ctx.project.id), project: ctx.project };
  if (ctx.requestedSlug !== null) return { scope: SCOPE_GLOBAL, project: null };
  if (!ctx.mcpSessionId || !deps.router || !deps.projects) {
    return { scope: SCOPE_GLOBAL, project: null };
  }
  if (deps.getServer) {
    await ensureRootsDiscoveryRun(
      { server: deps.getServer(), router: deps.router, projects: deps.projects },
      { tokenId: ctx.token.id, mcpSessionId: ctx.mcpSessionId, pathSlug: ctx.requestedSlug },
    );
  }
  const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
  const project = entry?.projectId ? (deps.projects.getById(entry.projectId) ?? null) : null;
  if (!project) return { scope: SCOPE_GLOBAL, project: null };
  return { scope: projectScope(project.id), project };
}

/**
 * Authorization gate every tool handler (except the data-free `memory.about`)
 * passes through: checks the request token's scope against the tool's
 * read/write classification and the target scope, throwing
 * `DomainError('forbidden')` on failure.
 */
export function assertAuthorized(action: 'read' | 'write', scope: Scope): void {
  const ctx = getRequestContext();
  const authorized = isAuthorized(ctx.scope, action, {
    scope: scope.kind,
    projectId: scope.kind === 'project' ? scope.projectId : null,
  });
  if (!authorized) {
    const target = scope.kind === 'project' ? `project '${scope.projectId}'` : 'global scope';
    throw new DomainError(
      'forbidden',
      `token scope '${ctx.scope}' does not authorize ${action} on ${target}`,
    );
  }
}

/** Resolve the effective scope and assert the token may `action` on it. */
export async function requireScope(
  deps: ScopeResolutionDeps,
  action: 'read' | 'write',
): Promise<Scope> {
  const { scope } = await resolveEffectiveScope(deps);
  assertAuthorized(action, scope);
  return scope;
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
 *   3. the UNAMBIGUOUS active session for `(tokenId, projectId)` — captures
 *      sessions created out-of-band by the plugin's HTTP hooks; returns
 *      nothing (never guesses by recency) when more than one is live — see
 *      `AgentSessionsService.findActiveForTransport`.
 * Returns null when none resolve. Shared by session_end/summary, save_prompt,
 * and capture_passive; `projectId` is the caller's already-resolved scope.
 *
 * By default, a resolved session id gets its activity clock bumped — for
 * save_prompt/capture_passive this is the ONLY write that touches the
 * session row. Pass `touch: false` when the caller is about to write to the
 * session row itself (session_end/session_summary both stamp
 * `last_activity_at` as part of their own update), so the row isn't
 * UPDATEd twice for one request.
 */
export function resolveSessionId(
  deps: { router: SessionRouter; agentSessions: AgentSessionsService },
  explicit: string | undefined,
  projectId: string | null,
  opts: { touch?: boolean } = {},
): string | null {
  const touch = opts.touch ?? true;
  if (explicit) {
    if (touch) deps.agentSessions.touchActivity(explicit);
    return explicit;
  }
  const ctx = getRequestContext();
  const key = routerKey();
  if (key) {
    const routerHit = deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId;
    if (routerHit) {
      if (touch) deps.agentSessions.touchActivity(routerHit);
      return routerHit;
    }
  }
  const active = deps.agentSessions.findActiveForTransport({
    tokenId: ctx.token.id,
    projectId,
  });
  if (active && touch) deps.agentSessions.touchActivity(active.id);
  return active?.id ?? null;
}

export function assertExplicitSessionOwned(
  agentSessions: AgentSessionsService,
  sessionId: string,
  projectId: string | null,
): void {
  const ctx = getRequestContext();
  const row = agentSessions.getById(sessionId);
  if (!row || row.tokenId !== ctx.token.id || row.projectId !== projectId) {
    throw new DomainError('session_not_found', `session '${sessionId}' not found`);
  }
  if (row.deletedAt) {
    throw new DomainError(
      'session_deleted',
      `session '${sessionId}' was soft-deleted at ${row.deletedAt.toISOString()}; ` +
        `ask an operator to undelete it before attaching writes to it`,
    );
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}

/**
 * Bound each judged annotation's `reason` for a MULTI-ROW projection.
 *
 * A read projection only — `memory_relations.reason` keeps the full stored text,
 * which append-only requires and which single-id `memory.get` still returns
 * verbatim as the drill-down destination.
 *
 * Lives here rather than in the service because services never import from `mcp/`
 * and the per-surface difference is a presentation decision. One helper, so the two
 * multi-row call sites cannot drift.
 */
export function boundAnnotationReasons<T extends { reason?: string | null }>(
  views: readonly T[],
  max: number,
): T[] {
  return views.map((v) =>
    typeof v.reason === 'string' && v.reason.length > max
      ? // Surrogate-safe, unlike a bare `snippet`: a raw cut at `max - 1` can leave a
        // lone high surrogate that every client decodes to U+FFFD, so the bounded
        // value would not be a prefix of the stored text in DECODED terms.
        { ...v, reason: sliceWithoutSplittingSurrogatePair(v.reason, max - 1) + '…' }
      : v,
  );
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
