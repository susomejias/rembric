# Measurements

Each file names its instrument. Rows from different instruments are never tabulated together.

## `sweep.txt`: save-time calibration sweep

- **Command:** `pnpm run eval:save-time`
- **Fixture:** `packages/core/src/test-support/retrieval/save-time-fixture.ts`. It holds 24 base memories (English and Spanish, five memory types) and 27 labelled saves: 8 near-duplicates, 4 expanded rewrites, 5 contradictions and 10 unrelated saves.
- **Instrument:** pending rows written by the production curation path (`runPostSaveSteps`) for each labelled save, at per-save cap 5. "Queue depth" is the total over all 27 labelled saves.
- **Determinism:** two consecutive runs produced byte-identical output.

### Admissibility, per design D4

A grid value is admissible when all four hold:

1. In the lexical-only arm, every near-duplicate is surfaced.
2. In the production arm, every labelled pair of every class is surfaced.
3. In both arms, unrelated saves write zero lexical-sourced rows.
4. The value sits inside a plateau at least 0.10 wide.

### Reading the grid

**Lower bound, 0.55:** at 0.50, one unrelated save still writes one lexical row (0.10 per save across 10 unrelated saves). At 0.55 none does.

**Upper bound, 0.70:** at 0.75, the lexical-only arm loses its first near-duplicate (7/8).

**Production arm:** admissible from 0.55 up to 0.95. The upper bound therefore comes from the lexical-only arm, which is the degraded mode when inference fails.

**Plateau:** 0.55–0.70, width 0.15. The chosen value is **0.60**, the plateau midpoint (0.625) rounded down to the grid. Rounding down keeps the larger margin on the side that protects recall.

**Queue depth at 0.60 against 0.00:**

| arm          | 0.00 | 0.60 |
| ------------ | ---- | ---- |
| production   | 135  | 18   |
| lexical-only | 135  | 12   |

**Secondary series (not gating):** pending rows written while ingesting the 70-memory retrieval corpus, production arm. It drops from 289 at 0.00 to 54 at 0.60.

### Known consequences, recorded rather than hidden

- **Expanded rewrites in the lexical-only arm:** they drop below the floor from 0.30 upward (0/4 at 0.60), as design D1 predicted. Containment divides by the longer saved text. The production arm surfaces all four at every grid value, through the vector channel.
- **Contradictions in the lexical-only arm:** they surface 3/5 at 0.60. The three that surface (`c-session`, `c-flaky`, `c-flags`) share an extracted path and come through the entity channel. The two that are lost carry no identifier the entity extractor recognises. `c-cache` names none, and `c-env`'s bare `STRIPE_WEBHOOK_SECRET` is not extracted as an `env_var`, which was confirmed by running `extractEntities` on it. The production arm surfaces both through the vector channel.
- **The two plateau edges** are each set by a single fixture item. The fixture is small. The measure is corpus-independent, so the value transfers to production as long as text style is similar. The plateau rule rejects a value that holds only at one grid point.

## Performance: no degradation

Three files, three instruments. They are never tabulated together.

### `save-latency-run1.txt`: end-to-end, unpaired (replaced)

**Design:** the three arms saved different probe texts, and the noise band was a single difference between two medians.

**Result:** at 20 000 rows the added p50 was +0.315 ms, against a noise band of 0.049 ms, which reads as "MISSED". At 1 000 and 50 000 rows the floor arm was faster (−0.188 ms and −0.410 ms).

**Why it was replaced:** per design D5, a miss means "the implementation added work, or the instrument is faulty". This instrument was faulty in two ways. Differences in probe text leaked into the arm difference, and one draw is not a noise band. The run is kept so the replacement is visible.

### `save-latency.txt`: end-to-end, paired (`save-latency.mts`)

**Design:** every round saves the same probe text through all three arms, in rotating order. The statistic is the median paired difference, with a 2000-resample bootstrap 95% interval.

| rows   | floor − a, median [95%]    | identical arms b − a, median [95%] | strict rule |
| ------ | -------------------------- | ---------------------------------- | ----------- |
| 1 000  | +0.041 ms [−0.025, +0.099] | −0.060 ms [−0.120, −0.011]         | met         |
| 20 000 | +0.081 ms [+0.005, +0.143] | +0.013 ms [−0.048, +0.077]         | **missed**  |
| 50 000 | −0.061 ms [−0.158, +0.032] | −0.056 ms [−0.163, +0.104]         | met         |

The saves themselves take 11 ms, 47 ms and 106 ms at those sizes. Every difference is under 0.15 ms, which is below 0.3% of the save.

At 20 000 rows the upper bound exceeds the identical-arm bound by 0.066 ms. The table also shows that this instrument cannot resolve that margin: at 1 000 rows, two **identical** arms differ significantly, by −0.060 ms. That is a position or order effect of the same size as the margin in question.

### `detect-latency.txt`: statement-level (`detect-latency.mts`)

This instrument times only the code the change touches: `findSaveTimeCandidates`, on the read path, with no writes. It runs at 20 000 rows, with 40 probes × 50 rounds, paired.

**Result:** the median paired difference was **−0.0064 ms**, against **+0.0153 ms** for identical arms. The interquartile spread is the same in both (about ±0.17 ms). An earlier run of the same instrument measured −0.0163 ms. At this resolution the floor adds no measurable work.

**Rows admitted:** the floor arm admitted fewer rows (38 900 against 40 000 detected), so where it drops rows it does less work afterwards.

### Conclusion

The floor adds no measurable cost. The only strict-rule miss (20 000 rows, end-to-end) sits within the demonstrated resolution of that instrument, and the higher-resolution instrument shows no added work in the changed code.

### Out of scope, recorded

End-to-end `memory.save` latency grows with corpus size regardless of the floor: about 11 ms at 1 000 rows, 47 ms at 20 000 and 106 ms at 50 000, all in the `floor = 0.00` arm. The synthetic corpus reuses a small vocabulary, which may inflate lexical matching. The growth deserves its own investigation and is not caused by this change.
