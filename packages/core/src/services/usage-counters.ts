export const COUNTED_TOOLS = ['memory.search', 'memory.context', 'memory.save'] as const;

export type CountedTool = (typeof COUNTED_TOOLS)[number];

/** `{ [tokenId]: { [tool]: count } }` — the wire shape of the debug endpoint. */
export type CounterSnapshot = Record<string, Partial<Record<CountedTool, number>>>;

export interface RecallCounterCell {
  requests: number;
  nonEmpty: number;
  linesServed: number;
}

export type RecallSnapshot = Record<string, RecallCounterCell>;

export class UsageCounters {
  private readonly byToken = new Map<string, Map<CountedTool, number>>();
  private readonly recallByToken = new Map<string, RecallCounterCell>();
  private readonly fileRecallByToken = new Map<string, RecallCounterCell>();

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

  /** Record one recall-hints request's outcome for `tokenId`. */
  recordRecall(tokenId: string, linesServed: number): void {
    countInto(this.recallByToken, tokenId, linesServed);
  }

  /** Record one file-recall request's outcome for `tokenId`. */
  recordFileRecall(tokenId: string, linesServed: number): void {
    countInto(this.fileRecallByToken, tokenId, linesServed);
  }

  /** Read-only view for the admin debug surface, same authorization as `snapshot()`. */
  recallSnapshot(): RecallSnapshot {
    return snapshotOf(this.recallByToken);
  }

  fileRecallSnapshot(): RecallSnapshot {
    return snapshotOf(this.fileRecallByToken);
  }
}

function countInto(
  cells: Map<string, RecallCounterCell>,
  tokenId: string,
  linesServed: number,
): void {
  let cell = cells.get(tokenId);
  if (!cell) {
    cell = { requests: 0, nonEmpty: 0, linesServed: 0 };
    cells.set(tokenId, cell);
  }
  cell.requests += 1;
  if (linesServed > 0) cell.nonEmpty += 1;
  cell.linesServed += linesServed;
}

function snapshotOf(cells: Map<string, RecallCounterCell>): RecallSnapshot {
  const out: RecallSnapshot = {};
  for (const [tokenId, cell] of cells) out[tokenId] = { ...cell };
  return out;
}
