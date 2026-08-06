#!/bin/sh
# Reproduction driver for the phase-0 narrow-path baseline.
#
#   sh openspec/changes/search-across-authorized-projects/measurements/narrow-path-run.sh \
#      <corpusRoot> <resultsDir> <label> [reps]
#
# Builds one corpus per magnitude (skipping any already present) and then runs
# `narrow-path-e2e.mjs` `reps` times per magnitude, one fresh process each,
# writing one JSON per run. `<label>` names the tree side (`before-phase-1`,
# `after-phase-1`, `after-phase-4`).
#
# The corpora must live on real disk, not under /tmp: /tmp is tmpfs on this
# machine and the 50k corpus is ~600 MB.
#
# REUSE THE SAME <corpusRoot> FOR EVERY LABEL. `seed-volumetric` reproduces a
# corpus's CONTENT from its seed but not its ids — `ulid()` draws its random
# component from `Math.random()`, so a rebuild at the same seed yields the same
# titles and bodies under different ids (verified: titles identical, ids not).
# A rebuilt corpus is therefore a different corpus for ranking purposes.
set -eu
ROOT="${1:?corpusRoot}"
RESULTS="${2:?resultsDir}"
LABEL="${3:?label}"
REPS="${4:-3}"
MAGNITUDES="1000 20000 50000"
SEED=20260805
# The measured project. Scope slot 1 of `VOLUMETRIC_SHAPE`, so its rows are the
# same rows before and after the `Scope` collapse: only slot 0 changes hands.
PROJECT=vol-0
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../../.." && pwd)
RUN="pnpm --filter @rembric/server exec tsx"

mkdir -p "$ROOT" "$RESULTS"
for n in $MAGNITUDES; do
  if [ ! -f "$ROOT/narrow-$n/data.db" ]; then
    sessions=$((n / 50))
    echo "[build] $n memories, $sessions sessions"
    (cd "$REPO" && $RUN src/scripts/seed-volumetric.ts \
      --db "$ROOT/narrow-$n" --memories "$n" --sessions "$sessions" --seed "$SEED") \
      > "$ROOT/build-$n.log" 2>&1
  fi
done

for n in $MAGNITUDES; do
  r=1
  while [ "$r" -le "$REPS" ]; do
    echo "[run] $LABEL $n rep$r"
    (cd "$REPO" && $RUN "$HERE/narrow-path-e2e.mjs" \
      --db "$ROOT/narrow-$n" --project "$PROJECT" \
      --label "$LABEL/$n/rep$r" --json "$RESULTS/$LABEL-$n-rep$r.json") > /dev/null
    r=$((r + 1))
  done
done

echo "[done] $RESULTS"
