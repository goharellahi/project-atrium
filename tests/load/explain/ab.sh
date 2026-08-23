#!/usr/bin/env sh
# Warm A/B: run the plan script three times and keep the third.
#
# The first pass of any capture is measuring the buffer cache, not the index.
# Comparing one cold run against one warm run makes every index look like a
# triumph. Three passes, keep the last, and read `Buffers:` as the primary
# signal — wall-clock milliseconds on a laptop under Docker Desktop are noisy in
# a way shared-buffer counts are not.
set -e
OUT="$1"
for i in 1 2 3; do
  sh tests/load/explain/capture.sh "$OUT" >/dev/null
done
echo "wrote $OUT (third of three warm passes)"
