import type { RequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { ProjectsService } from '../services/projects.js';

/**
 * Save-path / session-start gate that protects against the silent
 * fallback to `scope='global'` when roots-based discovery surfaced
 * one-or-more project slugs that do NOT yet exist as projects.
 *
 * Returns the list of pending suggested slugs when the gate should fire,
 * otherwise `null`. The caller is responsible for translating a non-null
 * return into an MCP error response.
 *
 * Conditions (all must hold for a non-null return):
 *   - the connection is path-LESS (`ctx.requestedSlug` is null)
 *   - no project is pinned for the transport (router entry has
 *     `projectId === null` OR no entry exists)
 *   - the transport's pending suggestion list is non-empty AND at least
 *     one suggested slug does not resolve to an existing project
 *
 * Path-scoped connections, transports with a pinned project, and
 * transports with no roots-derived suggestions all bypass the gate (the
 * function returns `null`).
 */
export function pendingSuggestionGate(
  ctx: RequestContext,
  deps: { router: SessionRouter; projects: ProjectsService },
): string[] | null {
  if (ctx.requestedSlug !== null) return null;
  if (!ctx.mcpSessionId) return null;

  const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
  if (entry?.projectId) return null;

  const suggestions = entry?.pendingSuggestedSlugs ?? [];
  if (suggestions.length === 0) return null;

  const unminted = suggestions.filter((slug) => !deps.projects.findBySlug(slug));
  if (unminted.length === 0) return null;

  return unminted;
}

/**
 * Construct the user-facing hint sentence that `project_suggestion_pending`
 * responses carry verbatim. Kept here so both call sites (memory.save and
 * memory.session_start) use the same wording.
 */
export function suggestionPendingMessage(): string {
  return (
    'No project is active and roots-based discovery surfaced suggestions. ' +
    "Either pass scope:'global' explicitly, or call " +
    "project.use({slug:'<one of suggestedSlugs>', autocreate:true})."
  );
}
