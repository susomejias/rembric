export type ProjectResolutionSource = 'url-path' | 'roots' | 'tool-explicit' | 'default' | 'none';

export interface RouterEntry {
  /** Currently-active Rembric session id, or null if no session_start yet. */
  rembricSessionId: string | null;
  /** Active project id (may be null for global-scope transports). */
  projectId: string | null;
  /** How the active project was resolved. */
  projectResolutionSource: ProjectResolutionSource;
  pendingSuggestedSlugs: string[];
}

function entryKey(tokenId: string, mcpSessionId: string): string {
  return `${tokenId}::${mcpSessionId}`;
}

export class SessionRouter {
  private readonly entries = new Map<string, RouterEntry>();
  private readonly discoveryInFlight = new Map<string, Promise<unknown>>();

  /** Read the entry for a given transport, returning a copy for safety. */
  get(tokenId: string, mcpSessionId: string): RouterEntry | undefined {
    const e = this.entries.get(entryKey(tokenId, mcpSessionId));
    return e ? { ...e, pendingSuggestedSlugs: [...e.pendingSuggestedSlugs] } : undefined;
  }

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

  /** Null the active Rembric session id for a transport (used by `memory.session_end`); the entry itself is kept. */
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

  clearDiscoveryPromise(tokenId: string, mcpSessionId: string, promise: Promise<unknown>): void {
    const key = entryKey(tokenId, mcpSessionId);
    if (this.discoveryInFlight.get(key) === promise) this.discoveryInFlight.delete(key);
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
