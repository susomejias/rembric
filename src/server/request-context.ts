import { AsyncLocalStorage } from 'node:async_hooks';

import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import type { TokenScope } from '../services/tokens.js';

/**
 * Per-request context propagated through MCP tool handlers via
 * AsyncLocalStorage. The HTTP layer wraps each request in a `.run()`
 * before dispatching to the MCP transport; tools read the context to know
 * who is calling and which project scope applies.
 */

export interface RequestContext {
  token: Token;
  scope: TokenScope;
  /** Project resolved from the `X-Rembric-Project` header, or null for global-only callers. */
  project: Project | null;
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
