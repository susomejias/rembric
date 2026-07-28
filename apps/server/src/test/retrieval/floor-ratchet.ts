/**
 * The gated retrieval metrics and the ratchets that protect their committed
 * bounds — floors for the higher-is-better metrics, caps for the
 * lower-is-better ones.
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

/** Lower is better for each, so these are gated as caps and never as floors. */
export const CAP_METRICS = ['abstentionFalsePositiveRate', 'overAbstentionRate'] as const;
export type CapMetric = (typeof CAP_METRICS)[number];
export type MetricCaps = Record<CapMetric, number>;

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

/** A measured aggregate, reduced to the metrics CI gates. A cap metric may be null when its axis had no queries. */
export type GatedMeasurement = MetricFloors & Record<CapMetric, number | null>;

/** Kept beside the two metric lists so a metric added to either is gated the way that list means. */
export function checkBounds(opts: {
  label: string;
  ks: readonly number[];
  measuredByK: Record<number, GatedMeasurement>;
  floorsByK: Record<number, MetricFloors> | undefined;
  capsByK: Record<number, MetricCaps> | undefined;
}): string[] {
  const failures: string[] = [];
  for (const k of opts.ks) {
    const measured = opts.measuredByK[k];
    if (!measured) continue;
    const floor = opts.floorsByK?.[k];
    if (floor) {
      for (const metric of FLOOR_METRICS) {
        if (measured[metric] < floor[metric]) {
          failures.push(
            `${opts.label}@${k} ${metric} regressed: ${measured[metric].toFixed(3)} < committed floor ${floor[metric].toFixed(3)}`,
          );
        }
      }
    }
    const cap = opts.capsByK?.[k];
    if (cap) {
      for (const metric of CAP_METRICS) {
        const value = measured[metric];
        if (value !== null && value > cap[metric]) {
          failures.push(
            `${opts.label}@${k} ${metric} regressed: ${value.toFixed(3)} > committed cap ${cap[metric].toFixed(3)}`,
          );
        }
      }
    }
  }
  return failures;
}

export interface RatchetedCaps {
  caps: Record<number, MetricCaps>;
  notes: string[];
}

/**
 * The floor ratchet's mirror image: a cap only ever moves DOWN, and is clamped
 * to 1 because both metrics are rates. `headroomByMetric` is per-metric because
 * the two denominators differ; a shared one set from the coarser axis silently
 * tolerates several queries going wrong on the finer one.
 */
export function ratchetCaps(opts: {
  label: string;
  measuredByK: Record<number, MetricCaps>;
  previousByK: Record<number, MetricCaps> | undefined;
  headroomByMetric: MetricCaps;
  allowLoosening: boolean;
}): RatchetedCaps {
  const caps: Record<number, MetricCaps> = {};
  const notes: string[] = [];

  for (const [kRaw, measured] of Object.entries(opts.measuredByK)) {
    const k = Number(kRaw);
    const previous = opts.previousByK?.[k];
    const next = {} as MetricCaps;
    for (const metric of CAP_METRICS) {
      const proposed = Math.min(1, measured[metric] + opts.headroomByMetric[metric]);
      const prior = previous?.[metric];
      if (prior === undefined || proposed <= prior) {
        next[metric] = proposed;
      } else if (opts.allowLoosening) {
        next[metric] = proposed;
        notes.push(
          `${opts.label}@${k} ${metric} cap LOOSENED ${prior.toFixed(3)} → ${proposed.toFixed(3)} (explicitly permitted)`,
        );
      } else {
        next[metric] = prior;
        notes.push(
          `${opts.label}@${k} ${metric} cap held at ${prior.toFixed(3)}; a rewrite would have raised it to ${proposed.toFixed(3)} — pass --lower-floors to accept the regression`,
        );
      }
    }
    caps[k] = next;
  }

  return { caps, notes };
}
