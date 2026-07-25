/**
 * The gated retrieval metrics and the ratchet that protects their committed
 * floors.
 *
 * A floor is written as `measured - tolerance`, which on its own is not a
 * regression gate at all: re-running `--write-baselines` after a regression
 * rewrote the floor UNDERNEATH the regressed value, so the next run compared
 * against the worse number and CI stayed green permanently. Two regressions of
 * a tolerance each, with a baseline rewrite between them, took the gate down by
 * two tolerances and nothing recorded that it had moved.
 *
 * A floor therefore only ever moves UP. Lowering one stays possible — a
 * deliberate recall-for-tokens trade is legitimate — but only as an explicit,
 * printed act, never as a side effect of regenerating baselines.
 */

export const FLOOR_METRICS = ['precisionAtK', 'recallAtK', 'mrr'] as const;
export type FloorMetric = (typeof FLOOR_METRICS)[number];
export type MetricFloors = Record<FloorMetric, number>;

export interface RatchetedFloors {
  floors: Record<number, MetricFloors>;
  /** Human-readable lines for every floor that was held back or explicitly lowered. */
  notes: string[];
}

export function ratchetFloors(opts: {
  label: string;
  measuredByK: Record<number, MetricFloors>;
  previousByK: Record<number, MetricFloors> | undefined;
  tolerance: number;
  allowLowering: boolean;
}): RatchetedFloors {
  const floors: Record<number, MetricFloors> = {};
  const notes: string[] = [];

  for (const [kRaw, measured] of Object.entries(opts.measuredByK)) {
    const k = Number(kRaw);
    const previous = opts.previousByK?.[k];
    const next = {} as MetricFloors;
    for (const metric of FLOOR_METRICS) {
      const proposed = Math.max(0, measured[metric] - opts.tolerance);
      const prior = previous?.[metric];
      if (prior === undefined || proposed >= prior) {
        next[metric] = proposed;
      } else if (opts.allowLowering) {
        next[metric] = proposed;
        notes.push(
          `${opts.label}@${k} ${metric} floor LOWERED ${prior.toFixed(3)} → ${proposed.toFixed(3)} (explicitly permitted)`,
        );
      } else {
        next[metric] = prior;
        notes.push(
          `${opts.label}@${k} ${metric} floor held at ${prior.toFixed(3)}; a rewrite would have dropped it to ${proposed.toFixed(3)} — pass --lower-floors to accept the regression`,
        );
      }
    }
    floors[k] = next;
  }

  return { floors, notes };
}
