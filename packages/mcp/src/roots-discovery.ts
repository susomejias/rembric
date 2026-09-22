import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ErrorCode,
  McpError,
  type ListRootsResult,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { ProjectsService } from '@rembric/core';
import type { SessionRouter } from '@rembric/core';

// Binds only a client that advertises `roots` and then declines to answer.
const ROOTS_LIST_TIMEOUT_MS = 2500;

interface DiscoveryState {
  answered: Set<string>;
  /** A `roots/list_changed` arrived and no tool call has served it yet. */
  refreshPending: boolean;
}

const stateByServer = new WeakMap<McpServer, DiscoveryState>();

function discoveryState(server: McpServer): DiscoveryState {
  let state = stateByServer.get(server);
  if (!state) {
    state = { answered: new Set(), refreshPending: false };
    stateByServer.set(server, state);
  }
  return state;
}

function transportKey(tokenId: string, mcpSessionId: string): string {
  return `${tokenId}::${mcpSessionId}`;
}

export function markDiscoveryRun(server: McpServer, tokenId: string, mcpSessionId: string): void {
  discoveryState(server).answered.add(transportKey(tokenId, mcpSessionId));
}

export function isDiscoveryRun(server: McpServer, tokenId: string, mcpSessionId: string): boolean {
  return discoveryState(server).answered.has(transportKey(tokenId, mcpSessionId));
}

/** All a `roots/list_changed` handler can do: it has no tool call to send under. */
export function markRefreshPending(server: McpServer): void {
  discoveryState(server).refreshPending = true;
}

export interface RootsDiscoveryDeps {
  server: McpServer;
  router: SessionRouter;
  projects: ProjectsService;
}

export interface RootsDiscoveryContext {
  tokenId: string;
  mcpSessionId: string;
  /** When the URL path already pinned a slug, discovery is a no-op. */
  pathSlug: string | null;
  toolCallRequestId?: RequestId;
}

export async function ensureRootsDiscoveryRun(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
): Promise<void> {
  if (ctx.pathSlug) return;
  const pending = deps.router.getDiscoveryPromise(ctx.tokenId, ctx.mcpSessionId);
  if (pending) {
    await pending;
    return;
  }
  const state = discoveryState(deps.server);
  if (!isDiscoveryRun(deps.server, ctx.tokenId, ctx.mcpSessionId)) {
    state.refreshPending = false;
    await singleFlight(deps, ctx, () => maybeDiscoverViaRoots(deps, ctx));
    return;
  }
  if (!state.refreshPending) return;
  state.refreshPending = false;
  await singleFlight(deps, ctx, () => refreshRootsAfterChange(deps, ctx));
}

async function singleFlight(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
  attempt: () => Promise<void>,
): Promise<void> {
  const promise = attempt().catch(() => undefined);
  deps.router.setDiscoveryPromise(ctx.tokenId, ctx.mcpSessionId, promise);
  try {
    await promise;
  } finally {
    deps.router.clearDiscoveryPromise(ctx.tokenId, ctx.mcpSessionId, promise);
  }
}

export async function maybeDiscoverViaRoots(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
): Promise<void> {
  if (ctx.pathSlug) return;
  if (isDiscoveryRun(deps.server, ctx.tokenId, ctx.mcpSessionId)) return;

  const caps = deps.server.server.getClientCapabilities();
  if (!caps?.roots) {
    markDiscoveryRun(deps.server, ctx.tokenId, ctx.mcpSessionId);
    return;
  }

  let res: ListRootsResult;
  try {
    res = await deps.server.server.listRoots(undefined, listRootsOptions(ctx));
  } catch (err) {
    if (isAnswerFromClient(err)) markDiscoveryRun(deps.server, ctx.tokenId, ctx.mcpSessionId);
    // Swallowed: discovery must never break a request.
    return;
  }
  markDiscoveryRun(deps.server, ctx.tokenId, ctx.mcpSessionId);
  const firstRoot = res.roots[0];
  if (!firstRoot) return;
  const slug = deriveSlugFromUri(firstRoot.uri);
  if (!slug) return;
  applyDerivedSlug(deps, ctx, slug);
}

function listRootsOptions(ctx: RootsDiscoveryContext): RequestOptions {
  const options: RequestOptions = { timeout: ROOTS_LIST_TIMEOUT_MS };
  // Unstamped when no tool call is in scope: the pre-existing routing, never a throw.
  if (ctx.toolCallRequestId !== undefined) options.relatedRequestId = ctx.toolCallRequestId;
  return options;
}

/** `McpError.code` is a plain `number`, so the enum members are widened to match it. */
const NO_ANSWER_CODES: readonly number[] = [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed];

/** A JSON-RPC error is an answer; a timeout or transport failure is not. */
function isAnswerFromClient(err: unknown): boolean {
  return err instanceof McpError && !NO_ANSWER_CODES.includes(err.code);
}

export async function refreshRootsAfterChange(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
): Promise<void> {
  if (ctx.pathSlug) return;
  const caps = deps.server.server.getClientCapabilities();
  if (!caps?.roots) return;
  try {
    const res = await deps.server.server.listRoots(undefined, listRootsOptions(ctx));
    const firstRoot = res.roots[0];
    if (!firstRoot) {
      deps.router.setSuggestedSlugs(ctx.tokenId, ctx.mcpSessionId, []);
      return;
    }
    const slug = deriveSlugFromUri(firstRoot.uri);
    if (!slug) {
      deps.router.setSuggestedSlugs(ctx.tokenId, ctx.mcpSessionId, []);
      return;
    }
    // list_changed never auto-switches: push to suggestions only.
    deps.router.setSuggestedSlugs(ctx.tokenId, ctx.mcpSessionId, [slug]);
  } catch {
    // Silent.
  }
}

function applyDerivedSlug(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
  slug: string,
): void {
  const existing = deps.router.get(ctx.tokenId, ctx.mcpSessionId);
  const alreadyActive = existing?.projectId !== null && existing?.projectId !== undefined;

  const project = deps.projects.findBySlug(slug);
  if (!project) {
    // Surface the derived slug as a suggestion only.
    deps.router.setSuggestedSlugs(ctx.tokenId, ctx.mcpSessionId, [slug]);
    return;
  }
  if (alreadyActive) {
    deps.router.setSuggestedSlugs(ctx.tokenId, ctx.mcpSessionId, [slug]);
    return;
  }
  // Activate silently with `source: 'roots'`.
  deps.router.setActiveProject(ctx.tokenId, ctx.mcpSessionId, project.id, 'roots');
}

export function deriveSlugFromUri(uri: string): string | null {
  let path: string;
  try {
    if (uri.startsWith('file://')) {
      const url = new URL(uri);
      path = decodeURIComponent(url.pathname);
    } else {
      path = uri;
    }
  } catch {
    path = uri;
  }
  // Strip trailing slashes.
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  if (last.length === 0) return null;
  const lowered = last.toLowerCase();
  const collapsed = lowered
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (collapsed.length === 0 || collapsed.length > 64) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(collapsed)) return null;
  return collapsed;
}
