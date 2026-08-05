#!/bin/sh
# Reproduction driver for the phase-2 multi-partition measurement.
#
#   sh openspec/changes/search-across-authorized-projects/measurements/scale-run.sh \
#      <corpusRoot> <resultsDir> [reps]
#
# Builds one SKEWED corpus per magnitude (skipping any already present) and then
# runs each harness `reps` times, one fresh process each, writing one JSON per
# run. Every table in `vec-partition-scale.md` is generated from those files by
# `scale-summarize.mjs`; no figure there is retyped.
#
# The corpora must live on real disk, not under /tmp: /tmp is tmpfs on this
# machine and the 50k corpus is ~600 MB.
#
# DO NOT point <corpusRoot> at the phase-0 `narrow-*` directories and do not
# rebuild them. `seed-volumetric` reproduces a corpus's CONTENT from its seed but
# not its ids (`ulid()` draws from `Math.random()`), so a rebuild is a different
# corpus for ranking purposes and the phase-0 before/after comparison is only
# valid over the directories built there. These `skew-*` corpora are built
# BESIDE them.
#
# Builds run sequentially and never while a timed run is in flight: a corpus
# build saturates this host, and a timing taken next to one measures contention.
set -eu
ROOT="${1:?corpusRoot}"
RESULTS="${2:?resultsDir}"
REPS="${3:-6}"
# `scale-in-list.mjs` is minutes per run and its three forms are already tight
# across repeats; three is the floor task 2.4 sets.
SYNTHETIC_REPS="${4:-3}"
# Task 2.6 exists because one cell of this harness is a single run, so it gets
# more than the floor.
SCALE_REPS="${5:-5}"
# Which harnesses to run. Re-running one stage against corpora that already
# exist is why this exists; the builds are always skipped when present.
STAGES="${6:-e2e stmt inlist scale}"
has() { case " $STAGES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
MAGNITUDES="1000 20000 50000"
SEED=20260805
# The dominant project (60% of the corpus) and the thinnest (2%). Widening from
# the first is the ordinary case; widening from the second is where the added
# rows dwarf the home project, and the two bound the answer.
HOMES="vol-0 vol-shared"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../../.." && pwd)
RUN="pnpm --filter @rembric/server exec tsx"

mkdir -p "$ROOT" "$RESULTS"

for n in $MAGNITUDES; do
  if [ ! -f "$ROOT/skew-$n/data.db" ]; then
    sessions=$((n / 50))
    echo "[build] $n memories, $sessions sessions, skewed"
    (cd "$REPO" && $RUN src/scripts/seed-volumetric.ts \
      --db "$ROOT/skew-$n" --memories "$n" --sessions "$sessions" --seed "$SEED" --skew) \
      > "$ROOT/build-skew-$n.log" 2>&1
  fi
done

for n in $MAGNITUDES; do
  for home in $HOMES; do
    r=1
    while [ "$r" -le "$REPS" ]; do
      if has e2e; then
        echo "[run] e2e $n $home rep$r"
        (cd "$REPO" && $RUN "$HERE/scale-e2e.mjs" \
          --db "$ROOT/skew-$n" --home "$home" \
          --label "$n/$home/rep$r" --json "$RESULTS/e2e-$n-$home-rep$r.json") > /dev/null
      fi
      if has stmt; then
        echo "[run] statements $n $home rep$r"
        (cd "$REPO" && $RUN "$HERE/scale-statements.mjs" \
          --db "$ROOT/skew-$n" --home "$home" \
          --label "$n/$home/rep$r" --json "$RESULTS/stmt-$n-$home-rep$r.json") > /dev/null
      fi
      r=$((r + 1))
    done
  done
done

r=1
while has inlist && [ "$r" -le "$SYNTHETIC_REPS" ]; do
  echo "[run] in-list rep$r"
  (cd "$REPO" && $RUN "$HERE/scale-in-list.mjs" \
    --label "rep$r" --json "$RESULTS/inlist-rep$r.json") > /dev/null
  r=$((r + 1))
done

# Task 2.6: the committed capability harness, unmodified, repeated — the
# 20 000-vector `IN (all 8)` cell it produced is a single run today.
r=1
while has scale && [ "$r" -le "$SCALE_REPS" ]; do
  echo "[run] vec-partition-scale rep$r"
  (cd "$REPO/apps/server" && node "$HERE/vec-partition-scale.mjs") \
    > "$RESULTS/vec-partition-scale-rep$r.txt"
  r=$((r + 1))
done

echo "[done] $RESULTS"
