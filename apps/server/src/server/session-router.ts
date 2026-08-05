/**
 * In-process routing state for agent sessions.
 *
 * Maps a transport identity tuple `(tokenId, projectId, mcpSessionId)` to
 * the currently-active Rembric session id. The state is NOT persisted —
 * on server restart, the `AgentSessionsService.abandonStale` sweep walks
 * the DB and marks old `active` rows as `abandoned`, so the router
 * starts cold without coordinating with the DB.
 *
 * Identity rules:
 *   - The `mcp-session-id` HTTP header is the per-transport boundary.
 *     Two terminals using the same token but different transports get
 *     separate router entries.
 *   - `projectId` may be null (global scope) — null is a distinct key.
 *
 * Project-resolution provenance is carried alongside the active session
 * id so `project.current` can report it:
 *
 *   url-path     | the connection arrived at `/mcp/<slug>`
 *   roots        | server queried roots/list and auto-activated
 *   tool-explicit| agent called `project.use({slug})` for this session
 *   default      | nothing named a project, so the default one is in effect
 *   none         | no active project for the transport
 */

export type ProjectResolutionSource = 'url-path' | 'roots' | 'tool-explicit' | 'default' | 'none';

export interface RouterEntry {
  /** Currently-active Rembric session id, or null if no session_start yet. */
  rembricSessionId: string | null;
  /** Active project id (may be null for global-scope transports). */
  projectId: string | null;
  /** How the active project was resolved. */
  projectResolutionSource: ProjectResolutionSource;
  /**
   * Slugs surfaced as candidates (from `roots/list` derivation that did
   * not auto-activate, e.g. unknown slug or "switch would replace"). The
   * agent reads these via `project.current` and decides whether to call
   * `project.use({slug})`.
   */
  pendingSuggestedSlugs: string[];
}

function entryKey(tokenId: string, mcpSessionId: string): string {
  return `${tokenId}::${mcpSessionId}`;
}

export class SessionRouter {
  private readonly entries = new Map<string, RouterEntry>();
  /**
   * In-flight roots-discovery promise per transport. Used to serialize
   * concurrent discovery attempts (e.g. `oninitialized` fires eager
   * discovery and a tool handler arrives before it settles — the handler
   * awaits the same promise instead of triggering a second listRoots).
   */
  private readonly discoveryInFlight = new Map<string, Promise<unknown>>();

  /** Read the entry for a given transport, returning a copy for safety. */
  get(tokenId: string, mcpSessionId: string): RouterEntry | undefined {
    const e = this.entries.get(entryKey(tokenId, mcpSessionId));
    return e ? { ...e, pendingSuggestedSlugs: [...e.pendingSuggestedSlugs] } : undefined;
  }

  /**
   * Mutate the entry for a transport. Creates a default entry if absent.
   * Returns the post-mutation snapshot.
   */
  update(tokenId: string, mcpSessionId: string, fn: (entry: RouterEntry) => void): RouterEntry {
    const key = entryKey(tokenId, mcpSessionId);
    const existing = this.entries.get(key);
    const draft: RouterEntry = existing ?? {
      rembricSessionId: null,
      projectId: null,
      projectResolutionSource: 'none',
      pendingSuggestedSlugs: [],
    };
    fn(draft);
    this.entries.set(key, draft);
    return { ...draft, pendingSuggestedSlugs: [...draft.pendingSuggestedSlugs] };
  }

  /** Convenience setter for activating a project on this transport. */
  setActiveProject(
    tokenId: string,
    mcpSessionId: string,
    projectId: string | null,
    source: ProjectResolutionSource,
  ): RouterEntry {
    return this.update(tokenId, mcpSessionId, (e) => {
      e.projectId = projectId;
      e.projectResolutionSource = source;
    });
  }

  /** Convenience setter for activating a Rembric session on this transport. */
  setActiveSession(tokenId: string, mcpSessionId: string, sessionId: string | null): RouterEntry {
    return this.update(tokenId, mcpSessionId, (e) => {
      e.rembricSessionId = sessionId;
    });
  }

  /** Convenience setter for the pending suggestion list. */
  setSuggestedSlugs(tokenId: string, mcpSessionId: string, slugs: readonly string[]): RouterEntry {
    return this.update(tokenId, mcpSessionId, (e) => {
      e.pendingSuggestedSlugs = [...slugs];
    });
  }

  /** Clear an entire transport entry (used by `memory.session_end`). */
  clearSession(tokenId: string, mcpSessionId: string): void {
    const e = this.entries.get(entryKey(tokenId, mcpSessionId));
    if (e) e.rembricSessionId = null;
  }

  /** Track an in-flight roots-discovery promise for this transport. */
  setDiscoveryPromise(tokenId: string, mcpSessionId: string, promise: Promise<unknown>): void {
    this.discoveryInFlight.set(entryKey(tokenId, mcpSessionId), promise);
  }

  /** Read the in-flight roots-discovery promise for this transport, if any. */
  getDiscoveryPromise(tokenId: string, mcpSessionId: string): Promise<unknown> | undefined {
    return this.discoveryInFlight.get(entryKey(tokenId, mcpSessionId));
  }

  /** Test-only helper: drop everything. */
  resetAll(): void {
    this.entries.clear();
    this.discoveryInFlight.clear();
  }

  /** Number of live transport entries; exposed for stats/debug. */
  size(): number {
    return this.entries.size;
  }
}
