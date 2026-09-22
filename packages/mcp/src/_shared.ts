import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSessionsService } from '@rembric/core';
import type { ProjectsService, ProjectView } from '@rembric/core';
import type { ProjectResolutionSource, SessionRouter } from '@rembric/core';
import { DomainError } from '@rembric/core';
import { sliceWithoutSplittingSurrogatePair } from '@rembric/core';
import { isAuthorized, isProjectSetScope, pinnedProjectId } from '@rembric/core';
import { getRequestContext, type RequestContext } from '@rembric/core';
import { tryGetToolCallId } from '@rembric/core';
import { projectScope, type Memory, type Scope, type SearchScope } from '@rembric/db';

import { ensureRootsDiscoveryRun } from './roots-discovery.js';

export interface ScopeResolutionDeps {
  router?: SessionRouter;
  projects: ProjectsService;
  getServer?: () => McpServer;
}

export interface EffectiveScope {
  scope: Scope;
  project: { id: string; slug: string } | null;
  source: ProjectResolutionSource;
}

export function unresolvableSlugError(slug: string, projects: ProjectsService): DomainError {
  return new DomainError(
    'project_not_found',
    `project '${slug}' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})`,
    { suggestedSlugs: projects.findSimilarSlugs(slug) },
  );
}

export async function resolveEffectiveScope(deps: ScopeResolutionDeps): Promise<EffectiveScope> {
  const ctx = getRequestContext();
  if (ctx.project)
    return { scope: projectScope(ctx.project.id), project: ctx.project, source: 'url-path' };
  if (ctx.requestedSlug !== null) throw unresolvableSlugError(ctx.requestedSlug, deps.projects);
  if (!ctx.mcpSessionId || !deps.router) return defaultProjectScope(deps.projects);
  if (deps.getServer) {
    await ensureRootsDiscoveryRun(
      { server: deps.getServer(), router: deps.router, projects: deps.projects },
      {
        tokenId: ctx.token.id,
        mcpSessionId: ctx.mcpSessionId,
        pathSlug: ctx.requestedSlug,
        toolCallRequestId: tryGetToolCallId(),
      },
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

function defaultProjectScope(projects: ProjectsService): EffectiveScope {
  const project = projects.getDefault();
  return { scope: projectScope(project.id), project, source: 'default' };
}

export async function resolveEffectiveScopeOrNull(
  deps: ScopeResolutionDeps,
): Promise<EffectiveScope | null> {
  if (unresolvableSlug() !== null) return null;
  return resolveEffectiveScope(deps);
}

export function isPathScoped(): boolean {
  return getRequestContext().requestedSlug !== null;
}

export function unresolvableSlug(): string | null {
  const ctx = getRequestContext();
  return ctx.project ? null : ctx.requestedSlug;
}

export function readableProjects(
  projects: ProjectsService,
  includeArchived: boolean,
): ProjectView[] {
  const ctx = getRequestContext();
  return projects
    .list(includeArchived)
    .filter((p) => isAuthorized(ctx, 'read', { scope: 'project', projectId: p.id }));
}

export function resolveSearchScope(
  deps: Pick<ScopeResolutionDeps, 'projects'>,
  resolved: EffectiveScope,
  acrossProjects: boolean | undefined,
): SearchScope {
  if (acrossProjects !== true) return resolved.scope;
  const homeProjectId = resolved.scope.projectId;
  const projectIds = readableProjects(deps.projects, false).map((p) => p.id);
  if (projectIds.length < 2 || !projectIds.includes(homeProjectId)) return resolved.scope;
  return { kind: 'authorized-projects', projectIds, homeProjectId };
}

export function searchedProjectSlugs(projects: ProjectsService, scope: SearchScope): string[] {
  const ids = new Set(scope.kind === 'project' ? [scope.projectId] : scope.projectIds);
  return projects
    .list(true)
    .filter((p) => ids.has(p.id))
    .map((p) => p.slug);
}

/** Non-throwing sibling of `assertAuthorized`, so both derive the target descriptor identically. */
export function isAuthorizedFor(action: 'read' | 'write', scope: Scope): boolean {
  const ctx = getRequestContext();
  return isAuthorized(ctx, action, { scope: 'project', projectId: scope.projectId });
}

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
  if (scope.projectId === pinned) return '';
  const slug = projects.getById(pinned)?.slug ?? pinned;
  return (
    `; this token is pinned to project '${slug}' — call project.use({slug: '${slug}'}) ` +
    `or reconnect at '/mcp/${slug}'`
  );
}

function setRemedy(
  memberProjectIds: readonly string[],
  scope: Scope,
  projects: ProjectsService,
): string {
  if (memberProjectIds.includes(scope.projectId)) return '';
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

export function boundAnnotationReasons<T extends { reason?: string | null }>(
  views: readonly T[],
  max: number,
): T[] {
  return views.map((v) =>
    typeof v.reason === 'string' && v.reason.length > max
      ? { ...v, reason: sliceWithoutSplittingSurrogatePair(v.reason, max - 1) + '…' }
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
