import { AsyncLocalStorage } from 'node:async_hooks';

import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import type { TokenReach } from '../services/tokens.js';

/**
 * Per-request context propagated through MCP tool handlers via
 * AsyncLocalStorage. The HTTP layer wraps each request in a `.run()`
 * before dispatching to the MCP transport; tools read the context to know
 * who is calling and which project scope applies.
 */

/**
 * Extends `TokenReach` (`scope` + `memberProjectIds`) so the context can be
 * handed to `isAuthorized` whole: a call site cannot pass the scope string and
 * forget the membership set, which would silently deny every set-scoped token.
 * Both halves are re-read by `authenticate` on every request.
 */
export interface RequestContext extends TokenReach {
  token: Token;
  /**
   * Project resolved from the URL path `/mcp/<slug>` (or null when the
   * caller is on the unscoped `/mcp` endpoint, or when the requested
   * slug does not exist).
   */
  project: Project | null;
  /**
   * The literal slug requested in the URL path, regardless of whether it
   * resolved to a project. When the path is `/mcp/typo` and no project
   * has that slug, `project` is null but `requestedSlug` is `'typo'` so
   * tool handlers can return `project_not_found` with a suggestion list.
   */
  requestedSlug: string | null;
  /**
   * The MCP transport session id read from the `mcp-session-id` header.
   * Used as the per-transport key for the in-process `SessionRouter`.
   * `null` for requests that arrive before a session id is established
   * (e.g. the initial `initialize` request itself).
   */
  mcpSessionId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('request context missing (called outside of an authenticated request)');
  }
  return ctx;
}

export function tryGetRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
