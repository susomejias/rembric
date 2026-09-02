/**
 * In-memory tool-call counters (proactive-entity-recall, D6).
 *
 * Per-token counts of the three tools whose usage the proactive-recall change
 * is meant to move: `memory.search`, `memory.context`, `memory.save`. The
 * counters are deliberately NOT database-backed: the measurement is "did
 * usage increase over a session", and a restart-clears-zero map is the
 * minimum viable observability. Database promotion is deferred (tasks 6.7).
 *
 * One instance per process, threaded to both the MCP tool layer and the
 * `/api/:slug/debug/counters` HTTP surface by the bootstrapper — the map
 * itself lives here only; nothing reads it through a global.
 */

export const COUNTED_TOOLS = ['memory.search', 'memory.context', 'memory.save'] as const;

export type CountedTool = (typeof COUNTED_TOOLS)[number];

/** `{ [tokenId]: { [tool]: count } }` — the wire shape of the debug endpoint. */
export type CounterSnapshot = Record<string, Partial<Record<CountedTool, number>>>;

export class UsageCounters {
  private readonly byToken = new Map<string, Map<CountedTool, number>>();

  /** Increment one (token, tool) cell. Called only on a SUCCESSFUL tool call. */
  record(tokenId: string, tool: CountedTool): void {
    let perTool = this.byToken.get(tokenId);
    if (!perTool) {
      perTool = new Map();
      this.byToken.set(tokenId, perTool);
    }
    perTool.set(tool, (perTool.get(tool) ?? 0) + 1);
  }

  /** Read-only view for the admin debug surface. Empty map → `{}`. */
  snapshot(): CounterSnapshot {
    const out: CounterSnapshot = {};
    for (const [tokenId, perTool] of this.byToken) {
      out[tokenId] = Object.fromEntries(perTool);
    }
    return out;
  }

  /** The count for one cell; exported for test/inspection symmetry. */
  get(tokenId: string, tool: CountedTool): number {
    return this.byToken.get(tokenId)?.get(tool) ?? 0;
  }
}
