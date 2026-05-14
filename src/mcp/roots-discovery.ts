import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SessionRouter } from '../server/session-router.js';
import type { ProjectsService } from '../services/projects.js';

/**
 * Server-driven project auto-detection via the MCP `roots` capability.
 *
 * Triggered lazily from scope-aware tool handlers (`project.current`,
 * `memory.session_start`, `memory.{save,search,get,confirm}`). We tried
 * an eager `server.oninitialized` hook (commit 1379c93) but found that
 * the MCP HTTP streamable client doesn't open its server→client SSE
 * channel until AFTER `notifications/initialized` has been processed,
 * so a `roots/list` issued from `oninitialized` always times out and
 * poisons the discovery slot for the rest of the transport. By the
 * time the agent issues a tool call the channel is up, so `listRoots`
 * succeeds there.
 *
 * Single-flight semantics across concurrent lazy callers come from
 * `SessionRouter.discoveryInFlight`.
 *
 * The behaviour is intentionally conservative:
 *
 *   - clients without `roots` capability → no-op
 *   - existing slug + no active project    → silently activate, source='roots'
 *   - existing slug + already active       → push to pendingSuggestedSlugs
 *   - non-existing slug                    → push to pendingSuggestedSlugs
 *   - timeout / error                      → no-op (silent fall-through)
 *
 * Auto-detection NEVER creates projects and NEVER switches an already
 * active project. The agent must call `project.use({slug, …})` to make
 * either of those happen.
 */

// 1s is enough for any compliant client whose SSE channel is open by
// the time the lazy path fires (first tool call from the agent).
// Lower values cap the worst-case latency hit when a non-compliant
// client advertises `roots` but never responds.
const ROOTS_LIST_TIMEOUT_MS = 1000;

/**
 * One slot per `(tokenId, mcpSessionId)` records whether discovery has
 * already run, so subsequent tool calls do not re-issue `roots/list`.
 */
const discoveryRunForTransport = new Set<string>();

function transportKey(tokenId: string, mcpSessionId: string): string {
  return `${tokenId}::${mcpSessionId}`;
}

export function markDiscoveryRun(tokenId: string, mcpSessionId: string): void {
  discoveryRunForTransport.add(transportKey(tokenId, mcpSessionId));
}

export function isDiscoveryRun(tokenId: string, mcpSessionId: string): boolean {
  return discoveryRunForTransport.has(transportKey(tokenId, mcpSessionId));
}

/** Test-only helper. */
export function resetDiscoveryState(): void {
  discoveryRunForTransport.clear();
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
}

/**
 * Single-flight wrapper around `maybeDiscoverViaRoots`. Use this from
 * any code path that benefits from roots-derived project resolution:
 *
 *   - `server.oninitialized` (eager — fires the moment the handshake
 *     completes, so the router is populated before any tool call)
 *   - scope-aware tool handlers (fallback — clients that never emit
 *     `notifications/initialized`, or tool calls that arrive in the
 *     short window before eager discovery settles)
 *
 * The router stores the in-flight promise so concurrent callers all
 * await the same `listRoots` round trip. Failures are swallowed —
 * discovery must never break a request.
 */
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
  if (isDiscoveryRun(ctx.tokenId, ctx.mcpSessionId)) return;
  const promise = maybeDiscoverViaRoots(deps, ctx).catch(() => undefined);
  deps.router.setDiscoveryPromise(ctx.tokenId, ctx.mcpSessionId, promise);
  await promise;
}

export async function maybeDiscoverViaRoots(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
): Promise<void> {
  if (ctx.pathSlug) return;
  if (isDiscoveryRun(ctx.tokenId, ctx.mcpSessionId)) return;
  markDiscoveryRun(ctx.tokenId, ctx.mcpSessionId);

  const caps = deps.server.server.getClientCapabilities();
  if (!caps?.roots) return;

  try {
    const res = await deps.server.server.listRoots(undefined, { timeout: ROOTS_LIST_TIMEOUT_MS });
    const firstRoot = res.roots[0];
    if (!firstRoot) return;
    const slug = deriveSlugFromUri(firstRoot.uri);
    if (!slug) return;
    applyDerivedSlug(deps, ctx, slug);
  } catch {
    // Silent on error / timeout — discovery must never break a request.
  }
}

/**
 * Re-derive a slug for the transport in response to
 * `notifications/roots/list_changed`. Behaviour mirrors the lazy path
 * but never auto-switches an already-active project — list_changed
 * updates suggestions only.
 */
export async function refreshRootsAfterChange(
  deps: RootsDiscoveryDeps,
  ctx: RootsDiscoveryContext,
): Promise<void> {
  if (ctx.pathSlug) return;
  const caps = deps.server.server.getClientCapabilities();
  if (!caps?.roots) return;
  try {
    const res = await deps.server.server.listRoots(undefined, { timeout: ROOTS_LIST_TIMEOUT_MS });
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

/**
 * Convert a `file://` URI (or a plain path) to a candidate slug:
 *   - take the basename of the path
 *   - lowercase
 *   - replace non-`[a-z0-9-]` characters with `-`
 *   - collapse runs of `-` and trim leading/trailing `-`
 *   - return null when the result is empty or would not match the strict regex
 */
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
  // Slugs must start and end with [a-z0-9]; the trim above already guarantees
  // it, but defensively check.
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(collapsed)) return null;
  return collapsed;
}
