import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Memory } from '../db/schema/memory.js';
import { getRequestContext, type RequestContext } from '../server/request-context.js';
import type { ProjectResolutionSource, SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import { projectScope, type Scope } from '../services/scope.js';
import { sliceWithoutSplittingSurrogatePair } from '../services/strings.js';
import { isAuthorized, isProjectSetScope, pinnedProjectId } from '../services/tokens.js';

import { ensureRootsDiscoveryRun } from './roots-discovery.js';

/**
 * Cross-cutting helpers shared by the MCP tool-handler modules. Defined once
 * here so the per-domain modules (`memory-tools`, `session-tools`,
 * `prompt-tools`, `observability-tools`, `relations-tools`, `project-tools`)
 * import rather than copy them.
 */

export interface ScopeResolutionDeps {
  router?: SessionRouter;
  projects: ProjectsService;
  getServer?: () => McpServer;
}

export interface EffectiveScope {
  scope: Scope;
  project: { id: string; slug: string } | null;
  /**
   * Which branch below resolved the project. `'default'` is a fallback rather
   * than an activation, and callers that record or report provenance MUST
   * treat it as one.
   */
  source: ProjectResolutionSource;
}

/**
 * The refusal a path slug naming no project earns. One place, so the resolver
 * and `memory.save`'s pre-resolver guard cannot drift in wording or payload.
 */
export function unresolvableSlugError(slug: string, projects: ProjectsService): DomainError {
  return new DomainError(
    'project_not_found',
    `project '${slug}' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})`,
    { suggestedSlugs: projects.findSimilarSlugs(slug) },
  );
}

/**
 * Resolve the effective scope (and project) subsequent operations target.
 *
 * Sources, in order of precedence:
 *   1. `ctx.project` — set by the HTTP layer when the URL was `/mcp/<slug>`
 *      and the slug resolved to an existing project.
 *   2. `SessionRouter` entry — set by an explicit `project.use({slug})` or
 *      by roots-based discovery on a path-less `/mcp` connection.
 *   3. The default project, reachable only from a path-LESS connection: a URL
 *      slug that names no project is a caller asking to be confined to
 *      something that does not exist, so it throws `project_not_found` rather
 *      than answering with somebody else's project.
 *
 * There is no fourth source and no scopeless outcome — every authenticated
 * connection resolves to exactly one project.
 *
 * Before consulting source #2 on an unscoped connection, this helper
 * awaits any in-flight roots discovery (or triggers it lazily as a
 * fallback for clients that never emit `notifications/initialized`) so
 * the router is populated by the time we read it. Path-scoped
 * connections short-circuit on `ctx.requestedSlug`.
 */
export async function resolveEffectiveScope(deps: ScopeResolutionDeps): Promise<EffectiveScope> {
  const ctx = getRequestContext();
  if (ctx.project)
    return { scope: projectScope(ctx.project.id), project: ctx.project, source: 'url-path' };
  if (ctx.requestedSlug !== null) throw unresolvableSlugError(ctx.requestedSlug, deps.projects);
  if (!ctx.mcpSessionId || !deps.router) return defaultProjectScope(deps.projects);
  if (deps.getServer) {
    await ensureRootsDiscoveryRun(
      { server: deps.getServer(), router: deps.router, projects: deps.projects },
      { tokenId: ctx.token.id, mcpSessionId: ctx.mcpSessionId, pathSlug: ctx.requestedSlug },
    );
  }
  const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
  const project = entry?.projectId ? (deps.projects.getById(entry.projectId) ?? null) : null;
  if (!entry || !project) return defaultProjectScope(deps.projects);
  return {
    scope: projectScope(project.id),
    project,
    source: entry.projectResolutionSource,
  };
}

/**
 * The fallback every path-less connection lands on. Sole construction site for
 * the default project's scope, so a handler cannot resolve it differently from
 * the resolver.
 */
function defaultProjectScope(projects: ProjectsService): EffectiveScope {
  const project = projects.getDefault();
  return { scope: projectScope(project.id), project, source: 'default' };
}

/**
 * `resolveEffectiveScope` for the one caller that must survive a slug naming no
 * project: `project.current` is how an agent diagnoses such a connection, so it
 * reports the absent scope instead of refusing with `project_not_found`.
 */
export async function resolveEffectiveScopeOrNull(
  deps: ScopeResolutionDeps,
): Promise<EffectiveScope | null> {
  if (unresolvableSlug() !== null) return null;
  return resolveEffectiveScope(deps);
}

/**
 * A slug in the URL, whether or not it resolved to an existing project: an
 * unresolvable slug is still a caller asking to be confined to one.
 */
export function isPathScoped(): boolean {
  return getRequestContext().requestedSlug !== null;
}

/**
 * The URL slug when it named no project, else null. The narrower half of
 * `isPathScoped`, which cannot distinguish the two.
 */
export function unresolvableSlug(): string | null {
  const ctx = getRequestContext();
  return ctx.project ? null : ctx.requestedSlug;
}

/** Non-throwing sibling of `assertAuthorized`, so both derive the target descriptor identically. */
export function isAuthorizedFor(action: 'read' | 'write', scope: Scope): boolean {
  const ctx = getRequestContext();
  return isAuthorized(ctx, action, { scope: 'project', projectId: scope.projectId });
}

/**
 * The one-call way in for a token denied an action on a path-less connection
 * that resolved to a project it does not reach. Empty when no `project.use`
 * could change the answer. Does the connection guard once and picks the
 * message builder that fits the token's reach.
 */
function remedyFor(ctx: RequestContext, scope: Scope, projects: ProjectsService): string {
  // A path-scoped connection would have `project.use` refused as `scope_locked`.
  if (ctx.requestedSlug !== null) return '';
  const pinned = pinnedProjectId(ctx.scope);
  if (pinned !== null) return pinRemedy(pinned, scope, projects);
  if (isProjectSetScope(ctx.scope)) return setRemedy(ctx.memberProjectIds, scope, projects);
  return '';
}

/** For a token pinned to one project and denied a DIFFERENT one. */
function pinRemedy(pinned: string, scope: Scope, projects: ProjectsService): string {
  // Re-activating the scope already active cannot change the answer.
  if (scope.kind === 'project' && scope.projectId === pinned) return '';
  // A token row predating the enforced project binding carries a SLUG here
  // rather than an id (`db/schema/tokens.ts:35-37`), so it resolves to no
  // project row and the string itself is already the slug to name.
  const slug = projects.getById(pinned)?.slug ?? pinned;
  return (
    `; this token is pinned to project '${slug}' — call project.use({slug: '${slug}'}) ` +
    `or reconnect at '/mcp/${slug}'`
  );
}

/**
 * The same for a set-scoped token denied a project outside its set. Names EVERY
 * member: naming one arbitrary member would read as the whole reach. Empty when
 * the denied project is itself a member, because then the refusal is the access
 * verb and no `project.use` changes it.
 */
function setRemedy(
  memberProjectIds: readonly string[],
  scope: Scope,
  projects: ProjectsService,
): string {
  if (scope.kind === 'project' && memberProjectIds.includes(scope.projectId)) return '';
  const slugs = memberProjectIds
    .map((id) => projects.getById(id)?.slug)
    .filter((slug): slug is string => slug !== undefined)
    .sort();
  const first = slugs[0];
  if (first === undefined) return '';
  const named = slugs.map((slug) => `'${slug}'`).join(', ');
  return (
    `; this token reaches ${slugs.length === 1 ? 'project' : 'projects'} ${named} — ` +
    `call project.use({slug: '${first}'}) or reconnect at '/mcp/${first}'`
  );
}

/**
 * Authorization gate every tool handler (except the data-free `memory.about`)
 * passes through: checks the request token's scope against the tool's
 * read/write classification and the target scope, throwing
 * `DomainError('forbidden')` on failure.
 */
export function assertAuthorized(
  action: 'read' | 'write',
  scope: Scope,
  deps: Pick<ScopeResolutionDeps, 'projects'>,
): void {
  const ctx = getRequestContext();
  if (!isAuthorizedFor(action, scope)) {
    const target = `project '${scope.projectId}'`;
    throw new DomainError(
      'forbidden',
      `token scope '${ctx.scope}' does not authorize ${action} on ${target}` +
        remedyFor(ctx, scope, deps.projects),
    );
  }
}

/** Resolve the effective scope and assert the token may `action` on it. */
export async function requireScope(
  deps: ScopeResolutionDeps,
  action: 'read' | 'write',
): Promise<Scope> {
  const { scope } = await resolveEffectiveScope(deps);
  assertAuthorized(action, scope, deps);
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
