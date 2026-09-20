/**
 * Scope is the application-level equivalent of row-level security.
 *
 * Every read or write of memory data through the service layer takes a
 * `Scope` argument — the search path a `SearchScope` — and the service
 * refuses to return or mutate rows outside it. The compiler enforces
 * this: a service method called
 * without a scope argument is a type error. The only way to bypass it
 * is to call an explicit `unsafe*` method, used exclusively by the
 * consolidation engine (which must legitimately cross scopes) and by
 * the dashboard admin views.
 *
 * A scope is a project and nothing else. The `memory.scope` COLUMN still
 * exists and is still written as the constant `'project'` so a rolled-back
 * previous image can execute its own queries; no read branches on it, and its
 * removal is a separate change (memory/spec.md).
 *
 * Mapping from MCP request context to a Scope happens in one place
 * (the MCP handlers, via `resolveEffectiveScope`). Mapping from CLI /
 * cron to a scope happens at the call site of the consolidation engine.
 */

export type Scope = { kind: 'project'; projectId: string };

/**
 * What a SEARCH may address: one project, or a set of them each of which was
 * individually authorized for `read`. A separate type rather than a third field
 * on `Scope` so that a write cannot hold one — handing a widened value to
 * `save`, `confirm` or `archive` is a compile error rather than a runtime
 * refusal (auth/spec.md: a widening "SHALL be of a type no write path can
 * hold"). Only the search path accepts it.
 */
export type SearchScope =
  | Scope
  | {
      kind: 'authorized-projects';
      /** Each id was admitted by `isAuthorized(…, 'read', …)` at the one site that builds this. */
      projectIds: readonly string[];
      /** The scope the connection resolved to; always a member of `projectIds`. */
      homeProjectId: string;
    };

/** Scope a project by id. */
export function projectScope(projectId: string): Scope {
  return { kind: 'project', projectId };
}

/**
 * The single project a `SearchScope` resolved from — the scope a widened search
 * still writes into, reports as its home, and falls back to wherever the
 * widening does not reach.
 */
export function homeScope(scope: SearchScope): Scope {
  return scope.kind === 'project' ? scope : projectScope(scope.homeProjectId);
}

/**
 * True iff a memory row belongs to the given scope. Centralises the
 * comparison so callers don't reimplement it (the previous source of
 * the cross-scope leak bug).
 */
export function memoryMatchesScope(
  memory: { scope: 'global' | 'project'; projectId: string | null },
  scope: Scope,
): boolean {
  return memory.scope === 'project' && memory.projectId === scope.projectId;
}
