#!/usr/bin/env sh
# Capture the query plans into an artifact.
#
# The `sed` is cosmetic and is the only post-processing applied: `freeRoomIds`
# passes a literal array of up to 2,000 room ids, and printing 230 UUIDs on one
# line makes the plan unreadable without changing it. The list is collapsed to
# its length. Nothing else is filtered.
set -e
OUT="${1:-tests/load/artifacts/explain-before.txt}"
docker exec -i atrium-postgres-1 psql -U atrium -d atrium -X -f - \
  < tests/load/explain/plans.sql \
  | sed -E 's/\{[0-9a-f-]{36}(,[0-9a-f-]{36}){4,}\}/{… candidate room ids elided …}/g' \
  > "$OUT"
echo "wrote $OUT"
