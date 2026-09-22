import { AsyncLocalStorage } from 'node:async_hooks';

import { type Project, type Token } from '@rembric/db';

import type { TokenReach } from '../services/tokens.js';

export interface RequestContext extends TokenReach {
  token: Token;
  project: Project | null;
  requestedSlug: string | null;
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
