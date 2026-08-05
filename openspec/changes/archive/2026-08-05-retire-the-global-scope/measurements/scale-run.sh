#!/bin/sh
# Reproduction driver for the `retire-the-global-scope` scale measurements.
#
#   sh openspec/changes/retire-the-global-scope/measurements/scale-run.sh \
#      <fixtureRoot> <resultsDir> [reps]
#
# Builds one fixture per magnitude (skipping any already present) and then runs
# the migration matrix `reps` times per (magnitude, variant), writing one JSON
# per run. `scale-summarize.mjs` turns those into the tables in scale.md.
#
# The fixtures are NOT built under the scratchpad on this machine: /tmp is tmpfs
# and the 200k fixture is ~3 GB, which would be 3 GB of RAM on a 15 GB box that
# is also running the dev stack. <fixtureRoot> should be on real disk.
set -eu
ROOT="${1:?fixtureRoot}"
RESULTS="${2:?resultsDir}"
REPS="${3:-3}"
MAGNITUDES="1000 10000 50000 200000"
VARIANTS="set loop runner boot"
# The two design alternatives §6 compares. Skipped at 1k, where the whole body is
# under 120 ms and the comparison is noise.
ALT_VARIANTS="rebuild id-is-partition"
ALT_MAGNITUDES="10000 50000 200000"
ALT_REPS=2
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../../.." && pwd)
RUN="pnpm --filter @rembric/server exec tsx"

mkdir -p "$ROOT" "$RESULTS"
for n in $MAGNITUDES; do
  if [ ! -f "$ROOT/scale-$n/data.db" ]; then
    echo "[build] $n global rows"
    (cd "$REPO" && $RUN "$HERE/scale-fixture.mjs" --dir "$ROOT/scale-$n" --global "$n") \
      > "$ROOT/build-$n.json" 2> "$ROOT/build-$n.log"
  fi
done

for n in $MAGNITUDES; do
  for v in $VARIANTS; do
    r=1
    while [ "$r" -le "$REPS" ]; do
      echo "[run] $n $v rep$r"
      (cd "$REPO" && $RUN "$HERE/scale-migrate.mjs" \
        --fixture "$ROOT/scale-$n" --variant "$v" \
        --work "$ROOT/work" --json "$RESULTS/$n-$v-$r.json") > /dev/null
      r=$((r + 1))
    done
  done
done

for n in $ALT_MAGNITUDES; do
  for v in $ALT_VARIANTS; do
    r=1
    while [ "$r" -le "$ALT_REPS" ]; do
      echo "[run] $n $v rep$r"
      (cd "$REPO" && $RUN "$HERE/scale-migrate.mjs" \
        --fixture "$ROOT/scale-$n" --variant "$v" \
        --work "$ROOT/work" --json "$RESULTS/$n-$v-$r.json") > /dev/null
      r=$((r + 1))
    done
  done
done

# One VACUUM run per magnitude, set-based only: it answers whether the file
# growth the body leaves behind is reclaimable, which is not a per-variant question.
for n in $MAGNITUDES; do
  echo "[vacuum] $n"
  (cd "$REPO" && $RUN "$HERE/scale-migrate.mjs" \
    --fixture "$ROOT/scale-$n" --variant set --vacuum \
    --work "$ROOT/work" --json "$RESULTS/$n-set-vacuum.json") > /dev/null
done

# Variant C (re-INSERT before DELETE, no stash table) is expected to FAIL. Recorded
# rather than described, so the reason the stash is unavoidable is in the artefacts.
echo "[negative] insert-first"
(cd "$REPO" && $RUN "$HERE/scale-migrate.mjs" \
  --fixture "$ROOT/scale-1000" --variant insert-first \
  --work "$ROOT/work" --json "$RESULTS/1000-insert-first.json") > /dev/null || true

# Interruption (§8) and the rollback comparison (§6). Not part of the timing
# matrix — each answers a yes/no question, not a wall-clock one.
for n in 10000 50000; do
  echo "[crash] $n"
  # `set -e` would abort on a plain `[ … ] && k=…` whose test is false.
  if [ "$n" = "50000" ]; then k=4000; else k=500; fi
  (cd "$REPO" && $RUN "$HERE/scale-crash.mjs" \
    --fixture "$ROOT/scale-$n" --kill-after "$k" --work "$ROOT/work-crash") \
    > "$RESULTS/$n-crash.json"
done

echo "[rollback] old-binary read shapes, shipped vs variant E"
(cd "$REPO" && $RUN "$HERE/scale-rollback.mjs" \
  --fixture "$ROOT/scale-10000" --work "$ROOT/work-rollback") \
  > "$RESULTS/10000-rollback.json"

echo "[boot-control] a boot with the migration removed"
for n in $MAGNITUDES; do
  (cd "$REPO" && $RUN "$HERE/scale-boot-control.mjs" \
    --fixture "$ROOT/scale-$n" --work "$ROOT/work-control") \
    > "$RESULTS/$n-boot-control.json"
done
